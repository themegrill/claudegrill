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
 *   node scripts/run-suite.mjs --tier fresh --pro --boot   # @pro + free, licensed
 *   node scripts/run-suite.mjs --tier fresh --pro --pro-specs none --boot
 *                                            # free specs, in the pro environment
 *   node scripts/run-suite.mjs --tier fresh --full-results   # CI: report input
 */

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { resolveQaHome } from "./lib/qa-home.mjs";
import { isWindows, killTree, shellQuote } from "./lib/platform.mjs";
import { PRO_TAG, UNLICENSED_TAG, parseSpecFile } from "./lib/spec-parse.mjs";
import { loadRegistry } from "./lib/license/registry.mjs";
import { detectProduct, loadManifest } from "./lib/suite-manifest.mjs";
import { affectedAreas, areasGuarding, changedFiles } from "./lib/affected.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const qaHome = resolveQaHome(here);

// ------------------------------------------------------------------ arguments

const opt = {
  tier: "fresh",
  area: null, // null | string[]
  baseUrl: null,
  boot: null, // null | "playground" | "wp-env"
  pro: false,       // mount pro, licence it, and include @pro specs
  proSlug: null,    // which pro product; defaults to "<product>-pro"
  proSpecs: "both", // both | only | none — which specs run IN the pro environment
  probeUrl: null,   // how a licence is VERIFIED on a site we did not boot
  install: false,
  grep: null,
  json: !process.stdout.isTTY,
  timeoutMs: 0, // 0 = no ceiling
  since: null,  // git ref: narrow to the areas this diff could have broken
  // Evidence. A failure nobody can reproduce costs more than the run that found
  // it, so the default captures a trace — but only for the tests that failed.
  trace: "retain-on-failure", // Playwright --trace mode, or null to leave alone
  htmlReport: "playwright-report", // relative to the product root, or null
  fullResults: false, // list the passing tests too — see the flag below
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
  } else if (a === "--pro") {
    // Optional value: `--pro` alone means "<detected slug>-pro".
    opt.pro = true;
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) opt.proSlug = argv[++i];
  } else if (a === "--pro-specs") opt.proSpecs = argv[++i];
  else if (a === "--probe-url") opt.probeUrl = argv[++i];
  else if (a === "--install") opt.install = true;
  else if (a === "--grep") opt.grep = argv[++i];
  else if (a === "--json" || a === "--quiet") opt.json = true;
  else if (a === "--timeout-ms") opt.timeoutMs = Number(argv[++i]);
  else if (a === "--since") opt.since = argv[++i];
  else if (a === "--trace") opt.trace = argv[++i];
  else if (a === "--no-trace") opt.trace = null;
  else if (a === "--html-report") opt.htmlReport = argv[++i];
  else if (a === "--no-html-report") opt.htmlReport = null;
  // Every line of stdout is context an agent reads and pays for, which is the
  // whole reason `--json` exists. The passing tests are only worth their bytes
  // to a report a human will read, so CI asks for them and an agent does not.
  else if (a === "--full-results") opt.fullResults = true;
  else {
    console.error(`unknown flag: ${a}`);
    process.exit(2);
  }
}

if (!["both", "only", "none"].includes(opt.proSpecs)) {
  console.error(`--pro-specs must be both, only or none (got: ${opt.proSpecs})`);
  process.exit(2);
}

if (!["fresh", "demo", "all"].includes(opt.tier)) {
  console.error(`--tier must be fresh, demo or all (got: ${opt.tier})`);
  process.exit(2);
}

