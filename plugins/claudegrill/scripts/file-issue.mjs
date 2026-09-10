#!/usr/bin/env node
/**
 * file-issue.mjs — the one way a QA finding becomes a tracked issue.
 *
 * ThemeGrill tracks work in GitHub Issues. Everything that used to reach for
 * the Atlassian MCP goes through here instead, for three reasons that are worth
 * stating because they are the whole argument for this file existing:
 *
 *   1. **No extra credential.** A sweep runs in the product repo's own Actions
 *      context, so `GITHUB_TOKEN` plus `permissions: issues: write` is enough.
 *      The Jira path needed an org-wide Rovo token with write access to
 *      everything, handed to an unattended agent.
 *   2. **The caps become real.** "Maximum five tickets per sweep" was a sentence
 *      in a prompt, which is to say it was a hope. Here it is arithmetic: every
 *      issue carries a `qa-run:<id>` label, and `create` counts them before it
 *      opens another.
 *   3. **Dedup becomes machine-checkable.** The finding's fingerprint is written
 *      into the issue body as an HTML comment, so `search` finds the earlier
 *      issue by identity rather than by hoping two agents phrased a title the
 *      same way.
 *
 * Deterministic by design (CLAUDE.md invariant 1): choosing WHICH findings are
 * worth filing is judgement and stays in the skill; searching, labelling,
 * capping and creating are mechanical and live here.
 *
 * Usage:
 *   node file-issue.mjs repo   [--product-root DIR]
 *   node file-issue.mjs search --fingerprint HEX | --query TEXT [--state all]
 *   node file-issue.mjs view   <number>
 *   node file-issue.mjs create --title T --body-file F [--severity S]
 *                              [--area A] [--fingerprint HEX] [--run-id ID]
 *                              [--max N] [--label L]... --confirm
 *   node file-issue.mjs comment <number> --body-file F --confirm
 *   node file-issue.mjs ensure-labels --confirm
 *
 * Every subcommand accepts --repo OWNER/NAME to override discovery, and --json
 * for one line of JSON on stdout and nothing on stderr.
 *
 * Exit codes, matching run-suite.mjs: 0 ok · 1 refused (cap hit, duplicate,
 * missing --confirm) · 2 harness broken (no gh, no auth, no repo).
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// ------------------------------------------------------------------ arguments

const argv = process.argv.slice(2);
const cmd = argv[0] && !argv[0].startsWith("-") ? argv.shift() : "";
const positional = [];
const flags = {};
const repeated = { label: [] };

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith("--")) {
    positional.push(a);
    continue;
  }
  const key = a.slice(2);
  if (key === "confirm" || key === "json" || key === "allow-duplicate") {
    flags[key] = true;
    continue;
  }
  const value = argv[++i];
  if (key === "label") repeated.label.push(value);
  else flags[key] = value;
}

const asJson = flags.json === true;

/** Human-facing chatter. Silent under --json so the stdout contract holds. */
function say(msg) {
  if (!asJson) process.stderr.write(`${msg}\n`);
}

/**
 * The only exit path. `code` follows run-suite.mjs so a caller can branch on it
 * without parsing anything: 1 means "we understood and declined", 2 means "the
 * tooling is not usable". Conflating those is how a missing `gh` gets reported
 * as a clean run with no findings.
 */
function finish(code, payload) {
  if (asJson) process.stdout.write(`${JSON.stringify(payload)}\n`);
  else if (payload.error) process.stderr.write(`\n✘ ${payload.error}\n`);
  process.exit(code);
}

// ------------------------------------------------------------------- gh shell

/**
 * `gh` is spawned without a shell on every platform — it is `gh.exe` on PATH
 * under Windows, so no shell is needed and using one would mean quoting rules
 * differ per platform for no gain. Bodies go in over stdin, never argv, for the
 * same reason sync-secrets.mjs does it: a long issue body would blow the
 * command-line limit and a body containing a backtick would be a shell bug.
 */
function gh(args, input) {
  return spawnSync("gh", args, {
    input,
    encoding: "utf8",
    windowsHide: true,
  });
}

function requireGh() {
  const v = gh(["--version"]);
  if (v.error || v.status !== 0) {
    finish(2, {
      ok: false,
      error:
        "the GitHub CLI (`gh`) is not installed or not on PATH.\n" +
        "  macOS: brew install gh    Windows: winget install GitHub.cli\n" +
        "  then: gh auth login",
    });
  }
  const auth = gh(["auth", "status"]);
  if (auth.status !== 0) {
    finish(2, {
      ok: false,
      error:
        "`gh` is installed but not authenticated. Run: gh auth login\n" +
        "  In CI, set GH_TOKEN to a token with `issues: write` on the target repo.",
    });
  }
}

