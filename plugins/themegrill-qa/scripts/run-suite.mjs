#!/usr/bin/env node
/**
 * Run a product's own Playwright suite, and report the result as JSON.
 *
 * This is the cheap layer — the thing that runs before any token is spent. Every
 * finding it reproduces is a finding no agent has to rediscover, and the whole
 * economic case for this platform is that the set of such findings only grows.
 *
 * Deterministic, so it is a script and not a skill (invariant 1). It starts no
 * WordPress of its own: `--boot` delegates to `boot-wp.mjs`, which remains the
 * only route to an environment (invariant 3).
 *
 * Contract: SUITE.md §§1, 4, 5.
 *
 * Usage
 *   node scripts/run-suite.mjs --tier fresh --base-url http://127.0.0.1:9400
 *   node scripts/run-suite.mjs --tier fresh --boot playground --install
 *   node scripts/run-suite.mjs --tier all --area header
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { resolveQaHome } from "./lib/qa-home.mjs";
import { isWindows, killTree, shellQuote } from "./lib/platform.mjs";
import { parseSpecFile } from "./lib/spec-parse.mjs";
import { detectProduct, loadManifest } from "./lib/suite-manifest.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const qaHome = resolveQaHome(here);

// ------------------------------------------------------------------ arguments

const opt = {
  tier: "fresh",
  area: null, // null | string[]
  baseUrl: null,
  boot: null, // null | "playground" | "wp-env"
  install: false,
  grep: null,
  json: !process.stdout.isTTY,
  timeoutMs: 0, // 0 = no ceiling
};

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--tier") opt.tier = argv[++i];
  else if (a === "--area") {
    // Comma-separated: `--area header,global`. A diff rarely touches exactly
    // one area, and running one area per invocation would boot and tear down
    // the runner N times for no reason.
    opt.area = (opt.area ?? []).concat(
      argv[++i].split(",").map((x) => x.trim()).filter(Boolean),
    );
  }
  else if (a === "--base-url") opt.baseUrl = argv[++i];
  else if (a === "--boot") {
    // Optional value: `--boot` alone means playground.
    const next = argv[i + 1];
    opt.boot = next && !next.startsWith("--") ? argv[++i] : "playground";
  } else if (a === "--install") opt.install = true;
  else if (a === "--grep") opt.grep = argv[++i];
  else if (a === "--json" || a === "--quiet") opt.json = true;
  else if (a === "--timeout-ms") opt.timeoutMs = Number(argv[++i]);
  else {
    console.error(`unknown flag: ${a}`);
    process.exit(2);
  }
}

if (!["fresh", "demo", "all"].includes(opt.tier)) {
  console.error(`--tier must be fresh, demo or all (got: ${opt.tier})`);
  process.exit(2);
}

// -------------------------------------------------------------------- output

/**
 * Where the runner's own chatter goes when `--json` is in force.
 *
 * This matters for cost, not tidiness. When an agent invokes this script, every
 * line the runner prints is a line the agent reads into its context and pays
 * for — Playwright's per-test progress alone is ~20 lines on ColorMag. Under
 * `--json` all of it goes to this file instead, and the agent sees exactly one
 * line of JSON. The path is reported in that JSON so a human can still read it.
 */
const logFile = path.join(os.tmpdir(), "themegrill-qa-suite.log");

/**
 * Progress for humans. Never stdout: stdout carries exactly one JSON line.
 * Silent under `--json`, which is the default when stdout is not a TTY — so a
 * script or an agent capturing stdout gets the payload and nothing else.
 */
const say = (msg) => {
  if (opt.json) return;
  console.error(msg);
};

/** The single line of stdout, and the exit. */
function emit(payload, code) {
  process.stdout.write(JSON.stringify(payload) + "\n");
  process.exit(code);
}

/** Exit 2 — the harness could not run, which is not the same as tests failing. */
function cannotRun(reason, extra = {}) {
  say(`cannot run: ${reason}`);
  emit({ ok: false, suite: true, reason, ...extra }, 2);
}

// ---------------------------------------------------------------- the product

const detected = detectProduct(qaHome);
if (!detected.ok) {
  say(detected.detail ?? "");
  emit({ ok: false, suite: false, reason: detected.reason }, 2);
}
const info = detected.info;
const root = info.root;

const loaded = loadManifest(root);

// No suite is a valid state, not an error. Everything downstream of this script
// degrades to the platform's previous behaviour when it sees `suite: false`.
if (!loaded.present) {
  emit({ ok: true, suite: false, reason: "no suite manifest" }, 0);
}
if (loaded.error) cannotRun(loaded.error);

