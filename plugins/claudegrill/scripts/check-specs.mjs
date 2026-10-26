#!/usr/bin/env node
/**
 * Can the specs a PR changed actually be picked up by the suite?
 *
 * The suite selects tests by tag: `@fresh` for the tier, `@<area>` for the scope
 * of a diff, `@pro` for the pro-only half of a pro run. A spec that lacks the
 * tag the selection needs is never run, yet the PR still gets a passed or failed
 * verdict — as if its own fix had been tested. This is the cheap, deterministic
 * check that says so BEFORE a WordPress is booted.
 *
 * Two rules, both about selection and neither about taste:
 *
 *   1. Every test carries an `@area` tag in its title (CONVENTIONS.md, SUITE.md
 *      §3). The title is what `--grep` matches; a docblock `@area` alone does not
 *      select anything. `fixme` and `skip` tests are ignored — they never run.
 *
 *   2. A spec that exists ONLY in the pro repo must be tagged `@pro` (or
 *      `@unlicensed`). The two pro jobs split the matrix: one runs the pro
 *      repo's `@pro` specs, the other runs the FREE repo's suite with pro
 *      installed. A pro-only spec tagged just `@fresh` is skipped by the first
 *      and not present in the second, so no job ever runs it. The caller says
 *      which files are pro-only (`--pro-only`); this script cannot know, because
 *      that takes a look at the free repo.
 *
 * Deterministic, so a script and not a skill (invariant 1). One JSON line on
 * stdout and nothing else (invariant 2's style); exit 0 whether or not the check
 * passes, 2 for a usage error.
 *
 * Usage
 *   node scripts/check-specs.mjs --files a.spec.ts,b.spec.ts
 *   node scripts/check-specs.mjs --files a.spec.ts --pro-only a.spec.ts --product-dir product
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  areaTagsOf,
  isProTest,
  isUnlicensedTest,
  parseSpecFile,
  tagsOf,
} from "./lib/spec-parse.mjs";

const opt = { files: [], proOnly: [], productDir: process.cwd() };
const list = (v) => v.split(",").map((x) => x.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--files") opt.files = list(argv[++i] ?? "");
  else if (a === "--pro-only") opt.proOnly = list(argv[++i] ?? "");
  else if (a === "--product-dir") opt.productDir = path.resolve(argv[++i] ?? ".");
  else {
    console.error(`unknown flag: ${a}`);
    process.exit(2);
  }
}

// The tier tags a product declares; only used to tell a tier tag from an area
// tag, so a missing or unreadable manifest falls back to the defaults.
let tiers = { fresh: "@fresh", demo: "@demo" };
try {
  const m = JSON.parse(
    fs.readFileSync(path.join(opt.productDir, ".themegrill-qa", "suite.json"), "utf8").replace(/^﻿/, ""),
  );
  if (m.tiers) tiers = { ...tiers, ...m.tiers };
} catch {
  /* defaults */
}

/**
 * Tags a test inherits from the `test.describe` blocks around it.
 *
 * Playwright's `--grep` matches the whole title path, so `@blocks` on a describe
 * selects every test inside it exactly as if each title carried it — and several
 * products tag that way (magazine-blocks tags 51 of 51 tests only on describes).
 * Ignoring that would refuse their PRs for a spec that is selected correctly.
 *
 * Returns [{ from, to, tags }] in line numbers. If the end of a block cannot be
 * found it is taken to run to the end of the file. That errs toward "covered",
 * so a parsing doubt can never turn into a refusal.
 */
function describeScopes(text) {
  const src = text.replace(/\r\n/g, "\n");
  const out = [];
  const re =
    /\btest\.describe(?:\.(?:serial|parallel|only|skip|fixme))?\s*\(\s*(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const tags = tagsOf(m[2]);
    if (tags.length === 0) continue;
    const from = src.slice(0, m.index).split("\n").length;

    // The block ends at the first `});` that sits at the describe's own
    // indentation. Counting braces instead was tried and trips over template
    // literals that contain `${...}`; formatted code makes indentation reliable,
    // and no match means "to the end of the file" (see above).
    const lineStart = src.lastIndexOf("\n", m.index) + 1;
    const indent = src.slice(lineStart, m.index).match(/^[ \t]*/)[0];
    let to = Infinity;
    if (/^[ \t]*$/.test(src.slice(lineStart, m.index))) {
      const close = new RegExp(`\\n${indent}\\}\\)[;,]?[ \\t]*(?=\\n|$)`, "g");
      close.lastIndex = re.lastIndex;
      const end = close.exec(src);
      if (end) to = src.slice(0, end.index + 1).split("\n").length;
    }
    out.push({ from, to, tags });
  }
  return out;
}

const proOnly = new Set(opt.proOnly);
const noArea = [];
const proOnlyUntagged = [];
let checked = 0;

for (const rel of opt.files) {
  const abs = path.join(opt.productDir, rel);
  // A deleted spec has nothing to select.
  if (!fs.existsSync(abs)) continue;
  let text;
  try {
    text = fs.readFileSync(abs, "utf8");
  } catch {
    continue;
  }
  const scopes = describeScopes(text);
  for (const t of parseSpecFile(text, rel, tiers)) {
    if (t.fixme || t.skip) continue;
    checked++;
    const where = { file: rel, line: t.line, title: t.title };
    const inherited = scopes.filter((d) => d.from <= t.line && t.line <= d.to).flatMap((d) => d.tags);
    const tags = [...t.tags, ...inherited];
    if (areaTagsOf(tags, tiers).length === 0) noArea.push(where);
    if (proOnly.has(rel) && !isProTest(tags) && !isUnlicensedTest(tags)) proOnlyUntagged.push(where);
  }
}

console.log(
  JSON.stringify({
    ok: noArea.length === 0 && proOnlyUntagged.length === 0,
    checked,
    no_area: noArea,
    pro_only_untagged: proOnlyUntagged,
  }),
);
