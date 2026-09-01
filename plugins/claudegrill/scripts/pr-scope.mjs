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

out({
  ok: true,
  run: areas.length > 0,
  areas,
  changed: cf.files.length,
  specs: r.specs ?? [],
  unmapped: gaps,
  would_have_run_full: Boolean(r.full),
  reason: areas.length
    ? `${cf.files.length} changed file(s) map to ${areas.length} area(s): ${areas.join(", ")}`
    : `${cf.files.length} changed file(s) map to no spec area — nothing to run`,
});