const m = loaded.manifest;
for (const line of loaded.inferred) say(`inferred  ${line}`);

if (m.runner !== "playwright") {
  cannotRun(`unsupported runner: ${m.runner} (only "playwright" is implemented)`);
}

// ------------------------------------------------------------------ base URL

/**
 * Where the suite points, in the precedence the contract states.
 *
 * `--boot` is last of the three that can succeed because booting is the only one
 * that costs anything: if a site is already running and named, use it.
 */
let booted = null; // truthy once we own a site we must tear down
let envLabel = "local";
let baseUrl = null;

function bootSite(engine) {
  say(`booting a disposable site (${engine}) …`);
  const res = spawnSync(
    process.execPath,
    [path.join(qaHome, "scripts", "boot-wp.mjs"), "--engine", engine],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );

  if (res.status !== 0) {
    return { ok: false, reason: `boot-wp.mjs exited ${res.status}` };
  }
  // boot-wp prints its JSON handoff as the last line of stdout.
  const line = String(res.stdout ?? "")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .pop();
  try {
    const handoff = JSON.parse(line);
    return { ok: true, handoff };
  } catch {
    return { ok: false, reason: "boot-wp.mjs produced no JSON handoff" };
  }
}

function teardown() {
  if (!booted) return;
  say("tearing down the booted site …");
  spawnSync(
    process.execPath,
    [path.join(qaHome, "scripts", "boot-wp.mjs"), "--stop"],
    { cwd: root, stdio: ["ignore", "ignore", "inherit"] },
  );
  booted = null;
}

/**
 * Read `.themegrill-qa/.env.local` — the developer's own site, uncommitted.
 *
 * This is how a developer points the suite at the site they are actually fixing
 * ColorMag on, without anyone writing a URL or a password into a tracked file
 * (SUITE.md §4). Gitignored by convention; `KEY=value`, `#` comments, optional
 * quotes. Values already present in the real environment win, so an explicit
 * `TGQA_BASE_URL=... node run-suite.mjs` still overrides the file.
 */
function loadEnvLocal(productRoot) {
  const file = path.join(productRoot, ".themegrill-qa", ".env.local");
  if (!fs.existsSync(file)) return {};

  const out = {};
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const envLocal = loadEnvLocal(root);

/**
 * Which site to run against, in strict precedence.
 *
 * The developer's existing site comes BEFORE booting a fresh one, deliberately:
 * booting is the slow, fragile, network-dependent step, and a developer fixing
 * ColorMag already has the site the bug lives on. Playground is the fallback for
 * when nothing else is available, not the default.
 *
 * The cost of that ordering is that the suite then runs against a site with real
 * content and real settings, so a spec that mutates site-wide state must restore
 * it in a fixture teardown — which CONVENTIONS.md already requires, and which
 * ColorMag's suite already does.
 */
const envLocalUrl =
  envLocal.TGQA_BASE_URL ?? (m.env.base_url ? envLocal[m.env.base_url] : null);

if (opt.baseUrl) {
  baseUrl = opt.baseUrl;
} else if (process.env.TGQA_BASE_URL) {
  baseUrl = process.env.TGQA_BASE_URL;
} else if (envLocalUrl) {
  baseUrl = envLocalUrl;
  say(`base URL from .themegrill-qa/.env.local`);
} else if (opt.boot) {
  const b = bootSite(opt.boot);
  if (!b.ok) cannotRun(b.reason);
  baseUrl = b.handoff.url;
  envLabel = b.handoff.engine ?? opt.boot;
  booted = true;
} else {
  cannotRun(
    "no base URL. Pass --base-url <url>, set TGQA_BASE_URL, write one into " +
      ".themegrill-qa/.env.local, or pass --boot [playground|wp-env]",
  );
}

if (opt.baseUrl || process.env.TGQA_BASE_URL || envLocalUrl) {
  envLabel = process.env.TGQA_ENV ?? envLocal.TGQA_ENV ?? "local";
}

// Tear the site down however we leave, including on Ctrl-C.
process.on("exit", teardown);
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    teardown();
    process.exit(130);
  });
}

// ------------------------------------------------------------------- install

/**
 * Split a manifest command into argv without invoking a shell.
 *
 * Not shell-parsed on purpose: a shell would have to be quoted for on POSIX and
 * for `cmd.exe` on Windows, with different rules, and the grep patterns this
 * script builds contain characters both shells give meaning to. Manifest
 * commands are short fixed strings (`pnpm exec playwright test`), so a
 * whitespace split is both sufficient and predictable.
 */