const TRACE_MODES = [
  "on", "off", "on-first-retry", "on-all-retries", "retain-on-failure",
  "retain-on-first-failure", "retain-on-failure-and-retries",
];
if (opt.trace !== null && !TRACE_MODES.includes(opt.trace)) {
  console.error(`--trace must be one of: ${TRACE_MODES.join(", ")} (got: ${opt.trace})`);
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
let bootHandoff = null;

// Which pro product `--pro` means. The convention across all four is
// "<free slug>-pro", and `--pro <slug>` overrides it for anything that stops
// following the convention.
const proSlug = opt.proSlug ?? `${info.slug}-pro`;

function bootSite(engine) {
  say(`booting a disposable site (${engine}) …`);
  const bootArgs = [path.join(qaHome, "scripts", "boot-wp.mjs"), "--engine", engine];
  if (opt.pro) bootArgs.push("--with-pro", proSlug, "--license");
  const res = spawnSync(
    process.execPath,
    bootArgs,
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
  bootHandoff = b.handoff;
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

/**
 * Put the probe on a site this run did not boot.
 *
 * The probe was never meant to be ceremony a developer performs. CI has always
 * had it for free — `boot-wp.mjs` stages the mu-plugin and prints `probe_url`
 * itself — and only the local existing-site path made anyone do it by hand.
 * That asymmetry, not the gate, is what made the pro tier expensive to adopt,
 * and it multiplied by four products.
 *
 * Everything needed is derivable: a developer works on a product from inside a
 * WordPress install, so `wp-content/mu-plugins` is an ancestor walk away, and
 * `pro_check` comes from the registry. Nothing is asked beyond the `.env.local`
 * the base URL already needs.
 *
 * Deliberately NOT the licence seeder. This site is licensed by hand already;
 * re-activating would spend one of the key's activation slots to learn
 * something the product can simply be asked.
 */
function installProbe(url, slug) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return { ok: false, reason: `could not parse the base URL (${url})` };
  }

  // Writing files into a server because a flag was passed is not a thing to do
  // to a remote host, however convenient it would be.
  const local =
    ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host) ||
    /\.(local|test|localhost)$/i.test(host);
  if (!local) {
    return { ok: false, reason: `${host} is not a local host, so the probe was not installed` };
  }

  const sitePath = process.env.TGQA_SITE_PATH ?? envLocal.TGQA_SITE_PATH ?? null;
  let muDir = null;
  if (sitePath) {
    muDir = path.join(sitePath, "wp-content", "mu-plugins");
  } else {
    // The product lives at <site>/wp-content/{themes,plugins}/<product>.
    for (let d = root; ; ) {
      if (path.basename(d) === "wp-content") {
        muDir = path.join(d, "mu-plugins");
        break;
      }
      const up = path.dirname(d);
      if (up === d) break;
      d = up;
    }
  }
  if (!muDir) {
    return {
      ok: false,
      reason:
        "could not find wp-content above the product — set TGQA_SITE_PATH in " +
        ".themegrill-qa/.env.local to the WordPress root",
    };
  }

  const entry = loadRegistry(qaHome)[slug];
  const token = crypto.randomBytes(16).toString("hex");
  const written = [];
  try {
    fs.mkdirSync(muDir, { recursive: true });

    const probeDest = path.join(muDir, "tgqa-probe.php");
    // Never clobber a file somebody else put here. If it is already the probe,
    // reusing it is correct; if it is something else, that is theirs.
    if (!fs.existsSync(probeDest)) {
      fs.copyFileSync(path.join(qaHome, "mu-plugins", "tgqa-probe.php"), probeDest);
      written.push(probeDest);
    }

    const tokenFile = path.join(muDir, "tgqa-probe.token");
    fs.writeFileSync(tokenFile, token, { mode: 0o600 });
    written.push(tokenFile);

    // The pro_check expression and nothing else: the licence STATE is the
    // product's to report, never ours to assert.
    if (entry?.pro_check) {
      const cfg = path.join(muDir, "tgqa-license.json");
      if (!fs.existsSync(cfg)) {
        fs.writeFileSync(cfg, JSON.stringify({ pro_check: entry.pro_check }, null, 2));
        written.push(cfg);
      }
    }
  } catch (err) {
    return { ok: false, reason: `could not write to ${muDir}: ${err.message}` };
  }

  // Whatever happens next — a pass, a failure, a `cannotRun` on the next line —
  // the developer's site goes back to how it was found.
  process.on("exit", () => {
    if (process.env.TGQA_KEEP_PROBE) return;
    for (const f of written) {
      try {
        fs.rmSync(f, { force: true });
      } catch {
        /* best effort: this is cleanup, not the job */
      }
    }
  });

  say(`probe installed into ${muDir}`);
  return { ok: true, url: `${url.replace(/\/$/, "")}/?tgqa_probe=${token}` };
}