// -------------------------------------------------------------- target repo

/**
 * Where issues go, most specific first:
 *
 *   1. --repo
 *   2. `issue_repo` in the product's own .themegrill-qa/suite.json
 *   3. GITHUB_REPOSITORY — set by Actions, and in a sweep that IS the product
 *      repo, because the reusable workflow runs in the caller's context
 *   4. the product checkout's own `origin`
 *
 * The default is the product's repo rather than a central tracker, because a
 * bug in ColorMag belongs beside ColorMag's code: the issue, the fix, the spec
 * and the changelog entry all end up in one place, which is the same reasoning
 * that puts knowledge.md in the product repo (invariant 6).
 */
function resolveRepo() {
  if (flags.repo) return { repo: flags.repo, source: "--repo" };

  const root = path.resolve(flags["product-root"] ?? process.cwd());
  const manifest = path.join(root, ".themegrill-qa", "suite.json");
  if (fs.existsSync(manifest)) {
    try {
      const m = JSON.parse(fs.readFileSync(manifest, "utf8").replace(/\r/g, ""));
      if (m.issue_repo) return { repo: m.issue_repo, source: "suite.json" };
    } catch {
      /* a malformed manifest is reported by suite-manifest.mjs, not here */
    }
  }

  if (process.env.GITHUB_REPOSITORY)
    return { repo: process.env.GITHUB_REPOSITORY, source: "GITHUB_REPOSITORY" };

  const view = gh(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], undefined);
  if (view.status === 0 && view.stdout.trim())
    return { repo: view.stdout.trim(), source: "git remote" };

  finish(2, {
    ok: false,
    error:
      "could not work out which repository to file into.\n" +
      "  Pass --repo OWNER/NAME, or add \"issue_repo\" to .themegrill-qa/suite.json.",
  });
}

// ---------------------------------------------------------------- fingerprint

/** The marker that makes dedup identity-based rather than title-based. */
const fpMarker = (fp) => `<!-- tgqa-fingerprint: ${fp} -->`;

// --------------------------------------------------------------------- labels

/**
 * Severity maps to a label, because GitHub has no priority field. The names are
 * deliberately prefixed so they sort together and so a repo's own `bug`/`enhancement`
 * labels are never collided with.
 */
const SEVERITY_LABELS = {
  blocker: { name: "severity:blocker", color: "b60205", description: "Data loss, fatal, or the product is unusable" },
  major: { name: "severity:major", color: "d93f0b", description: "A documented behaviour is broken" },
  minor: { name: "severity:minor", color: "fbca04", description: "Works, but wrongly, with a workaround" },
  trivial: { name: "severity:trivial", color: "c2e0c6", description: "Cosmetic" },
};

const BASE_LABELS = [
  { name: "automated-qa", color: "1d76db", description: "Filed by claudegrill, not by a human" },
  { name: "needs-triage", color: "e99695", description: "Not yet accepted; a human decides scope and priority" },
];

/**
 * `gh issue create` FAILS outright on a label that does not exist, and it fails
 * at the very end of a sweep that has already spent its whole budget. So the
 * labels are created up front, and "already exists" is a success.
 */
function ensureLabels(repo, wanted) {
  const created = [];
  for (const l of wanted) {
    const res = gh([
      "label", "create", l.name,
      "--repo", repo,
      "--color", l.color,
      "--description", l.description,
    ]);
    if (res.status === 0) created.push(l.name);
    else if (!/already exists/i.test(`${res.stderr}`)) {
      say(`  ! could not create label ${l.name}: ${String(res.stderr).trim()}`);
    }
  }
  return created;
}

// ------------------------------------------------------------------- commands

function cmdRepo() {
  requireGh();
  const { repo, source } = resolveRepo();
  say(`Issues go to ${repo}  (${source})`);
  finish(0, { ok: true, repo, source });
}