function argvOf(command) {
  return command.trim().split(/\s+/);
}

/**
 * Where a child process's output goes: a log file under `--json`, our own
 * stderr otherwise. Opened lazily and reused, so both streams share one fd and
 * the ordering between them survives.
 */
let logFd = null;
function sink() {
  if (!opt.json) return process.stderr;
  if (logFd === null) {
    try {
      logFd = fs.openSync(logFile, "w");
    } catch {
      logFd = "ignore"; // cannot open the log? then discard, never our stdout
    }
  }
  return logFd;
}

/** Run a command in the product root, inheriting stdio. */
function runInProduct(command, extraArgs = [], env = process.env, timeoutMs = 0) {
  const parts = argvOf(command);
  const all = [...parts.slice(1), ...extraArgs];

  return new Promise((resolve) => {
    const child = spawn(
      isWindows ? shellQuote(cmdName(parts[0])) : parts[0],
      isWindows ? all.map(shellQuote) : all,
      {
        cwd: root,
        env,
        // Both of the child's streams go to OUR stderr, never to our stdout.
        // The runner's stdout is progress, not data — the JSON report goes to a
        // file — and `"inherit"` here would hand the child our stdout and break
        // the one-JSON-line contract. Confirmed against the fixture, where
        // Playwright's list reporter landed in the middle of the payload.
        //
        // Under `--json` it goes to a log file instead of our stderr, so an
        // agent invoking this pays for one line of JSON rather than for every
        // line Playwright prints.
        stdio: ["ignore", sink(), sink()],
        shell: isWindows,
        detached: !isWindows, // own process group, so a timeout can kill the tree
        windowsHide: true,
      },
    );

    let timer = null;
    let timedOut = false;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        say(`timeout after ${timeoutMs}ms — killing the process tree`);
        killTree(child.pid);
      }, timeoutMs);
    }

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({ status: null, error: err, timedOut });
    });
    child.on("exit", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ status: code, timedOut });
    });
  });
}

/** `pnpm` is `pnpm.cmd` on Windows; same for npm, yarn, npx. */
function cmdName(bin) {
  if (!isWindows) return bin;
  return /\.(cmd|exe|bat)$/i.test(bin) ? bin : `${bin}.cmd`;
}

// --------------------------------------------------------------- environment

/**
 * Both names for every value: the generic `TGQA_*` the platform defines, and
 * whatever the product's existing suite already reads. Exporting both is what
 * lets a product join in without renaming a single variable (SUITE.md §4).
 *
 * Credentials come from the environment or from CI secrets. Nothing here writes
 * one to a tracked file, and nothing should.
 */
const adminUser =
  process.env.TGQA_ADMIN_USER ??
  envLocal.TGQA_ADMIN_USER ??
  (m.env.admin_user ? envLocal[m.env.admin_user] : null) ??
  "admin";
const adminPass =
  process.env.TGQA_ADMIN_PASS ??
  envLocal.TGQA_ADMIN_PASS ??
  (m.env.admin_pass ? envLocal[m.env.admin_pass] : null) ??
  "password";

const runEnv = {
  ...process.env,
  TGQA_BASE_URL: baseUrl,
  TGQA_ADMIN_USER: adminUser,
  TGQA_ADMIN_PASS: adminPass,
  TGQA_ENV: envLabel,
  TGQA_TIER: opt.tier,
};
if (m.env.base_url) runEnv[m.env.base_url] = baseUrl;
if (m.env.admin_user) runEnv[m.env.admin_user] = adminUser;
if (m.env.admin_pass) runEnv[m.env.admin_pass] = adminPass;

// ------------------------------------------------------------------- filters

/**
 * Build the tier and area filter.
 *
 * Two things were checked against a real Playwright (1.62.1) rather than
 * assumed, because getting either wrong silently runs the wrong set of tests:
 *
 *   1. `--grep` given twice does NOT and-together — the second occurrence wins.
 *      Confirmed: `--grep=@header --grep=@content` returned the three @content
 *      tests, not the empty intersection. So requiring two tags means one
 *      pattern with two lookaheads, which was confirmed to intersect correctly.
 *   2. `--grep-invert` is a separate flag and composes with `--grep`, which is
 *      what makes the demo tier expressible at all.
 *
 * The demo tier is `--grep-invert <fresh>` rather than `--grep <demo>` because
 * the contract treats an untagged test as demo. Grepping for `@demo` would run
 * only the tests someone remembered to tag, and silently skip exactly the tests
 * whose tier nobody established.
 */
