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

/**
 * The feature a spec file represents.
 *
 * A feature IS a spec file — there is no `@feature` tag and there must not be
 * one. The suite already carries two taxonomies that disagree (the directory a
 * spec sits in, and its `@area` tag: ColorMag has
 * `specs/demo-importer/header-logo-sizing-regression.spec.ts` tagged `@header`),
 * and a third hand-maintained one would be a third thing to get out of sync.
 *
 * So the file is the identity and the name is derived from its basename. That
 * makes the name only as good as the filename — which is the point: a file
 * called `cmag-650-fix` reports itself as a badly named feature in
 * `feature_hygiene.issue_named_specs` instead of hiding behind a tidy tag.
 *
 * Contract: SUITE.md §6, CONVENTIONS.md rule 11.
 */
function featureOf(relPath) {
  const base = relPath
    .split("/")
    .pop()
    .replace(/\.spec\.[cm]?[jt]sx?$/, "");
  return slugifyArea(base);
}

/**
 * Does this filename name an issue rather than a behaviour?
 *
 * An issue key in the name — `#123`, `issue-123`, or a pre-GitHub Jira key —
 * or a `-regression` / `-fix` / `-bug` suffix. Both say
 * the file was created by a ticket rather than by a feature, which is the drift
 * CONVENTIONS.md rule 11 exists to stop. Reported, never enforced: renaming a
 * file that CI and `area_paths` already reference is a human decision.
 */
function looksIssueNamed(feature) {
  return (
    /(^|-)[a-z]{2,}-\d+(-|$)/.test(feature) ||
    /-(regression|regressions|fix|fixes|bug|bugs|issue)$/.test(feature)
  );
}

const files = specFiles(path.join(root, m.spec_dir));
const tests = [];

// Read separately from `files` so a file that parsed to zero tests still counts
// as a feature. "Which spec owns this?" must not answer "none" because a spec
// was mangled — that is exactly when the agent is about to write a duplicate.
const readFiles = [];

for (const abs of files) {
  const rel = path.relative(root, abs).split(path.sep).join("/");
  let text;
  try {
    text = fs.readFileSync(abs, "utf8");
  } catch {
    say(`could not read ${rel} — skipped`);
    continue;
  }
  readFiles.push(rel);
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

// ------------------------------------------------------------------ features

/**
 * Feature -> the scenarios inside it. The lookup `write-spec` runs before it
 * writes anything.
 *
 * Every other rollup here is a count, which answers "how much is covered". This
 * one carries the individual test titles, which is the only thing that answers
 * "is THIS behaviour covered" — and that question is what stops a second spec
 * being written for a bug the suite already guards. The `guards` map above
 * cannot answer it: it is keyed by issue, so it only ever finds the
 * duplicate AFTER somebody has filed the same behaviour under a second key.
 *
 * Keyed by spec file, because the file is the feature's identity (see
 * `featureOf`). Deliberately the only place in this payload that lists tests
 * individually; everything else stays a count so the JSON does not grow with
 * the suite without reason.
 */
const features = {};

for (const rel of readFiles) {
  features[rel] = {
    feature: featureOf(rel),
    areas: [],
    tests: 0,
    fresh: 0,
    guards: [],
    scenarios: [],
  };
}

for (const t of tests) {
  // A test in a file that could not be read cannot happen, but a caller passing
  // a hand-built list could; seed rather than throw.
  const f = (features[t.file] ??= {
    feature: featureOf(t.file),
    areas: [],
    tests: 0,
    fresh: 0,
    guards: [],
    scenarios: [],
  });

  f.tests += 1;
  if (t.tier === "fresh" && !t.fixme && !t.skip) f.fresh += 1;

  for (const a of t.area_tags ?? []) {
    const area = slugifyArea(a);
    if (area && !f.areas.includes(area)) f.areas.push(area);
  }
  for (const g of t.guards) if (!f.guards.includes(g)) f.guards.push(g);

  f.scenarios.push({
    title: t.title,
    line: t.line,
    tier: t.tier,
    area: t.area ? slugifyArea(t.area) : null,
    guards: t.guards,
    pro: isProTest(t.tags ?? []),
    fixme: t.fixme,
    skip: t.skip,
  });
}

for (const f of Object.values(features)) {
  f.areas.sort();
  f.guards.sort();
}

// Area -> the spec files covering it. "Which spec owns this feature?" asked from
// the other direction, which is the direction a finding arrives from: you know
// the area the diff touched, not the filename.
const featuresByArea = {};
for (const [rel, f] of Object.entries(features)) {
  for (const area of f.areas) (featuresByArea[area] ??= []).push(rel);
}
for (const list of Object.values(featuresByArea)) list.sort();

/**
 * The rule-11 migration backlog, reported the way `areas_uncovered` is.
 *
 * Neither list is a defect on its own — a feature can legitimately hold one
 * scenario, and a file named after a ticket still runs. They are where the suite
 * stops describing the product and starts describing its bug history, and they
 * are what a spec touching that area should fold itself into rather than sit
 * beside.
 */
const issueNamedSpecs = Object.entries(features)
  .filter(([, f]) => looksIssueNamed(f.feature))
  .map(([rel]) => rel)
  .sort();

const singleScenarioSpecs = Object.entries(features)
  .filter(([, f]) => f.tests === 1)
  .map(([rel]) => rel)
  .sort();

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
  // The feature layer — CONVENTIONS.md rule 11. Read `features` before writing a
  // spec: it is what tells you whether the behaviour already has a scenario.
  features,
  features_by_area: featuresByArea,
  feature_hygiene: {
    issue_named_specs: issueNamedSpecs,
    single_scenario_specs: singleScenarioSpecs,
  },
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