function cmdSearch() {
  requireGh();
  const { repo } = resolveRepo();

  // A fingerprint search is exact: it looks for the marker this script wrote.
  // A text query is the fallback for a human-filed issue that has no marker,
  // and it is the weaker of the two — which is why the sweep's gate consults
  // the findings ledger FIRST and this second.
  const q = flags.fingerprint ? `${flags.fingerprint} in:body` : flags.query;
  if (!q) finish(2, { ok: false, error: "search needs --fingerprint HEX or --query TEXT" });

  const res = gh([
    "issue", "list",
    "--repo", repo,
    "--search", q,
    "--state", flags.state ?? "all",
    "--limit", String(flags.limit ?? 20),
    "--json", "number,title,state,url,labels,createdAt,closedAt",
  ]);

  if (res.status !== 0)
    finish(2, { ok: false, repo, error: `gh issue list failed: ${String(res.stderr).trim()}` });

  let issues = [];
  try {
    issues = JSON.parse(res.stdout || "[]");
  } catch {
    finish(2, { ok: false, repo, error: "gh returned output that is not JSON" });
  }

  if (!asJson) {
    if (!issues.length) say(`No existing issue matches ${q}`);
    for (const i of issues) say(`  #${i.number} [${i.state}] ${i.title}\n      ${i.url}`);
  }
  finish(0, { ok: true, repo, query: q, count: issues.length, issues });
}