function buildFilters() {
  const fresh = m.tiers.fresh;

  // Several areas are an OR: a diff touching the header and the customizer
  // wants both areas' specs, not their (empty) intersection.
  const areaTags = (opt.area ?? []).map((a) => (a.startsWith("@") ? a : `@${a}`));
  const areaAlt =
    areaTags.length === 0
      ? null
      : areaTags.length === 1
        ? escapeRe(areaTags[0])
        : `(?:${areaTags.map(escapeRe).join("|")})`;
  const args = [];

  if (opt.grep) {
    // Escape hatch: the caller's pattern replaces ours entirely rather than
    // fighting it, since two --grep flags would silently drop one of them.
    args.push(`--grep=${opt.grep}`);
    say(`--grep given: tier/area filtering is bypassed for this run`);
    return args;
  }

  if (opt.tier === "fresh") {
    args.push(
      areaAlt
        ? `--grep=(?=.*${escapeRe(fresh)})(?=.*${areaAlt})`
        : `--grep=${escapeRe(fresh)}`,
    );
  } else if (opt.tier === "demo") {
    args.push(`--grep-invert=${escapeRe(fresh)}`);
    if (areaAlt) args.push(`--grep=${areaAlt}`);
  } else if (areaAlt) {
    args.push(`--grep=${areaAlt}`);
  }

  return args;
}

/** Tags are literals in a regex context; `@` is safe but `.` and `-` need care. */
function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ------------------------------------------------------------------- the run

const specIndexByLocation = new Map();

/** Every spec file, parsed once, so failures can be annotated with area/guards. */
function indexSpecs() {
  const dir = path.join(root, m.spec_dir);
  if (!fs.existsSync(dir)) return;

  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name.startsWith(".")) continue;
        walk(p);
      } else if (/\.spec\.[cm]?[jt]sx?$/.test(e.name)) {
        const rel = path.relative(root, p).split(path.sep).join("/");
        let text;
        try {
          text = fs.readFileSync(p, "utf8");
        } catch {
          continue;
        }
        for (const t of parseSpecFile(text, rel, m.tiers)) {
          specIndexByLocation.set(`${rel}:${t.line}`, t);
          specIndexByLocation.set(`title:${t.title}`, t);
        }
      }
    }
  };
  walk(dir);
}

async function main() {
  if (opt.install) {
    if (!m.install) {
      say("--install given but the manifest declares no install command; skipping");
    } else {
      say(`installing: ${m.install}`);
      const r = await runInProduct(m.install, [], runEnv, opt.timeoutMs);
      if (r.error) cannotRun(`install failed to start: ${r.error.message}`);
      if (r.status !== 0) cannotRun(`install failed (exit ${r.status})`);
    }
  }

  indexSpecs();

  const reportPath = path.join(root, m.json_report);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  // A stale report from a previous run read as this run's result would be the
  // worst possible failure mode: a green verdict for tests that never executed.
  fs.rmSync(reportPath, { force: true });

  const args = [
    ...buildFilters(),
    // `--reporter=json` on the command line rather than in the config, because
    // the platform must never mutate a product's playwright.config.*.
    "--reporter=json",
  ];

  say(`running: ${m.command} ${args.join(" ")}`);
  say(`  base URL  ${baseUrl}`);
  say(`  tier      ${opt.tier}${opt.area?.length ? ` · areas ${opt.area.join(", ")}` : ""}`);

  const started = Date.now();
  const r = await runInProduct(
    m.command,
    args,
    // PLAYWRIGHT_JSON_OUTPUT_NAME is how the json reporter is pointed at a file
    // without touching the product's config.
    { ...runEnv, PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath },
    opt.timeoutMs,
  );
  const durationMs = Date.now() - started;

  if (r.error) {
    cannotRun(`could not start the runner: ${r.error.message}`, {
      runner: m.runner,
      base_url: baseUrl,
    });
  }
  if (r.timedOut) {
    cannotRun(`run exceeded --timeout-ms ${opt.timeoutMs}`, {
      runner: m.runner,
      base_url: baseUrl,
      duration_ms: durationMs,
    });
  }

  if (!fs.existsSync(reportPath)) {
    cannotRun(
      `the runner exited ${r.status} without writing ${m.json_report} — treat this as a broken harness, not as passing tests`,
      { runner: m.runner, base_url: baseUrl, duration_ms: durationMs },
    );
  }

  let report;
  try {
    report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  } catch (err) {
    cannotRun(`could not parse ${m.json_report}: ${err.message}`);
  }

  const result = summarise(report, durationMs);
  teardown();

  if (result.ran_nothing) {
    say(
      "the runner executed 0 tests — treating this as a broken harness, not a pass.\n" +
        "  Common causes: the grep matched nothing, the spec_dir is wrong, or the\n" +
        "  install left no runner. Check the log named in `log`.",
    );
    emit({ ...result, reason: "the runner executed 0 tests" }, 2);
  }

  emit(result, result.ok ? 0 : 1);
}

