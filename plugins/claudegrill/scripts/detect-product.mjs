#!/usr/bin/env node
/**
 * Detect what WordPress product lives in the current directory.
 *
 * Node rather than bash so it runs unchanged on Windows and macOS with nothing
 * installed beyond Node, which is already needed for Playwright and Playground.
 *
 * This is what makes `/verify-fix` work with "little to no context": the agent
 * does not need to be told which product it is looking at, what the slug is, or
 * whether it is a theme or a plugin. It reads that from the source itself.
 *
 * Emits JSON on stdout. Exits 1 with {"error": ...} if this is not a WordPress
 * theme or plugin.
 *
 *   node scripts/detect-product.mjs [path]
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const target = path.resolve(process.argv[2] ?? process.cwd());

/** Repo root, or the given path when not a git checkout. */
function repoRoot(from) {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: from,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return from;
  }
}

const root = path.resolve(repoRoot(target));

/**
 * Read a WordPress file header, e.g. "Theme Name: ColorMag".
 * Only the first 60 lines: headers are always at the top, and stopping there
 * avoids matching a similar-looking string deeper in the file.
 */
function headerField(file, field) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }

  const lines = text.split(/\r?\n/, 60);
  const re = new RegExp(`^\\s*\\*?\\s*${field}\\s*:\\s*(.+)$`, "i");

  for (const line of lines) {
    const m = line.match(re);
    if (m) return m[1].replace(/\s+$/, "").replace(/\*\/\s*$/, "").trim();
  }
  return "";
}

/** Shallow scan for candidate plugin entry files. */
function phpCandidates(dir) {
  const out = [];
  const skip = new Set(["vendor", "node_modules", ".git", "tests", "languages", "assets"]);

  const rootFiles = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of rootFiles) {
    if (e.isFile() && e.name.endsWith(".php")) out.push(path.join(dir, e.name));
  }
  for (const e of rootFiles) {
    if (!e.isDirectory() || skip.has(e.name) || e.name.startsWith(".")) continue;
    let inner = [];
    try {
      inner = fs.readdirSync(path.join(dir, e.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of inner) {
      if (f.isFile() && f.name.endsWith(".php")) out.push(path.join(dir, e.name, f.name));
    }
    if (out.length > 60) break;
  }
  return out;
}

let type = "";
let name = "";
let version = "";
let textdomain = "";
let entry = "";

// --- Theme? A style.css carrying "Theme Name" is definitive. ---
const styleCss = path.join(root, "style.css");
if (fs.existsSync(styleCss) && headerField(styleCss, "Theme Name")) {
  type = "theme";
  entry = "style.css";
  name = headerField(styleCss, "Theme Name");
  version = headerField(styleCss, "Version");
  textdomain = headerField(styleCss, "Text Domain");
}

// --- Plugin? The PHP file carrying "Plugin Name". ---
if (!type) {
  for (const file of phpCandidates(root)) {
    if (headerField(file, "Plugin Name")) {
      type = "plugin";
      entry = path.relative(root, file).split(path.sep).join("/");
      name = headerField(file, "Plugin Name");
      version = headerField(file, "Version");
      textdomain = headerField(file, "Text Domain");
      break;
    }
  }
}

if (!type) {
  process.stdout.write(
    JSON.stringify({
      error:
        "not a WordPress theme or plugin: no Theme Name or Plugin Name header found",
    }) + "\n",
  );
  process.exit(1);
}

// Slug: the text domain is the most reliable source across this catalogue.
const slug = (textdomain || path.basename(root))
  .toLowerCase()
  .replace(/[\s_]+/g, "-");

// The knowledge file. A copy inside the product wins over a central one, so the
// PR that renames a setting can fix its description in the same commit.
let knowledge = null;
const candidates = [
  path.join(root, ".themegrill-qa", "knowledge.md"),
  path.join(root, "knowledge", `${slug}.md`),
  path.join(root, "..", "claudegrill", "knowledge", `${slug}.md`),
  process.env.THEMEGRILL_QA_HOME
    ? path.join(process.env.THEMEGRILL_QA_HOME, "knowledge", `${slug}.md`)
    : null,
];
for (const c of candidates) {
  if (c && fs.existsSync(c)) {
    knowledge = path.relative(root, c).split(path.sep).join("/");
    break;
  }
}

// The suite manifest. Unlike the knowledge file this has exactly one home —
// a suite belongs to the product that owns it, so there is no central fallback
// to search. Absent is a valid state: the product simply has no suite yet, and
// every consumer of this field degrades gracefully rather than erroring.
// Contract: SUITE.md §1.
const suitePath = path.join(root, ".themegrill-qa", "suite.json");
const suite = fs.existsSync(suitePath)
  ? path.relative(root, suitePath).split(path.sep).join("/")
  : null;

// Branch and ticket key: a branch like fix/CM-1234-header-overlap tells the agent
// which Jira issue this belongs to without anyone typing it.
let branch = "";
try {
  branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
} catch {
  /* not a git checkout */
}
const ticket = (branch.match(/[A-Z][A-Z0-9]+-\d+/) ?? [null])[0];

// Pro companion, checked out alongside.
const hasPro =
  fs.existsSync(path.join(root, "..", `${slug}-pro`)) ||
  fs.existsSync(path.join(root, `${slug}-pro`));

process.stdout.write(
  JSON.stringify(
    {
      type,
      slug,
      name,
      version: version || null,
      textdomain: textdomain || null,
      root,
      knowledge,
      suite,
      entry,
      branch,
      ticket,
      has_pro: hasPro,
      platform: process.platform,
    },
    null,
    2,
  ) + "\n",
);
