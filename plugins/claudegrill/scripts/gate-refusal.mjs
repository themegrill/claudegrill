#!/usr/bin/env node
/**
 * Does a refused pull request stand, or has a human waived the refusal?
 *
 * The two gates in suite.yml and pro-suite.yml — "no regression spec" and "a
 * changed spec cannot be selected" — refuse a PR before anything is booted. Some
 * PRs cannot have the spec the gate asks for: a Stripe or PayPal webhook, a cron
 * handler, a subscription row with no order are not things the harness can drive.
 * Reviewers were already waiving those by comment, which is an escape valve with
 * no mechanism behind it: nobody could tell who agreed, or whether they had the
 * standing to. This is the mechanism.
 *
 * A refusal is waived when the PR carries the `qa-waived` label AND the person
 * who applied it is a member of the repository's organisation. GitHub already
 * limits who may label a PR; this adds who may waive a gate, and records who.
 *
 * Deterministic, so a script and not a skill (invariant 1). One JSON line on
 * stdout and nothing else; exit 0 whatever the answer, 2 for a usage error. It
 * never throws a refusal through: a question it cannot answer is "not waived",
 * with the reason, because the safe reading of "could not check who applied
 * this" is that the gate stands.
 *
 * Usage
 *   node scripts/gate-refusal.mjs --repo org/name --pr 123 --tripped spec,select
 *
 * `--tripped` is the comma-separated list of gates that fired; empty means none
 * did and there is nothing to decide. `GH_BIN` replaces `gh`, so the checks below
 * can be exercised against a stub without a network.
 */

import { execFileSync } from "node:child_process";
import process from "node:process";

const opt = { repo: "", pr: "", tripped: [], label: "qa-waived" };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--repo") opt.repo = argv[++i] ?? "";
  else if (a === "--pr") opt.pr = argv[++i] ?? "";
  else if (a === "--tripped") {
    opt.tripped = (argv[++i] ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  } else if (a === "--label") opt.label = argv[++i] ?? "";
  else {
    console.error(`unknown flag: ${a}`);
    process.exit(2);
  }
}
if (!/^[^/\s]+\/[^/\s]+$/.test(opt.repo) || !/^\d+$/.test(opt.pr) || !opt.label) {
  console.error("usage: gate-refusal.mjs --repo org/name --pr <number> --tripped a,b [--label name]");
  process.exit(2);
}

const GH = process.env.GH_BIN || "gh";
const [owner] = opt.repo.split("/");

/** Run gh and return stdout, or null on any failure — a failure is never an answer. */
function gh(args) {
  try {
    return execFileSync(GH, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return null;
  }
}

function emit(payload) {
  process.stdout.write(JSON.stringify({ tripped: opt.tripped, label: opt.label, ...payload }) + "\n");
  process.exit(0);
}

if (opt.tripped.length === 0) emit({ refused: false, waived: false, actor: null, reason: "no gate fired" });

const stands = (reason, actor = null) => emit({ refused: true, waived: false, actor, reason });

// Is the label on the PR right now? Events alone are not enough: a label that
// was applied and later removed still has a `labeled` event.
const labels = gh(["api", `repos/${opt.repo}/issues/${opt.pr}/labels`, "--paginate", "--jq", ".[].name"]);
if (labels === null) stands("could not read the PR's labels");
if (!labels.split("\n").includes(opt.label)) stands(`no \`${opt.label}\` label on this PR`);

// Who applied it. The most recent `labeled` event for this label: if it was
// removed and put back, the person who put it back is the one waiving.
const applied = gh([
  "api",
  `repos/${opt.repo}/issues/${opt.pr}/events`,
  "--paginate",
  "--jq",
  `.[] | select(.event == "labeled" and .label.name == "${opt.label}") | .actor.login`,
]);
const actor = applied ? applied.split("\n").filter(Boolean).pop() : null;
if (!actor) stands(`\`${opt.label}\` is on this PR but who applied it could not be determined`);

// Automation does not get to waive a gate meant for people.
if (actor.endsWith("[bot]")) stands(`\`${opt.label}\` was applied by a bot (@${actor})`, actor);

// A member of the organisation. 204 means yes, anything else is not an answer.
if (gh(["api", `orgs/${owner}/members/${actor}`, "--silent"]) !== null) {
  emit({ refused: false, waived: true, actor, via: "organisation member", reason: `waived by @${actor}` });
}

// The membership endpoint cannot see a private member through every kind of
// token. GitHub only lets someone with triage access label a PR at all, so write
// access on this repo is the same standing, read from an endpoint that does work.
const permission = gh(["api", `repos/${opt.repo}/collaborators/${actor}/permission`, "--jq", ".permission"]);
if (["admin", "maintain", "write"].includes(permission ?? "")) {
  emit({ refused: false, waived: true, actor, via: `repository ${permission} access`, reason: `waived by @${actor}` });
}

stands(`\`${opt.label}\` was applied by @${actor}, who is not a member of ${owner}`, actor);