// ------------------------------------------------------------------ summary

/** Walk the nested suite tree and yield every spec with its file. */
function* eachSpec(node, file) {
  const f = node.file ?? file;
  for (const s of node.specs ?? []) yield { spec: s, file: s.file ?? f };
  for (const child of node.suites ?? []) yield* eachSpec(child, f);
}

function summarise(report, durationMs) {
  const failures = [];
  const fixme = [];
  let total = 0;
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let flaky = 0;

  for (const root_ of report.suites ?? []) {
    for (const { spec, file } of eachSpec(root_, root_.file)) {
      for (const t of spec.tests ?? []) {
        total++;

        const annotations = [
          ...(spec.annotations ?? []),
          ...(t.annotations ?? []),
        ].map((a) => a?.type);
        const isFixme = annotations.includes("fixme");

        const meta =
          specIndexByLocation.get(
            `${normaliseFile(file, report)}:${spec.line}`,
          ) ?? specIndexByLocation.get(`title:${spec.title}`);

        if (isFixme) {
          fixme.push({
            title: spec.title,
            file: normaliseFile(file, report),
            guards: meta?.guards ?? [],
            why: meta?.why ?? null,
          });
        }

        switch (t.status) {
          case "expected":
            passed++;
            break;
          case "flaky":
            flaky++;
            passed++; // it did pass, on retry — counted, and surfaced separately
            break;
          case "skipped":
            skipped++;
            break;
          case "unexpected":
          default: {
            failed++;
            const last = (t.results ?? [])[(t.results ?? []).length - 1] ?? {};
            const err =
              last.error?.message ??
              (last.errors ?? [])[0]?.message ??
              "no error message in the report";
            failures.push({
              title: spec.title,
              file: normaliseFile(file, report),
              line: spec.line ?? null,
              area: meta?.area ? meta.area.replace(/^@/, "") : null,
              guards: meta?.guards ?? [],
              error: stripAnsi(String(err)).slice(0, 400),
              // Repo-relative: an absolute path from the runner's machine is
              // meaningless in a PR comment read on someone else's.
              attachments: (last.attachments ?? [])
                .map((a) => a.path)
                .filter(Boolean)
                .map((p) => normaliseFile(p, report)),
              retries: Math.max(0, (t.results ?? []).length - 1),
            });
            break;
          }
        }
      }
    }
  }

  // Playwright's own stats are authoritative when present; the walk above is the
  // fallback for report shapes that omit them.
  const stats = report.stats ?? {};
  if (typeof stats.expected === "number") {
    passed = stats.expected + (stats.flaky ?? 0);
    failed = stats.unexpected ?? failed;
    skipped = stats.skipped ?? skipped;
    flaky = stats.flaky ?? flaky;
    total = passed + failed + skipped;
  }

  // A run that executed NOTHING is not a pass.
  //
  // `failed === 0` is trivially true when `total === 0`, and a required check
  // that goes green because the suite never ran is worse than no check at all.
  // Seen for real: a live CI run reported "0 passed · 0 failed · 0s" and a green
  // tick on a product with 20 @fresh specs. Zero tests is a broken harness —
  // exit 2 — not a pass.
  const ranNothing = total === 0;

  return {
    ok: failed === 0 && !ranNothing,
    ran_nothing: ranNothing,
    suite: true,
    runner: m.runner,
    tier: opt.tier,
    env: envLabel,
    base_url: baseUrl,
    duration_ms: typeof stats.duration === "number" ? Math.round(stats.duration) : durationMs,
    total,
    passed,
    failed,
    skipped,
    flaky,
    failures,
    fixme,
    // Where the runner's own output went, when it was not printed here.
    log: opt.json ? logFile : null,
  };
}

/** Report paths are relative to the config's rootDir; we want repo-relative. */
function normaliseFile(file, report) {
  if (!file) return null;
  if (!path.isAbsolute(file)) {
    const rootDir = report?.config?.rootDir;
    if (rootDir) {
      const abs = path.resolve(rootDir, file);
      return path.relative(root, abs).split(path.sep).join("/");
    }
    return file.split(path.sep).join("/");
  }
  return path.relative(root, file).split(path.sep).join("/");
}

/** Playwright colours its errors; the JSON carries the escape codes through. */
function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\[[0-9;]*m/g, "");
}

await main();
