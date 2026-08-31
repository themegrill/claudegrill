#!/usr/bin/env node
/**
 * Install the licence-key pre-commit guard into the repository you are in.
 *
 * A separate script rather than a line in a README because a guard nobody
 * installs is not a guard, and "copy this symlink command" is a step people
 * skip. Run it once per repo that holds a licence key.
 *
 * Refuses to clobber an existing `pre-commit` hook it did not write. Silently
 * replacing someone's linter hook to install a secret scanner would be a poor
 * trade and an obnoxious surprise.
 *
 * Usage
 *   node scripts/install-git-hook.mjs            install into the current repo
 *   node scripts/install-git-hook.mjs --force    replace an existing hook
 *   node scripts/install-git-hook.mjs --check    is it installed? exit 0/1
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { resolveQaHome } from "./lib/qa-home.mjs";
import { isWindows } from "./lib/platform.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const qaHome = resolveQaHome(here);

const force = process.argv.includes("--force");
const check = process.argv.includes("--check");

const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
if (top.status !== 0) {
  console.error("not inside a git repository");
  process.exit(2);
}
const repo = top.stdout.trim();

// `--git-common-dir`, not `--git-dir`: in a worktree the hooks live in the main
// repository's .git, and installing into the worktree's own gitdir puts the
// hook somewhere git will never run it.
const common = spawnSync("git", ["rev-parse", "--git-common-dir"], {
  cwd: repo,
  encoding: "utf8",
});
const gitDir = path.resolve(repo, common.stdout.trim() || ".git");
const hookPath = path.join(gitDir, "hooks", "pre-commit");

const MARKER = "claudegrill scan-secrets";

if (check) {
  const installed =
    fs.existsSync(hookPath) && fs.readFileSync(hookPath, "utf8").includes(MARKER);
  console.log(installed ? `installed: ${hookPath}` : "not installed");
  process.exit(installed ? 0 : 1);
}

if (fs.existsSync(hookPath) && !force) {
  const existing = fs.readFileSync(hookPath, "utf8");
  if (existing.includes(MARKER)) {
    console.log(`already installed: ${hookPath}`);
    process.exit(0);
  }
  console.error(
    `${hookPath} already exists and was not written by us.\n` +
      `Add this line to it yourself, or re-run with --force to replace it:\n\n` +
      `  node ${path.join(qaHome, "scripts", "scan-secrets.mjs")} --staged\n`,
  );
  process.exit(1);
}

// A generated shim rather than a symlink: symlinks need Developer Mode or an
// elevated shell on Windows, and this repo treats Windows as a first-class
// target rather than a thing to apologise for later.
const body = `#!/bin/sh
# ${MARKER} — installed by scripts/install-git-hook.mjs
#
# Refuses a commit carrying a licence key. Bypass with --no-verify only if you
# are certain; CI runs the same scan and will not be so forgiving.
set -e
exec node ${JSON.stringify(path.join(qaHome, "scripts", "scan-secrets.mjs"))} \\
  --staged --cwd "$(git rev-parse --show-toplevel)"
`;

fs.mkdirSync(path.dirname(hookPath), { recursive: true });
fs.writeFileSync(hookPath, body);
if (!isWindows) fs.chmodSync(hookPath, 0o755);

console.log(`installed: ${hookPath}`);
console.log("test it with: node scripts/scan-secrets.mjs --staged");
