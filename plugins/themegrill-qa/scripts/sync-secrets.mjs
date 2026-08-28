#!/usr/bin/env node
/**
 * Put the licence secrets in every repository that needs them.
 *
 * This script exists because of one GitHub Free constraint: **organisation-level
 * secrets are not accessible to private repositories on GitHub Free.** The pro
 * repos are private, so an org secret does not reach them, and every secret has
 * to exist in every repository separately. Across four pro products that is a
 * dozen settings maintained by hand, which means it will drift, which means a
 * workflow will one day fail because one repo missed one secret.
 *
 * So: one gitignored `.env.ci`, and a script that pushes it.
 *
 * Two rules the implementation is built around, both about not leaking a key:
 *
 *   1. **Values go in over stdin, never in argv.** `gh secret set NAME --body
 *      <value>` puts the key in the process list, where any other process on the
 *      machine — and any CI log that dumps `ps` — can read it. `--body -` reads
 *      stdin instead.
 *   2. **`--dry-run` is the default.** An unlimited lifetime key is the worst
 *      credential to misplace: no activation cap throttles an attacker, and
 *      revoking one means reissuing across every repo and every developer
 *      machine at once. Writing needs `--confirm`, typed deliberately.
 *
 * Usage
 *   node scripts/sync-secrets.mjs --dry-run    what would be set where (default)
 *   node scripts/sync-secrets.mjs --confirm    actually set them
 *   node scripts/sync-secrets.mjs --audit      which repos are missing which
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { resolveQaHome } from "./lib/qa-home.mjs";
import { loadEnvFile, loadRegistry } from "./lib/license/registry.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const qaHome = resolveQaHome(here);

const opt = { mode: "dry-run", envFile: null, product: null };

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--dry-run") opt.mode = "dry-run";
  else if (a === "--confirm") opt.mode = "confirm";
  else if (a === "--audit") opt.mode = "audit";
  else if (a === "--env-file") opt.envFile = argv[++i];
  else if (a === "--product") opt.product = argv[++i];
  else {
    console.error(`unknown flag: ${a}`);
    process.exit(2);
  }
}

const say = (s) => process.stdout.write(`${s}\n`);
const warn = (s) => process.stderr.write(`${s}\n`);

// ------------------------------------------------------------------- gh check

function gh(args, input) {
  return spawnSync("gh", args, {
    encoding: "utf8",
    input,
    // `gh` on Windows is `gh.exe` on PATH; no shell needed, and not using one
    // keeps the value out of any shell history or command echo.
  });
}

const version = gh(["--version"]);
if (version.error) {
  warn(
    "the GitHub CLI (`gh`) is not installed or not on PATH.\n" +
      "  macOS: brew install gh    Windows: winget install GitHub.cli\n" +
      "  then: gh auth login",
  );
  process.exit(2);
}

const auth = gh(["auth", "status"]);
if (auth.status !== 0) {
  warn("`gh` is installed but not authenticated. Run: gh auth login");
  if (auth.stderr) warn(auth.stderr.trim());
  process.exit(2);
}

// ------------------------------------------------------------------- what/where

let registry;
try {
  registry = loadRegistry(qaHome);
} catch (err) {
  warn(err.message);
  process.exit(2);
}

const entries = Object.values(registry).filter(
  (e) => !opt.product || e.slug === opt.product,
);

if (entries.length === 0) {
  warn(`no such product: ${opt.product}`);
  process.exit(2);
}

/**
 * Which secrets belong in which repository.
 *
 * A product's own licence key goes in its own pro repo, and — because the free
 * repo's CI runs the "free suite with pro installed" job — in the free repo too.
 * The GitHub App credentials go everywhere, because every caller workflow needs
 * a token to check the private pro repo out.
 */
const APP_SECRETS = ["TGQA_APP_ID", "TGQA_APP_PRIVATE_KEY"];

