#!/usr/bin/env node
/**
 * What the product's suite already covers — and, more importantly, what it does
 * not.
 *
 * THIS IS THE COST LEVER. Read `areas_uncovered` before deriving agent missions
 * and spend the budget there. An area with green `@fresh` specs does not need an
 * agent shard: the specs already assert what a shard would go and look at, they
 * do it deterministically, and they do it for runner minutes instead of tokens.
 * An area with no specs is the only place agent exploration buys anything that
 * was not already bought.
 *
 * That sentence is the whole reason this file exists. Nobody should remove
 * `areas_uncovered` later thinking it is decorative — every other field here is
 * reporting, and this one is the decision.
 *
 * Contract: SUITE.md §6.
 *
 * Usage
 *   node scripts/suite-index.mjs
 *   node scripts/suite-index.mjs --pretty
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { resolveQaHome } from "./lib/qa-home.mjs";
import { parseSpecFile, isProTest, isUnlicensedTest } from "./lib/spec-parse.mjs";
import {
  declaredAreas,
  detectProduct,
  loadManifest,
  slugifyArea,
} from "./lib/suite-manifest.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const qaHome = resolveQaHome(here);

const opt = { pretty: false };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--pretty") opt.pretty = true;
  else {
    console.error(`unknown flag: ${a}`);
    process.exit(2);
  }
}

const say = (msg) => console.error(msg);
function emit(payload, code = 0) {
  process.stdout.write(JSON.stringify(payload, null, opt.pretty ? 2 : 0) + "\n");
  process.exit(code);
}

// ---------------------------------------------------------------- the product

const detected = detectProduct(qaHome);
if (!detected.ok) {
  say(detected.detail ?? "");
  emit({ suite: false, reason: detected.reason }, 2);
}
const info = detected.info;
const root = info.root;

const loaded = loadManifest(root);
if (!loaded.present) emit({ suite: false, reason: "no suite manifest" }, 0);
if (loaded.error) {
  say(loaded.error);
  emit({ suite: false, reason: loaded.error }, 2);
}

const m = loaded.manifest;
for (const line of loaded.inferred) say(`inferred  ${line}`);

// ------------------------------------------------------------------ the specs

/** Every spec file under `spec_dir`, whatever extension it actually uses. */
function specFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;

  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name.startsWith(".")) continue;
        walk(p);
      } else if (/\.spec\.[cm]?[jt]sx?$/.test(e.name)) {
        out.push(p);
      }
    }
  };
  walk(dir);
  return out.sort();
}

const files = specFiles(path.join(root, m.spec_dir));
const tests = [];

for (const abs of files) {
  const rel = path.relative(root, abs).split(path.sep).join("/");
  let text;
  try {
    text = fs.readFileSync(abs, "utf8");
  } catch {
    say(`could not read ${rel} — skipped`);
    continue;
  }
  tests.push(...parseSpecFile(text, rel, m.tiers));
}

// ------------------------------------------------------------------- rollups

const byTier = { fresh: 0, demo: 0 };
// The pro axis, counted separately because it is orthogonal to the tier: a spec
// is `@fresh @pro` or `@demo @pro`, never one instead of the other. Reporting it
// as a tier would make the tier counts stop summing to the test count.
const byPro = { pro: 0, free: 0, unlicensed: 0 };
const proByArea = {};
const byArea = {};
const freshByArea = {};
const guards = {};
const fixme = [];

let incompleteDocblocks = 0;
let untaggedTier = 0;
let tierMismatch = 0;
let areaMismatch = 0;
let noArea = 0;

for (const t of tests) {
  byTier[t.tier] = (byTier[t.tier] ?? 0) + 1;

  const pro = isProTest(t.tags ?? []);
  const unlicensed = isUnlicensedTest(t.tags ?? []);
  byPro[pro ? "pro" : unlicensed ? "unlicensed" : "free"] += 1;

  const area = t.area ? slugifyArea(t.area) : null;
  if (area) {
    byArea[area] = (byArea[area] ?? 0) + 1;
    if (pro) proByArea[area] = (proByArea[area] ?? 0) + 1;
    // Only a `@fresh`, non-fixme test counts toward coverage that can displace
    // agent work — see the note on `areas_covered` below.
    if (t.tier === "fresh" && !t.fixme && !t.skip) {
      freshByArea[area] = (freshByArea[area] ?? 0) + 1;
    }
  } else {
    noArea++;
  }

  for (const g of t.guards) {
    (guards[g] ??= []).push(`${t.file}:${t.line}`);
  }

  if (t.fixme) {
    fixme.push({
      title: t.title,
      file: t.file,
      line: t.line,
      guards: t.guards,
      why: t.why,
    });
  }

  if (!t.doc.complete) incompleteDocblocks++;
  if (t.untagged_tier) untaggedTier++;
  if (t.doc.tier_mismatch) tierMismatch++;
  if (t.doc.area_mismatch) areaMismatch++;
}

// ------------------------------------------------------------------ coverage

/**
 * `areas_covered` counts only areas with at least one runnable `@fresh` test.
 *
 * Deliberately stricter than "has any test". A `@demo`-tier spec cannot run on a
 * CI runner and therefore gates nothing; counting it as coverage would tell the
 * agent to skip an area that in practice no automated check ever visits. A
 * `fixme` spec is a placeholder for coverage, not coverage.
 */
const areasCovered = Object.keys(freshByArea).sort();
const declared = declaredAreas(root, info.knowledge).sort();

const areasUncovered = declared.filter((a) => !areasCovered.includes(a));

// Covered in name only: an area whose entire `@fresh` coverage is one or two
// tests is a smoke test, not a suite, and a sweep should still visit it.
const THIN = 3;
const thinnestAreas = areasCovered
  .filter((a) => freshByArea[a] < THIN)
  .sort((a, b) => freshByArea[a] - freshByArea[b]);

// Areas the suite tests that the knowledge file never declared. Usually a typo
// in a tag; occasionally a real area nobody wrote down. Either way, worth seeing.
const areasUndeclared = areasCovered.filter(
  (a) => declared.length > 0 && !declared.includes(a),
);

emit({
  suite: true,
  product: info.slug,
  spec_dir: m.spec_dir,
  spec_files: files.length,
  tests: tests.length,
  by_tier: byTier,
  by_pro: byPro,
  pro_by_area: proByArea,
  by_area: byArea,
  fresh_by_area: freshByArea,
  guards,
  fixme,
  areas_covered: areasCovered,
  areas_uncovered: areasUncovered,
  areas_undeclared: areasUndeclared,
  areas_declared: declared,
  thinnest_areas: thinnestAreas,
  // Hygiene. A suite that cannot say why its tests exist is one refactor away
  // from nobody being able to tell a real failure from a stale one.
  hygiene: {
    incomplete_docblocks: incompleteDocblocks,
    untagged_tier: untaggedTier,
    tests_without_area: noArea,
    docblock_tier_mismatch: tierMismatch,
    docblock_area_mismatch: areaMismatch,
  },
  // Said plainly, because this is the number the platform exists to move.
  note:
    declared.length === 0
      ? "no areas declared in the knowledge file — coverage is unknown, not zero"
      : `spend agent budget on: ${areasUncovered.join(", ") || "(nothing — the suite covers every declared area)"}`,
});
