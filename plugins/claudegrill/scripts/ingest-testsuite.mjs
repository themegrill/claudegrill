#!/usr/bin/env node
/**
 * Ingest an existing Selenium / Robot Framework suite as a specification.
 *
 * Node, so it runs on Windows and macOS with nothing but Node installed.
 *
 * Why an extractor and not a converter
 * ------------------------------------
 * The valuable content in a QA team's existing suite is not the code. It is the
 * inventory of journeys somebody decided were worth testing, the assertions that
 * define "correct", the test data, and above all the cases added because a real
 * bug once got through.
 *
 * The code itself is mostly locators and framework plumbing, and locators are
 * exactly what must not carry across: they are bound to Selenium's strategies
 * and to markup we do not own, which is the brittleness CONVENTIONS.md rule 1
 * exists to prevent. A faithful port would faithfully reproduce it.
 *
 * Robot Framework is an unusually good source: test names are sentences,
 * [Documentation] states intent, [Tags] is already a taxonomy, and keywords like
 * `Page Should Contain` are assertions in plain words.
 *
 * Output
 *   .themegrill-qa/testcases/<area>.md    inventory + assertions per area
 *   .themegrill-qa/testcase-index.json    areas, counts, suggested areas
 *
 * Usage
 *   node scripts/ingest-testsuite.mjs ../qa-automation
 *   node scripts/ingest-testsuite.mjs ../qa-automation --area-from tags
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

// ------------------------------------------------------------------ arguments

const argv = process.argv.slice(2);
const opt = { root: null, out: ".themegrill-qa", areaFrom: "path" };

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--out") opt.out = argv[++i];
  else if (a === "--area-from") opt.areaFrom = argv[++i];
  else if (!a.startsWith("--")) opt.root = a;
  else {
    console.error(`unknown flag: ${a}`);
    process.exit(2);
  }
}

if (!opt.root) {
  console.error("usage: node scripts/ingest-testsuite.mjs <suite-directory> [--out DIR] [--area-from path|tags]");
  process.exit(2);
}
opt.root = path.resolve(opt.root);
if (!fs.existsSync(opt.root) || !fs.statSync(opt.root).isDirectory()) {
  console.error(`not a directory: ${opt.root}`);
  process.exit(2);
}

// Tags that say *when* a test runs, not *what* it covers. Never an area.
const LIFECYCLE_TAGS = new Set([
  "smoke", "regression", "sanity", "critical", "wip", "skip", "slow", "fast",
  "flaky", "nightly", "ci", "manual", "p0", "p1", "p2", "p3",
  "high", "medium", "low", "validation", "security", "negative", "positive",
  "e2e", "ui", "api",
]);

const SKIP_DIRS = new Set([
  ".git", "node_modules", "venv", ".venv", "__pycache__",
  "results", "output", "reports", "dist", "build",
]);

// ---------------------------------------------------------------------- files

function walk(dir, found = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
      walk(path.join(dir, e.name), found);
    } else if (e.isFile()) {
      const n = e.name.toLowerCase();
      if (n.endsWith(".robot") || n.endsWith(".resource")) found.push(path.join(dir, e.name));
      else if (n.endsWith(".py") && (n.includes("test") || n.includes("spec"))) {
        found.push(path.join(dir, e.name));
      }
    }
  }
  return found;
}

// --------------------------------------------------------------- Robot parsing

const SECTION_RE = /^\*+\s*(settings?|variables?|test\s*cases?|tasks?|keywords?)\s*\**/i;
const CELL_SPLIT = /\t+|[ ]{2,}/;
const ASSERT_RE =
  /(should\b|^wait\s+until|^verify|^assert|^check\s|^confirm|^element\s+text|^title\s+should|^location\s+should)/i;
const LOCATOR_RE = /^(id|name|xpath|css|class|link|partial\s*link|tag|data)\s*[:=]\s*\S/i;
const XPATH_RE = /(^|\s)(\/\/|\(\/\/)/;

function parseRobot(file) {
  const tests = [];
  const keywords = [];
  let section = null;
  let current = null;
  let kwCurrent = null;

  const text = fs.readFileSync(file, "utf8");

  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;

    const sec = raw.trim().match(SECTION_RE);
    if (sec) {
      const n = sec[1].toLowerCase().replace(/\s+/g, "");
      section = n.startsWith("testcase") || n.startsWith("task")
        ? "tests"
        : n.startsWith("keyword")
          ? "keywords"
          : "other";
      current = kwCurrent = null;
      continue;
    }
    if (section !== "tests" && section !== "keywords") continue;

    const indented = raw[0] === " " || raw[0] === "\t";
    const cells = raw.trim().split(CELL_SPLIT).map((c) => c.trim()).filter(Boolean);
    if (!cells.length) continue;

    // A name starts at column zero.
    if (!indented) {
      const entry = {
        name: cells[0], doc: "", tags: [],
        steps: [], assertions: [], locators: [], source: file,
      };
      if (section === "tests") { tests.push(entry); current = entry; }
      else { keywords.push(entry); kwCurrent = entry; }
      continue;
    }

    const target = section === "tests" ? current : kwCurrent;
    if (!target) continue;

    const head = cells[0];

    if (head === "...") {
      if (target.steps.length) target.steps[target.steps.length - 1] += " " + cells.slice(1).join(" ");
      continue;
    }

    if (head.startsWith("[")) {
      const setting = head.replace(/[[\]]/g, "").toLowerCase();
      if (setting === "documentation") target.doc = cells.slice(1).join(" ");
      else if (setting === "tags") target.tags = cells.slice(1).filter(Boolean);
      continue;
    }

    const step = cells.join("    ");
    target.steps.push(step);
    if (ASSERT_RE.test(head)) target.assertions.push(step);
    for (const cell of cells.slice(1)) {
      if (LOCATOR_RE.test(cell) || XPATH_RE.test(cell)) target.locators.push(cell);
    }
  }

  return { tests, keywords };
}