function plan() {
  const byRepo = new Map();
  const add = (repo, name) => {
    if (!repo) return;
    if (!byRepo.has(repo)) byRepo.set(repo, new Set());
    byRepo.get(repo).add(name);
  };

  for (const e of entries) {
    add(e.repo, e.key_env);
    for (const a of APP_SECRETS) add(e.repo, a);

    // The free repo runs the pro-installed job, so it needs the same key.
    if (e.requires && e.repo) {
      const owner = e.repo.split("/")[0];
      const freeRepo = `${owner}/${e.requires}`;
      add(freeRepo, e.key_env);
      for (const a of APP_SECRETS) add(freeRepo, a);
    }
  }

  return [...byRepo.entries()]
    .map(([repo, names]) => ({ repo, names: [...names].sort() }))
    .sort((a, b) => a.repo.localeCompare(b.repo));
}

const targets = plan();

// ---------------------------------------------------------------------- audit

if (opt.mode === "audit") {
  // `gh secret list` returns NAMES ONLY — never values — which is what makes
  // this the command you can run any time, and the one you will actually use.
  let missingTotal = 0;
  for (const t of targets) {
    const res = gh(["secret", "list", "--repo", t.repo, "--json", "name"]);
    if (res.status !== 0) {
      say(`${t.repo}\n  ! could not read secrets: ${String(res.stderr).trim().split("\n")[0]}`);
      missingTotal += t.names.length;
      continue;
    }
    let have = [];
    try {
      have = JSON.parse(res.stdout).map((x) => x.name);
    } catch {
      /* older gh without --json falls through as empty, reported as missing */
    }
    const missing = t.names.filter((n) => !have.includes(n));
    missingTotal += missing.length;
    say(
      `${t.repo}\n` +
        t.names
          .map((n) => `  ${have.includes(n) ? "✓" : "✗"} ${n}`)
          .join("\n"),
    );
  }
  say(missingTotal === 0 ? "\nall secrets present" : `\n${missingTotal} secret(s) missing`);
  process.exit(missingTotal === 0 ? 0 : 1);
}

// ------------------------------------------------------------------- the values

const envFilePath = path.resolve(opt.envFile ?? path.join(qaHome, ".env.ci"));
const values = { ...loadEnvFile(envFilePath), ...pickFromProcess() };

function pickFromProcess() {
  const out = {};
  for (const t of targets) {
    for (const n of t.names) {
      if (process.env[n]) out[n] = process.env[n];
    }
  }
  return out;
}

if (Object.keys(values).length === 0) {
  warn(
    `no values found. Write a gitignored ${envFilePath} with lines like\n` +
      `  TGQA_LICENSE_COLORMAG_PRO=...\n` +
      `or export them into the environment.`,
  );
  process.exit(2);
}

// A .env.ci that is not ignored is a key one `git add .` away from being public.
// Checking is cheap; finding out afterwards is not.
if (fs.existsSync(envFilePath)) {
  const check = spawnSync("git", ["check-ignore", "-q", envFilePath], {
    cwd: path.dirname(envFilePath),
  });
  if (check.status !== 0) {
    warn(
      `REFUSING TO CONTINUE: ${envFilePath} is not gitignored.\n` +
        `Add it to .gitignore before putting a licence key in it.`,
    );
    process.exit(2);
  }
}

// ------------------------------------------------------------------ dry / write

let wrote = 0;
let skipped = 0;

for (const t of targets) {
  say(t.repo);
  for (const name of t.names) {
    const value = values[name];

    if (!value) {
      say(`  – ${name}  (no value available — skipped)`);
      skipped++;
      continue;
    }

    if (opt.mode === "dry-run") {
      // Names and targets only. Never a value, not even redacted: a redaction
      // printed a thousand times is a thousand chances to have got it wrong.
      say(`  → ${name}`);
      continue;
    }

    const res = gh(["secret", "set", name, "--repo", t.repo, "--body", "-"], value);
    if (res.status === 0) {
      say(`  ✓ ${name}`);
      wrote++;
    } else {
      say(`  ✗ ${name}: ${String(res.stderr).trim().split("\n")[0]}`);
      skipped++;
    }
  }
}

if (opt.mode === "dry-run") {
  say(`\ndry run — nothing was written. Re-run with --confirm to set these.`);
  process.exit(0);
}

say(`\n${wrote} secret(s) set, ${skipped} skipped`);
process.exit(skipped === 0 ? 0 : 1);
