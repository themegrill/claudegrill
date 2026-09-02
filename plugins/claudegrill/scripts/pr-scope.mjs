#!/usr/bin/env node
/**
 * What does this pull request's diff actually touch, and is there anything to run?
 *
 * The policy this implements is deliberate and it is NOT the conservative one.
 * Earlier, a changed file matching no `area_paths` pattern forced the whole
 * `@fresh` tier — silence cost runner time, never coverage. On a metered private
 * repo that turned every unmapped change into three full Playground runs, which
 * is how a single push reached ninety minutes.
 *
 * So: a PR run now tests EXACTLY what the diff maps to, and when the diff maps
 * to nothing it runs nothing at all rather than everything. The cost of that
 * trade is real — an unmapped file ships unchecked — so this reports the
 * unmapped files explicitly and the workflow prints them. A gap that is visible
 * on every PR gets an `area_paths` entry; a gap hidden behind a full run does
 * not.
 *
 * The diff repo and the suite repo are not always the same. `free-with-pro`
 * runs the FREE product's specs against a change made in the PRO repo, so the
 * areas come from the pro diff and are then applied to the free suite. Both
 * repos share one area vocabulary, which is what makes that legal.
 *
 * Usage
 *   node scripts/pr-scope.mjs --diff-root <path> --since <ref>
 *
 * Emits one JSON object. Exit 0 always — "nothing to run" is an answer, not a
 * failure, and a workflow needs to read the reason rather than a status code.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { affectedAreas, changedFiles } from "./lib/affected.mjs";
import { parseSpecFile } from "./lib/spec-parse.mjs";
import { loadManifest } from "./lib/suite-manifest.mjs";

const opt = { diffRoot: process.cwd(), since: null };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--diff-root") opt.diffRoot = argv[++i];
  else if (a === "--since") opt.since = argv[++i];
  else {
    out({ ok: false, run: false, reason: `unknown flag: ${a}` });
    process.exit(2);
  }
}

function out(o) {
  process.stdout.write(JSON.stringify(o) + "\n");
}

const root = path.resolve(opt.diffRoot);

if (!opt.since) {
  // No base ref means this is not a pull request. Saying "run everything" here
  // would reintroduce exactly the cost this script exists to remove, so the
  // caller decides instead.
  out({ ok: true, run: false, areas: [], reason: "no --since given: not a pull request" });
  process.exit(0);
}

const m = loadManifest(root);
if (!m.manifest) {
  out({ ok: false, run: false, areas: [], reason: m.error ?? "no suite manifest in the diff repo" });
  process.exit(0);
}

const cf = changedFiles(root, opt.since);
if (!cf.ok) {
  // A diff we could not compute is not the same as an empty diff, and quietly
  // running nothing would hide a broken base ref behind a green tick.
  out({
    ok: false,
    run: false,
    areas: [],
    reason: `could not diff against ${opt.since} — check the base ref and fetch depth`,
  });
  process.exit(0);
}

/**
 * A changed spec speaks for its own area, but only if something reads its tags.
 * `affectedAreas` takes that index rather than parsing, so build it here from
 * the specs the diff actually touched — a few files, not the whole suite.
 */
const specIndex = [];
for (const rel of cf.files) {
  if (!/\.spec\.[cm]?[jt]sx?$/.test(rel.split(path.sep).join("/"))) continue;
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) continue; // deleted in this diff
  try {
    for (const t of parseSpecFile(fs.readFileSync(abs, "utf8"), rel, m.manifest.tiers)) {
      if (t.area) specIndex.push({ file: rel, area: t.area });
    }
  } catch {
    /* a spec we cannot parse contributes no area; the file still shows as changed */
  }
}

const r = affectedAreas(cf.files, m.manifest, specIndex);

// `r.full` means "an unmapped file changed, so run everything" — the behaviour
// this policy replaces. The areas it did map are still correct, so use those and
// report the rest as a gap.
const areas = r.areas ?? [];
const gaps = [...(r.unmapped ?? []), ...(r.harness ?? [])];
const specs = r.specs ?? [];

/**
 * Can this run be narrowed from AREAS to the individual SPEC FILES the branch
 * changed?
 *
 * The premise is the team's own workflow: the developer runs /verify-fix while
 * writing the fix, write-spec commits the guard onto the same branch, and CI
 * sees a diff that already contains the deterministic assertion for the change.
 * When that is what the diff looks like, those spec files ARE the check, and
 * running every other spec that happens to share their area is paying for
 * coverage the branch did not touch.
 *
 * Two conditions, and both are load-bearing:
 *
 *   1. The diff changed at least one spec file. A source-only diff has no
 *      committed guard, so it falls back to areas — otherwise a fix pushed
 *      without a spec would run NOTHING, which is worse than what this replaces.
 *   2. The harness did not change. A changed fixture or config can break any
 *      spec, so narrowing to the ones the diff names would be exactly wrong;
 *      `affectedAreas` already forces the full tier for that case and this must
 *      not undercut it.
 *
 * The trade is stated rather than hidden: an existing spec in a touched area
 * that the branch did not edit will NOT run in this mode. That is a real
 * reduction in coverage per PR, taken deliberately to keep a run inside its
 * ceiling, and `areas` is still emitted so a caller can choose otherwise.
 */
const harnessChanged = (r.harness ?? []).length > 0;
const specMode = specs.length > 0 && !harnessChanged;

out({
  ok: true,
  run: areas.length > 0 || specs.length > 0,
  // What a caller SHOULD narrow to, given the diff. The caller still decides:
  // suite.yml honours it only under `scope: specs`.
  mode: specMode ? "specs" : "areas",
  areas,
  changed: cf.files.length,
  specs,
  // The specs a `mode: "specs"` run would skip that an `areas` run would have
  // executed cannot be known here without indexing the whole suite, so the
  // areas are reported instead and the workflow names them in its summary.
  unmapped: gaps,
  would_have_run_full: Boolean(r.full),
  reason: specMode
    ? `${cf.files.length} changed file(s) include ${specs.length} spec file(s): ${specs.join(", ")}`
    : areas.length
      ? `${cf.files.length} changed file(s) map to ${areas.length} area(s): ${areas.join(", ")}`
      : `${cf.files.length} changed file(s) map to no spec area — nothing to run`,
});