// -------------------------------------------------------------- Python parsing

const PY_TEST_RE = /^[ \t]*def[ \t]+(test_\w+)[ \t]*\(/gm;
// The docstring follows the signature, which may span lines and carry type
// hints, so anchor on the closing paren and colon rather than the body start.
const PY_DOC_RE = /\)\s*(?:->[^:]+?)?:\s*(?:[rubf]{0,2})("""|''')([\s\S]*?)\1/;
const PY_ASSERT_RE = /^[ \t]*(assert\b.*|self\.assert\w+\(.*)$/gm;
const PY_LOCATOR_RE = /By\.(\w+)\s*,\s*(["'])([\s\S]*?)\2/g;

function parsePython(file) {
  const src = fs.readFileSync(file, "utf8");
  const tests = [];
  const marks = [...src.matchAll(PY_TEST_RE)];

  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].index + marks[i][0].length;
    const end = i + 1 < marks.length ? marks[i + 1].index : src.length;
    const body = src.slice(start, end);

    // Only look near the top: a triple-quoted string further down belongs to a
    // later statement, not to the test.
    const doc = body.slice(0, 600).match(PY_DOC_RE);

    tests.push({
      name: marks[i][1].replace(/^test_/, "").replace(/_/g, " ").trim()
        .replace(/^./, (c) => c.toUpperCase()),
      doc: doc ? doc[2].split(/\s+/).join(" ").trim() : "",
      tags: [],
      steps: [],
      assertions: [...body.matchAll(PY_ASSERT_RE)].map((m) => m[1].trim()).slice(0, 12),
      locators: [...body.matchAll(PY_LOCATOR_RE)]
        .map((m) => `${m[1].toLowerCase()}=${m[3]}`).slice(0, 12),
      source: file,
    });
  }

  return { tests, keywords: [] };
}

// ----------------------------------------------------------------------- areas

function pathArea(entry) {
  const rel = path.relative(opt.root, entry.source);
  const parts = rel.split(path.sep).filter(Boolean);

  if (parts.length > 1) return parts[parts.length - 2].toLowerCase().replace(/_/g, "-");

  const stem = path.basename(parts[parts.length - 1], path.extname(parts[parts.length - 1]));
  return stem.replace(/^tests?_?/i, "").toLowerCase().replace(/_/g, "-") || "uncategorised";
}

/**
 * Path is the default. Directory structure is how people group tests by feature,
 * whereas tag sets usually mix feature names with cross-cutting facets. A tag
 * like `validation` describes a facet of many features; treating it as an area
 * splits one feature's coverage across shards and leaves a shard that is a theme
 * rather than a surface.
 */
function areaOf(entry) {
  if (opt.areaFrom === "tags" && entry.tags.length) {
    const real = entry.tags.filter((t) => !LIFECYCLE_TAGS.has(t.toLowerCase()));
    if (real.length) return real[0].toLowerCase().replace(/[_\s]+/g, "-");
  }
  return pathArea(entry);
}

// ------------------------------------------------------------------------- run

const files = walk(opt.root);
if (!files.length) {
  console.error("found no .robot, .resource or test_*.py files under that path");
  process.exit(1);
}

console.log(`scanning ${files.length} files under ${opt.root}\n`);

const allTests = [];
const allKeywords = [];

for (const file of files.sort()) {
  try {
    const { tests, keywords } =
      /\.(robot|resource)$/i.test(file) ? parseRobot(file) : parsePython(file);
    allTests.push(...tests);
    allKeywords.push(...keywords);
  } catch (err) {
    console.error(`  ! could not parse ${file}: ${err.message}`);
  }
}

if (!allTests.length) {
  console.error("parsed the files but found no test cases — check the paths");
  process.exit(1);
}

const grouped = new Map();
for (const t of allTests) {
  const a = areaOf(t);
  grouped.set(a, [...(grouped.get(a) ?? []), t]);
}

const outDir = path.join(opt.out, "testcases");
fs.mkdirSync(outDir, { recursive: true });

const index = {
  source: opt.root, areas: [], suggested_areas: [],
  shared_keywords: allKeywords.length, totals: {}, tags: [],
};

for (const [area, tests] of [...grouped.entries()].sort((a, b) => b[1].length - a[1].length)) {
  const documented = tests.filter((t) => t.doc).length;
  const assertions = tests.flatMap((t) => t.assertions);
  const locators = [...new Set(tests.flatMap((t) => t.locators))].sort();

  const file = path.join(outDir, `${area}.md`);
  const L = [`# Existing QA coverage — ${area}\n`];

  L.push(
    "<!-- Generated by ingest-testsuite.mjs. This is a SPECIFICATION,",
    "     not code to port. It records what the QA team already decided",
    "     is worth testing and what they consider correct. Write fresh",
    "     Playwright specs against it, per CONVENTIONS.md. -->\n",
    `${tests.length} existing test cases · ${documented} documented · ${assertions.length} assertions\n`,
  );

  if (assertions.length) {
    L.push("## What the existing suite asserts\n");
    L.push(
      "_Each of these is a statement about correct behaviour, already agreed by " +
        "the QA team. Reuse the intent; do not reuse the locators._\n",
    );
    for (const s of [...new Set(assertions)].slice(0, 60)) L.push(`- \`${s}\``);
    L.push("\n---\n");
  }

  L.push("## Test cases\n");
  for (const t of tests) {
    L.push(`### ${t.name}\n`);
    if (t.doc) L.push(`${t.doc}\n`);
    if (t.tags.length) L.push(`Tags: ${t.tags.join(", ")}\n`);
    L.push(`Source: \`${path.relative(opt.root, t.source).split(path.sep).join("/")}\`\n`);
    if (t.steps.length) {
      L.push("Steps as written:\n");
      L.push("```");
      for (const s of t.steps.slice(0, 25)) L.push(s);
      L.push("```\n");
    }
  }

  if (locators.length) {
    L.push("---\n\n## Locators used — reference only, do not port\n");
    L.push(
      "_Listed because a locator tells you which element mattered to whoever wrote " +
        "the test. The selector strategy itself is replaced: owned data attributes " +
        "for plugins, semantic roles for themes._\n",
    );
    for (const l of locators.slice(0, 40)) L.push(`- \`${l}\``);
    L.push("");
  }

  fs.writeFileSync(file, L.join("\n"));

  index.areas.push({
    area, file: path.relative(opt.out, file).split(path.sep).join("/"),
    tests: tests.length, documented, assertions: assertions.length,
    locators: locators.length, titles: tests.map((t) => t.name),
  });

  console.log(
    `  ${area.padEnd(26)} ${String(tests.length).padStart(3)} tests  ` +
      `${String(documented).padStart(3)} documented  ${String(assertions.length).padStart(3)} assertions`,
  );
}

index.suggested_areas = index.areas.map((a) => a.area);
index.totals = {
  tests: index.areas.reduce((n, a) => n + a.tests, 0),
  documented: index.areas.reduce((n, a) => n + a.documented, 0),
  assertions: index.areas.reduce((n, a) => n + a.assertions, 0),
};

// Tag inventory: lets a human see whether their tags are feature names (worth
// using as areas) or cross-cutting facets, rather than guessing.
const tagCounts = new Map();
for (const t of allTests) {
  for (const tag of t.tags) {
    const k = tag.toLowerCase();
    tagCounts.set(k, (tagCounts.get(k) ?? 0) + 1);
  }
}
index.tags = [...tagCounts.entries()]
  .sort((a, b) => b[1] - a[1])
  .map(([tag, tests]) => ({
    tag, tests, looks_like: LIFECYCLE_TAGS.has(tag) ? "facet" : "feature",
  }));

const ipath = path.join(opt.out, "testcase-index.json");
fs.mkdirSync(opt.out, { recursive: true });
fs.writeFileSync(ipath, JSON.stringify(index, null, 2));

const { tests, documented, assertions } = index.totals;
console.log("\n" + "=".repeat(68));
console.log(`${tests} test cases in ${index.areas.length} areas -> ${outDir}`);
console.log(`${documented} carry documentation · ${assertions} assertions extracted`);
if (allKeywords.length) {
  console.log(
    `${allKeywords.length} shared keywords found — these map to helpers in ` +
      `packages/core, not to individual specs`,
  );
}
const undoc = tests - documented;
if (undoc) {
  console.log(
    `\n${undoc} test cases have no documentation. Their names are all the intent ` +
      `we have\nfor those, so the names carry more weight than usual.`,
  );
}
if (index.tags.length) {
  console.log("\ntags found (areas came from file paths — switch with --area-from tags");
  console.log("if the 'feature' ones below are how you would rather shard):");
  for (const row of index.tags.slice(0, 14)) {
    console.log(`  ${row.tag.padEnd(22)} ${String(row.tests).padStart(3)} tests   ${row.looks_like}`);
  }
}
console.log(`\nindex -> ${ipath}`);
console.log("\nareas_json for the sweep caller:");
console.log(JSON.stringify(index.suggested_areas));