function cmdView() {
  requireGh();
  const { repo } = resolveRepo();
  const number = positional[0];
  if (!number) finish(2, { ok: false, error: "view needs an issue number" });

  const res = gh([
    "issue", "view", String(number).replace(/^#/, ""),
    "--repo", repo,
    "--json", "number,title,state,body,labels,url,comments,createdAt",
  ]);
  if (res.status !== 0)
    finish(2, { ok: false, repo, error: `gh issue view failed: ${String(res.stderr).trim()}` });

  const issue = JSON.parse(res.stdout);
  if (!asJson) {
    say(`#${issue.number} [${issue.state}] ${issue.title}\n${issue.url}\n`);
    process.stdout.write(`${issue.body}\n`);
  }
  finish(0, { ok: true, repo, issue });
}

function cmdCreate() {
  requireGh();
  const { repo } = resolveRepo();

  const title = flags.title;
  const bodyFile = flags["body-file"];
  if (!title) finish(2, { ok: false, error: "create needs --title" });
  if (!bodyFile || !fs.existsSync(bodyFile))
    finish(2, { ok: false, error: "create needs --body-file pointing at an existing file" });

  let body = fs.readFileSync(bodyFile, "utf8");

  const severity = String(flags.severity ?? "").toLowerCase();
  if (severity && !SEVERITY_LABELS[severity])
    finish(2, {
      ok: false,
      error: `unknown severity "${severity}" — use one of: ${Object.keys(SEVERITY_LABELS).join(", ")}`,
    });

  const runId = flags["run-id"] ?? process.env.GITHUB_RUN_ID ?? "";
  const max = Number(flags.max ?? 5);

  const labels = [
    ...BASE_LABELS.map((l) => l.name),
    ...(severity ? [SEVERITY_LABELS[severity].name] : []),
    ...(flags.area ? [`area:${flags.area}`] : []),
    ...(runId ? [`qa-run:${runId}`] : []),
    ...repeated.label,
  ];

  // --- the duplicate gate ---------------------------------------------------
  // Checked here rather than trusted to the caller, because "never file a
  // duplicate" as a prompt instruction is exactly the rule an agent breaks on
  // its thirtieth tool call.
  if (flags.fingerprint) {
    body = `${body.trimEnd()}\n\n${fpMarker(flags.fingerprint)}\n`;
    const dupe = gh([
      "issue", "list", "--repo", repo,
      "--search", `${flags.fingerprint} in:body`,
      "--state", "all", "--limit", "5",
      "--json", "number,title,state,url",
    ]);
    if (dupe.status === 0) {
      const found = JSON.parse(dupe.stdout || "[]");
      if (found.length && !flags["allow-duplicate"]) {
        say(`Already filed as #${found[0].number} (${found[0].state}) — commenting is the right move, not a second issue.`);
        finish(1, { ok: false, repo, reason: "duplicate", duplicate_of: found[0], issues: found });
      }
    }
  }

  // --- the cap --------------------------------------------------------------
  // Real arithmetic rather than a prompt's promise. Without a run id there is
  // nothing to count against, so the cap cannot be enforced and says so.
  let openedThisRun = null;
  if (runId) {
    const mine = gh([
      "issue", "list", "--repo", repo,
      "--label", `qa-run:${runId}`,
      "--state", "all", "--limit", "100",
      "--json", "number",
    ]);
    if (mine.status === 0) {
      openedThisRun = JSON.parse(mine.stdout || "[]").length;
      if (openedThisRun >= max) {
        say(`Cap reached: ${openedThisRun} issue(s) already filed for run ${runId}, limit ${max}.`);
        finish(1, {
          ok: false, repo, reason: "cap_reached",
          opened_this_run: openedThisRun, max,
        });
      }
    }
  }

  if (!flags.confirm) {
    say(
      `Would file into ${repo}:\n` +
        `  ${title}\n  labels: ${labels.join(", ")}\n\n` +
        `Nothing was created. Re-run with --confirm.`,
    );
    finish(1, { ok: false, repo, reason: "not_confirmed", title, labels, dry_run: true });
  }

  ensureLabels(repo, [
    ...BASE_LABELS,
    ...(severity ? [SEVERITY_LABELS[severity]] : []),
    ...(flags.area ? [{ name: `area:${flags.area}`, color: "0e8a16", description: `Product area: ${flags.area}` }] : []),
    ...(runId ? [{ name: `qa-run:${runId}`, color: "ededed", description: "Filed by one claudegrill run" }] : []),
    ...repeated.label.map((n) => ({ name: n, color: "ededed", description: "" })),
  ]);

  const args = ["issue", "create", "--repo", repo, "--title", title, "--body-file", "-"];
  for (const l of labels) args.push("--label", l);

  const res = gh(args, body);
  if (res.status !== 0)
    finish(2, { ok: false, repo, error: `gh issue create failed: ${String(res.stderr).trim()}` });

  // gh prints the new issue's URL and nothing else.
  const url = String(res.stdout).trim().split("\n").pop().trim();
  const number = Number((url.match(/\/issues\/(\d+)/) ?? [])[1] ?? 0) || null;

  say(`Filed #${number} — ${url}`);
  finish(0, {
    ok: true, repo, number, url, title, labels,
    opened_this_run: openedThisRun === null ? null : openedThisRun + 1,
  });
}

function cmdComment() {
  requireGh();
  const { repo } = resolveRepo();
  const number = String(positional[0] ?? "").replace(/^#/, "");
  const bodyFile = flags["body-file"];
  if (!number) finish(2, { ok: false, error: "comment needs an issue number" });
  if (!bodyFile || !fs.existsSync(bodyFile))
    finish(2, { ok: false, error: "comment needs --body-file pointing at an existing file" });

  if (!flags.confirm) {
    say(`Would comment on ${repo}#${number}. Nothing was posted. Re-run with --confirm.`);
    finish(1, { ok: false, repo, number: Number(number), reason: "not_confirmed", dry_run: true });
  }

  const res = gh(
    ["issue", "comment", number, "--repo", repo, "--body-file", "-"],
    fs.readFileSync(bodyFile, "utf8"),
  );
  if (res.status !== 0)
    finish(2, { ok: false, repo, error: `gh issue comment failed: ${String(res.stderr).trim()}` });

  const url = String(res.stdout).trim().split("\n").pop().trim();
  say(`Commented on #${number} — ${url}`);
  finish(0, { ok: true, repo, number: Number(number), url });
}

function cmdEnsureLabels() {
  requireGh();
  const { repo } = resolveRepo();
  if (!flags.confirm) {
    say(`Would create the QA labels in ${repo}. Re-run with --confirm.`);
    finish(1, { ok: false, repo, reason: "not_confirmed", dry_run: true });
  }
  const created = ensureLabels(repo, [...BASE_LABELS, ...Object.values(SEVERITY_LABELS)]);
  say(`Labels ready in ${repo}${created.length ? ` (created: ${created.join(", ")})` : ""}`);
  finish(0, { ok: true, repo, created });
}

// ---------------------------------------------------------------------- route

switch (cmd) {
  case "repo": cmdRepo(); break;
  case "search": cmdSearch(); break;
  case "view": cmdView(); break;
  case "create": cmdCreate(); break;
  case "comment": cmdComment(); break;
  case "ensure-labels": cmdEnsureLabels(); break;
  default:
    process.stderr.write(
      "file-issue.mjs — file QA findings as GitHub issues\n\n" +
        "  repo                                    which repo issues go to, and why\n" +
        "  search --fingerprint HEX | --query TEXT  has this been filed already?\n" +
        "  view <number>                           read an issue (steps, expected)\n" +
        "  create --title T --body-file F --confirm\n" +
        "         [--severity blocker|major|minor|trivial] [--area A]\n" +
        "         [--fingerprint HEX] [--run-id ID] [--max N] [--label L]\n" +
        "  comment <number> --body-file F --confirm\n" +
        "  ensure-labels --confirm\n\n" +
        "  --repo OWNER/NAME   override discovery       --json   one line of JSON\n",
    );
    process.exit(2);
}