/**
 * The pro gate. A `@pro` run either has a licence that resolved to VALID, or it
 * does not run.
 *
 * It does not skip quietly and it does not pass. A pro suite that silently
 * exercised the free code path is worse than no pro suite, because it reports
 * coverage that does not exist — and a green check that means nothing is the
 * exact failure this repo has already shipped once.
 *
 * Verification, in order, and never inferred:
 *   1. the probe on a site this run booted — the licence state the mu-plugin
 *      actually resolved inside WordPress;
 *   2. `--probe-url` / `TGQA_PROBE_URL` for a site somebody else booted.
 * With neither, the run stops. "I assume the site you pointed me at is
 * licensed" is not verification.
 *
 * Exit code 2, not 1: an unlicensed environment is a broken harness, not a
 * failing product. Sending a store outage to the product team wastes the wrong
 * people's day, which is why part 7 asks for `licence not active` as a distinct
 * non-retryable failure.
 */
async function verifyLicence() {
  if (!opt.pro) return null;

  let probeUrl = opt.probeUrl ?? process.env.TGQA_PROBE_URL ?? bootHandoff?.probe_url ?? null;

  let installReason = null;
  if (!probeUrl) {
    const installed = installProbe(baseUrl, proSlug);
    if (installed.ok) probeUrl = installed.url;
    else installReason = installed.reason;
  }

  if (!probeUrl) {
    cannotRun(
      "licence not active — pro features not under test. This run could not verify a " +
        `licence on a site it did not boot: ${installReason}. Either add --boot, or ` +
        "pass --probe-url (boot-wp.mjs prints it as `probe_url`).",
      { pro: true, licence: "unverifiable" },
    );
  }

  let probe = null;
  try {
    const res = await fetch(probeUrl, { redirect: "follow" });
    if (res.ok) probe = await res.json();
  } catch (err) {
    say(`probe request failed: ${err.message}`);
  }

  if (!probe) {
    cannotRun("licence not active — pro features not under test (the probe did not answer)", {
      pro: true,
      licence: "unverifiable",
    });
  }

  const state = probe.license?.state ?? "not attempted";
  const gate = probe.pro ?? {};

  // The PRODUCT's own gate is the authoritative answer, and it outranks our
  // bookkeeping. `tgqa_license_state` is only ever written by the seeder, so a
  // site a developer licensed by hand in wp-admin has none — while
  // can_use_premium_code() on that same site returns the truth. Demanding our
  // option would reject every already-licensed local site, which is precisely
  // the site someone verifying a pro fix is sitting on.
  //
  // This is not a relaxation of the gate: asking the product is a STRONGER
  // check than trusting a state file we wrote ourselves.
  const gateTrue = gate.checked === true && gate.active === true;

  // The other direction is the "silently tested the free version" case:
  // something claims licensed, the product disagrees. Always fatal.
  if (gate.checked === true && gate.active === false) {
    cannotRun(
      `licence not active — pro features not under test: the product's own gate ` +
        `(${gate.expression}) returned false (licence state: ${state}). Is the pro code mounted ` +
        `and the pro product active?`,
      { pro: true, licence: state, pro_gate: false },
    );
  }

  if (!gateTrue && state !== "valid") {
    cannotRun(
      `licence not active — pro features not under test (state: ${state}` +
        `${probe.license?.detail ? `; ${probe.license.detail}` : ""}` +
        `${gate.checked ? "" : `; pro gate unevaluated: ${gate.reason ?? "no reason given"}`})`,
      { pro: true, licence: state },
    );
  }

  if (!gate.checked) {
    // Not fatal — the registry may not carry a pro_check for this product yet —
    // but it must be visible in the report rather than absent from it.
    say(`note: could not evaluate the product's pro gate (${gate.reason ?? "no reason given"})`);
  }

  say(
    `licence verified: ${probe.license?.product ?? proSlug} — ` +
      (gateTrue
        ? `the product's own gate returns TRUE${state === "valid" ? "" : " (no seeded licence state; site licensed outside this run)"}`
        : `licence state ${state}, pro gate unevaluated`),
  );
  return { state, gate, environment_type: probe.environment_type };
}

