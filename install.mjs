#!/usr/bin/env node
/**
 * One-command install, on Windows and macOS alike.
 *
 *   node install.mjs
 *
 * Installs the skills into your personal Claude Code directory, sets
 * THEMEGRILL_QA_HOME, and checks that Node is new enough. Nothing else is
 * required: no WSL, no Docker unless you later want the wp-env engine, no
 * Python. Everything here runs on Node.
 *
 * On Windows the skills are linked with directory junctions rather than symlinks,
 * because junctions do not need administrator rights or Developer Mode. If even
 * that fails, the files are copied and you re-run this after a `git pull`.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const isWindows = process.platform === "win32";
const qaHome = path.dirname(fileURLToPath(import.meta.url));
const skillsSrc = path.join(qaHome, "plugins", "themegrill-qa", "skills");
const skillsDest = path.join(os.homedir(), ".claude", "skills");

const SKILLS = [
  "verify-fix",
  "write-spec",
  "pr-qa-review",
  "regression-sweep",
  "full-test",
  "knowledge-init",
];

const tick = (s) => console.log(`  ok    ${s}`);
const warn = (s) => console.log(`  note  ${s}`);
const fail = (s) => console.log(`  FAIL  ${s}`);

console.log(`\nthemegrill-qa install\n${"-".repeat(60)}`);
console.log(`  platform     ${process.platform} ${process.arch}`);
console.log(`  node         ${process.version}`);
console.log(`  install from ${qaHome}\n`);

let problems = 0;

// ------------------------------------------------------------------ node check

const major = Number(process.version.slice(1).split(".")[0]);
if (major < 20) {
  fail(`Node ${process.version} is too old — install Node 20 or newer from nodejs.org`);
  problems++;
} else {
  tick(`Node ${process.version}`);
}

// --------------------------------------------------------------------- git/npx

for (const [cmd, args, label] of [
  [isWindows ? "git.exe" : "git", ["--version"], "git"],
  [isWindows ? "npx.cmd" : "npx", ["--version"], "npx"],
]) {
  try {
    const v = execFileSync(cmd, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      shell: isWindows,
    }).trim();
    tick(`${label} ${v.split("\n")[0]}`);
  } catch {
    fail(`${label} not found on PATH`);
    problems++;
  }
}

// ---------------------------------------------------------------------- skills

fs.mkdirSync(skillsDest, { recursive: true });

/** Remove whatever is at dest, link or directory. */
function clear(dest) {
  try {
    const st = fs.lstatSync(dest);
    if (st.isSymbolicLink() || st.isFile()) fs.unlinkSync(dest);
    else fs.rmSync(dest, { recursive: true, force: true });
  } catch {
    /* nothing there */
  }
}

let linked = 0;
let copied = 0;

for (const skill of SKILLS) {
  const src = path.join(skillsSrc, skill);
  const dest = path.join(skillsDest, skill);

  if (!fs.existsSync(src)) {
    warn(`skill missing in this checkout: ${skill}`);
    continue;
  }

  clear(dest);

  try {
    // "junction" on Windows needs no elevation; "dir" elsewhere.
    fs.symlinkSync(src, dest, isWindows ? "junction" : "dir");
    linked++;
  } catch {
    try {
      fs.cpSync(src, dest, { recursive: true });
      copied++;
    } catch (err) {
      fail(`could not install skill ${skill}: ${err.message}`);
      problems++;
    }
  }
}

if (linked) tick(`${linked} skills linked into ${skillsDest}`);
if (copied) {
  warn(
    `${copied} skills had to be COPIED, not linked — re-run this after a git pull`,
  );
}

// ------------------------------------------------------------- env var, if any

const alreadySet =
  process.env.THEMEGRILL_QA_HOME &&
  path.resolve(process.env.THEMEGRILL_QA_HOME) === path.resolve(qaHome);

if (alreadySet) {
  tick("THEMEGRILL_QA_HOME already points here");
} else if (isWindows) {
  try {
    execFileSync("setx", ["THEMEGRILL_QA_HOME", qaHome], {
      stdio: "ignore",
      shell: true,
    });
    tick("THEMEGRILL_QA_HOME set for your user — open a new terminal to pick it up");
  } catch {
    warn(`could not set it automatically. Run:  setx THEMEGRILL_QA_HOME "${qaHome}"`);
  }
} else {
  const rc = fs.existsSync(path.join(os.homedir(), ".zshrc"))
    ? path.join(os.homedir(), ".zshrc")
    : path.join(os.homedir(), ".bashrc");
  const line = `export THEMEGRILL_QA_HOME="${qaHome}"`;
  let current = "";
  try {
    current = fs.readFileSync(rc, "utf8");
  } catch {
    /* new file */
  }
  if (current.includes("THEMEGRILL_QA_HOME")) {
    warn(`${path.basename(rc)} already mentions THEMEGRILL_QA_HOME — check it points here`);
  } else {
    fs.appendFileSync(rc, `\n# themegrill-qa\n${line}\n`);
    tick(`added to ${path.basename(rc)} — open a new terminal, or run: ${line}`);
  }
}

// -------------------------------------------------------------- smoke check

try {
  const out = execFileSync(
    process.execPath,
    [path.join(qaHome, "plugins", "themegrill-qa", "scripts", "detect-product.mjs"), qaHome],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  warn(`detect-product ran but thinks this repo is a product: ${out.trim().slice(0, 60)}`);
} catch (err) {
  // Expected: themegrill-qa is not itself a theme or plugin.
  const said = String(err.stdout || "");
  if (said.includes("not a WordPress theme or plugin")) {
    tick("detect-product.mjs runs and fails correctly outside a product");
  } else {
    fail(`detect-product.mjs did not run: ${String(err.message).slice(0, 120)}`);
    problems++;
  }
}

// ------------------------------------------------------------------- summary

console.log(`\n${"-".repeat(60)}`);

if (problems) {
  console.log(`${problems} problem(s) above. Fix those first.\n`);
  process.exit(1);
}

console.log(`Installed.

Next, in a NEW terminal, from inside your ColorMag checkout:

  node "${path.join(qaHome, "plugins", "themegrill-qa", "scripts", "boot-wp.mjs")}"

That boots a disposable WordPress with ColorMag mounted. If it works, open
Claude Code there and run /verify-fix. Full walkthrough: SETUP-COLORMAG.md
`);