const licence = await verifyLicence();

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
    say(`--grep given: tier/area/pro filtering is bypassed for this run`);
    return args;
  }

  // Requirements are lookaheads in ONE pattern; exclusions are alternatives in
  // ONE inverted pattern. Both are single flags because a second `--grep` (and,
  // by the same rule, a second `--grep-invert`) silently replaces the first
  // rather than combining with it — verified against Playwright 1.62.1.
  const require = [];
  const exclude = [];

  if (opt.tier === "fresh") require.push(escapeRe(fresh));
  else if (opt.tier === "demo") exclude.push(escapeRe(fresh));

  if (areaAlt) require.push(areaAlt);

  // The pro dimension, orthogonal to the tier.
  //
  //   --pro   run @pro specs AND untagged (free-behaviour) specs, in an
  //           environment where pro is installed and licensed. Running the free
  //           specs here is the point, not an accident: "installing pro breaks a
  //           free feature" is a real and expensive bug class, and the only way
  //           to catch it is to run the free suite in the pro environment.
  //   no flag exclude @pro entirely. Those specs need code that is not mounted;
  //           running them would fail for the wrong reason, and skipping them
  //           silently would hide that pro is untested.
  //
  // Inside a pro environment, `--pro-specs` picks which half of the matrix runs:
  //   both  @pro specs and free specs together — the local default
  //   only  @pro specs alone
  //   none  free specs alone, with pro installed and licensed. This is the
  //         "installing pro breaks a free feature" job, and it is a distinct CI
  //         job rather than a tier because its failure means something entirely
  //         different from a @pro failure.
  if (!opt.pro || opt.proSpecs === "none") exclude.push(escapeRe(PRO_TAG));
  else if (opt.proSpecs === "only") require.push(escapeRe(PRO_TAG));

  // `@unlicensed` is excluded from EVERY ordinary run, licensed or not, because
  // it needs a site this run does not have: pro code mounted with no licence.
  // On a licensed site those specs would skip; on a free site they would fail
  // for the wrong reason. Reaching them is deliberate, via `--grep @unlicensed`
  // against a site booted `--with-pro` and without `--license`.
  exclude.push(escapeRe(UNLICENSED_TAG));

  if (require.length) {
    args.push(
      require.length === 1 && !areaAlt && opt.tier === "fresh"
        ? `--grep=${require[0]}`
        : `--grep=${require.map((r) => `(?=.*${r})`).join("")}`,
    );
  }
  if (exclude.length) {
    args.push(
      `--grep-invert=${exclude.length === 1 ? exclude[0] : `(?:${exclude.join("|")})`}`,
    );
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

  // --since: narrow to the areas this diff could have broken.
  //
  // Safety rule, and the reason this can be trusted: any changed source file
  // that matches no `area_paths` pattern falls back to the FULL tier. Narrowing
  // on a diff nobody mapped is how a change ships with no coverage and a green
  // tick over it. Silence costs time here, never coverage.
  let scope = null;
  if (opt.since) {
    const specIndex = [...new Set(specIndexByLocation.values())];
    const changed = changedFiles(root, opt.since);

    if (!changed.ok) {
      say(`could not diff against ${opt.since} — running the full tier`);
      scope = { mode: "full", reason: `git diff against ${opt.since} failed` };
    } else {
      const a = affectedAreas(changed.files, m, specIndex);
      // A fix for CMAG-1234 always runs the spec guarding CMAG-1234, whatever
      // area it lives in. That is the single most important spec in the run.
      const guarding = areasGuarding(info.ticket, specIndex);
      const areas = [...new Set([...a.areas, ...guarding])];

      if (a.full) {
        say(`not narrowing: ${a.reason}`);
        scope = { mode: "full", reason: a.reason, changed_files: changed.files.length };
      } else if (areas.length === 0) {
        say(`nothing to run: ${a.reason}`);
        scope = { mode: "none", reason: a.reason, changed_files: changed.files.length };
      } else {
        opt.area = areas;
        say(`narrowed to ${areas.join(", ")} (${a.reason})`);
        scope = {
          mode: "changed",
          areas,
          guarding,
          reason: a.reason,
          changed_files: changed.files.length,
        };
      }
    }
  }

  // A diff that touches no product source has nothing to verify. Report it
  // plainly rather than running zero tests and calling that a pass.
  if (scope?.mode === "none") {
    teardown();
    emit(
      {
        ok: true, suite: true, runner: m.runner, tier: opt.tier, env: envLabel,
        pro: opt.pro, pro_product: opt.pro ? proSlug : null,
        base_url: baseUrl, scope, total: 0, passed: 0, failed: 0, skipped: 0,
        flaky: 0, failures: [], fixme: [], flaky_tests: [], passed_tests: null,
        reason: "no product source changed — nothing to run",
      },
      0,
    );
  }

  const reportPath = path.join(root, m.json_report);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  // A stale report from a previous run read as this run's result would be the
  // worst possible failure mode: a green verdict for tests that never executed.
  fs.rmSync(reportPath, { force: true });

  // Playwright refuses to run when the HTML report folder contains, or is
  // contained by, the tests' output folder — it would delete the attachments it
  // is about to link. Detect that here and drop the HTML report rather than
  // failing the whole run for a reporting nicety.
  let htmlDir = opt.htmlReport ? path.resolve(root, opt.htmlReport) : null;
  let htmlSkipped = null;
  if (htmlDir) {
    const outputDir = path.dirname(reportPath);
    if (contains(htmlDir, outputDir) || contains(outputDir, htmlDir)) {
      htmlSkipped =
        `${opt.htmlReport} overlaps the runner's output folder ` +
        `(${path.relative(root, outputDir).split(path.sep).join("/")}) — Playwright ` +
        `would clash, so no HTML report was written`;
      say(htmlSkipped);
      htmlDir = null;
    }
  }

  const args = [
    ...buildFilters(),
    // `--reporter` on the command line rather than in the config, because the
    // platform must never mutate a product's playwright.config.*. It takes a
    // comma list, so the machine-readable and human-readable reports coexist —
    // verified against Playwright 1.62.1.
    `--reporter=${htmlDir ? "json,html" : "json"}`,
  ];
  // Forced from the CLI for the same reason. There is no --video or --screenshot
  // flag; those are config-only, which is why the trace IS the recording here —
  // it carries a frame-by-frame filmstrip, the DOM, network and console.
  if (opt.trace) args.push(`--trace=${opt.trace}`);

  say(`running: ${m.command} ${args.join(" ")}`);
  say(`  base URL  ${baseUrl}`);
  say(
    `  tier      ${opt.tier}` +
      `${opt.area?.length ? ` · areas ${opt.area.join(", ")}` : ""}` +
      `${opt.pro ? ` · pro ${proSlug} (licensed, specs: ${opt.proSpecs})` : " · @pro excluded"}`,
  );

  const started = Date.now();
  const r = await runInProduct(
    m.command,
    args,
    {
      ...runEnv,
      // PLAYWRIGHT_JSON_OUTPUT_NAME is how the json reporter is pointed at a
      // file without touching the product's config; the HTML pair does the same.
      PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath,
      ...(htmlDir
        ? {
            PLAYWRIGHT_HTML_OUTPUT_DIR: htmlDir,
            // Without this the reporter opens a browser on failure, which is
            // merely noisy in CI but hangs a developer's local run.
            PLAYWRIGHT_HTML_OPEN: "never",
          }
        : {}),
    },
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

  const result = summarise(report, durationMs, {
    html_report: htmlDir
      ? path.relative(root, htmlDir).split(path.sep).join("/")
      : null,
    html_report_skipped: htmlSkipped,
    trace_mode: opt.trace,
  });
  if (scope) result.scope = scope;
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

function summarise(report, durationMs, evidence = {}) {
  const failures = [];
  const fixme = [];
  const flakyTests = [];
  const passedTests = [];
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

        const rel = normaliseFile(file, report);
        const results = t.results ?? [];

        switch (t.status) {
          case "expected":
            passed++;
            // Only under --full-results: see the flag. "What went right" is
            // worth its bytes to a human reading a report, not to an agent.
            if (opt.fullResults) {
              passedTests.push({
                title: spec.title,
                file: rel,
                line: spec.line ?? null,
                area: meta?.area ? meta.area.replace(/^@/, "") : null,
                guards: meta?.guards ?? [],
                duration_ms: results[results.length - 1]?.duration ?? null,
              });
            }
            break;
          case "flaky":
            flaky++;
            passed++; // it did pass, on retry — counted, and surfaced separately
            // Naming them is the point. "4 flaky" tells nobody which four, so
            // nobody ever fixes them and the number only grows.
            flakyTests.push({
              title: spec.title,
              file: rel,
              line: spec.line ?? null,
              area: meta?.area ? meta.area.replace(/^@/, "") : null,
              retries: Math.max(0, results.length - 1),
              // The error from the attempt that failed, not the retry that
              // passed — that is the one that says why it is flaky.
              error: stripAnsi(
                String(firstErrorOf(results.find((x) => x.status !== "passed") ?? {})),
              ).slice(0, 400),
            });
            break;
          case "skipped":
            skipped++;
            break;
          case "unexpected":
          default: {
            failed++;
            const last = results[results.length - 1] ?? {};
            const err = firstErrorOf(last);
            const loc = last.error?.location ?? (last.errors ?? [])[0]?.location;
            failures.push({
              title: spec.title,
              file: rel,
              line: spec.line ?? null,
              area: meta?.area ? meta.area.replace(/^@/, "") : null,
              guards: meta?.guards ?? [],
              // Why this spec exists. Already parsed from the docblock and, until
              // now, kept only for `fixme` — yet on a failure it is the single
              // most useful line: it says what behaviour just stopped working.
              why: meta?.why ?? null,
              source: meta?.source ?? null,
              error: stripAnsi(String(err)).slice(0, 400),
              // The 400-char cut above keeps the GitHub annotation short. A
              // report a human opens deserves the whole message.
              error_full: stripAnsi(String(err)).slice(0, 4000),
              // Playwright's code frame — the failing line with its neighbours,
              // which is what makes a failure readable without opening the repo.
              error_snippet: last.error?.snippet
                ? stripAnsi(String(last.error.snippet)).slice(0, 4000)
                : null,
              // Where it actually broke. `line` above is where the test STARTS;
              // reporting that as the failure has sent people to the wrong line.
              location: loc
                ? {
                    file: normaliseFile(loc.file, report),
                    line: loc.line ?? null,
                    column: loc.column ?? null,
                  }
                : null,
              // A test can fail more than one way at once; only the first was
              // ever reported, which hides the cause when the first is a
              // teardown error and the second is the real one.
              errors: (last.errors ?? [])
                .map((e) => stripAnsi(String(e?.message ?? "")).slice(0, 2000))
                .filter(Boolean)
                .slice(0, 5),
              // Repo-relative: an absolute path from the runner's machine is
              // meaningless in a PR comment read on someone else's.
              attachments: attachmentsOf(last, report),
              retries: Math.max(0, results.length - 1),
              // "Failed three times identically" and "failed only after passing
              // once" are different bugs, and only the timeline distinguishes them.
              attempts: results.map((res, i) => ({
                retry: i,
                status: res.status ?? null,
                duration_ms: res.duration ?? null,
                error: stripAnsi(String(firstErrorOf(res))).slice(0, 400),
                attachments: attachmentsOf(res, report),
              })),
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
    // The pro axis, reported explicitly so a reader of the JSON never has to
    // infer whether pro was under test. `pro: false` means @pro specs were
    // EXCLUDED, not that they passed.
    pro: opt.pro,
    pro_product: opt.pro ? proSlug : null,
    pro_specs: opt.pro ? opt.proSpecs : null,
    licence: licence
      ? { state: licence.state, pro_gate: licence.gate?.active ?? null, environment_type: licence.environment_type }
      : null,
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
    flaky_tests: flakyTests,
    // Absent rather than empty when not asked for, so a consumer can tell "no
    // tests passed" from "nobody asked which ones did".
    passed_tests: opt.fullResults ? passedTests : null,
    // Where the evidence is, and why there is or is not any.
    html_report: evidence.html_report ?? null,
    html_report_skipped: evidence.html_report_skipped ?? null,
    trace_mode: evidence.trace_mode ?? null,
    // Where the runner's own output went, when it was not printed here.
    log: opt.json ? logFile : null,
  };
}

/** The first usable error message on a result, whichever shape carries it. */
function firstErrorOf(result) {
  return (
    result?.error?.message ??
    (result?.errors ?? [])[0]?.message ??
    "no error message in the report"
  );
}

/**
 * Attachments, repo-relative and keeping their name and type.
 *
 * The name is what makes them usable: `screenshot`, `trace` and `video` are
 * three very different things to offer a reader, and telling them apart by
 * file extension is guesswork the report should not have to do.
 */
function attachmentsOf(result, report) {
  return (result?.attachments ?? [])
    .filter((a) => a?.path)
    .map((a) => ({
      name: a.name ?? null,
      content_type: a.contentType ?? null,
      path: normaliseFile(a.path, report),
    }));
}

/** Is `child` the same directory as `parent`, or inside it? */
function contains(parent, child) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
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
