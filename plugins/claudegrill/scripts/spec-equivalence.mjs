#!/usr/bin/env node
/**
 * Did a spec migration lose anything?
 *
 * `rewrite-spec` moves scenarios between files, merges bug-named specs into
 * feature specs and renames them. Every one of those operations can silently
 * drop coverage: a `@guards` key left behind in a deleted file, a scenario that
 * quietly became `@demo` when it was `@fresh`, an area that no longer has a
 * spec. None of that shows up as a failing test — the suite goes green with less
 * in it, which is the one outcome a migration must never produce.
 *
 * So this is the gate, and it is deliberately a SCRIPT rather than a judgement:
 * comparing two JSON payloads field by field is exactly the predictable work
 * CLAUDE.md invariant 1 says must not live in a skill. An agent asked to "check
 * nothing was lost" will check the things it happens to think of.
 *
 * It compares two `suite-index.mjs` payloads — before and after — and fails on
 * any LOSS. Gains are fine and reported: merging two scenarios into one strong
 * one reduces the test count on purpose, which is why the test count is a
 * warning and the guard set is an error.
 *
 * Usage
 *   node scripts/spec-equivalence.mjs --snapshot .themegrill-qa/spec-baseline.json
 *   node scripts/spec-equivalence.mjs --check    .themegrill-qa/spec-baseline.json
 *   node scripts/spec-equivalence.mjs --check before.json --after after.json
 *   node scripts/spec-equivalence.mjs --check base.json --merged "<the title folded away>"
 *
 * `--merged` is how a deliberate merge passes. It is repeatable, and it takes the
 * title that no longer exists — so folding two scenarios into one is allowed, but
 * only by NAMING what went. Without it a merge fails the gate, which would train
 * a reader to ignore the gate; with a free pass it would accept any loss at all.
 * Naming it is the only version of this that stays meaningful, and it leaves the
 * decision in the commit where a reviewer can read it.
 *
 * Exit codes
 *   0  nothing lost
 *   1  something was lost — the detail says what
 *   2  could not run (no suite, bad file, no baseline)
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

const opt = { mode: null, file: null, after: null, json: false, merged: [] };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--snapshot") {
    opt.mode = "snapshot";
    opt.file = argv[++i] ?? null;
  } else if (a === "--check") {
    opt.mode = "check";
    opt.file = argv[++i] ?? null;
  } else if (a === "--after") opt.after = argv[++i] ?? null;
  else if (a === "--merged") opt.merged.push(argv[++i] ?? "");
  else if (a === "--json") opt.json = true;
  else {
    console.error(`unknown flag: ${a}`);
    process.exit(2);
  }
}

if (!opt.mode || !opt.file) {
  console.error("usage: spec-equivalence.mjs --snapshot <file> | --check <file> [--after <file>]");
  process.exit(2);
}

const say = (m) => !opt.json && console.error(m);

/** The live index, via the one script that owns that contract. */
function liveIndex() {
  let out;
  try {
    out = execFileSync(process.execPath, [path.join(here, "suite-index.mjs")], {
      encoding: "utf8",
      // The index writes its own notes to stderr; they are not ours to relay.
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (e) {
    // A non-zero exit still prints a payload on stdout — "no suite" is a result,
    // not a crash, and the caller needs to be told which it was.
    out = e.stdout ?? "";
  }
  const line = out.trim().split("\n").pop() ?? "";
  try {
    return JSON.parse(line);
  } catch {
    console.error("could not read suite-index.mjs output");
    process.exit(2);
  }
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    console.error(`could not read ${p}: ${e.message}`);
    process.exit(2);
  }
}

// ------------------------------------------------------------------ snapshot

if (opt.mode === "snapshot") {
  const idx = liveIndex();
  if (!idx.suite) {
    console.error(`no suite to snapshot: ${idx.reason ?? "unknown"}`);
    process.exit(2);
  }
  fs.mkdirSync(path.dirname(path.resolve(opt.file)), { recursive: true });
  fs.writeFileSync(opt.file, JSON.stringify(idx, null, 2) + "\n");
  say(
    `baseline written: ${opt.file} — ${idx.spec_files} files, ${idx.tests} tests, ` +
      `${Object.keys(idx.guards).length} guarded keys`,
  );
  if (opt.json) process.stdout.write(JSON.stringify({ ok: true, baseline: opt.file }) + "\n");
  process.exit(0);
}

// --------------------------------------------------------------------- check

const before = readJson(opt.file);
const after = opt.after ? readJson(opt.after) : liveIndex();

if (!before.suite || !after.suite) {
  console.error("one side has no suite — nothing to compare");
  process.exit(2);
}

/**
 * Every `@guards` key on either side.
 *
 * This is the load-bearing comparison. A key present before and absent after
 * means a regression that was guarded is now unguarded, and the suite is green
 * either way — the exact failure this script exists to catch.
 */
const keysOf = (idx) => new Set(Object.keys(idx.guards ?? {}));

/** Scenario titles, tier-stripped, so a moved test is recognised as the same test. */
function titlesOf(idx) {
  const out = new Map();
  for (const f of Object.values(idx.features ?? {})) {
    for (const sc of f.scenarios ?? []) {
      out.set(normalise(sc.title), { tier: sc.tier, fixme: sc.fixme, skip: sc.skip });
    }
  }
  return out;
}

/**
 * A title reduced to its behaviour.
 *
 * Tags come off because a migration legitimately moves them, and whitespace and
 * case are normalised because reflowing a long title is not a change in what it
 * asserts. Anything beyond that — a reworded title — reads as a lost scenario
 * and a new one, which is the conservative direction: it asks a human to confirm
 * rather than accepting the rename silently.
 */
function normalise(title) {
  return title
    .replace(/@[\w-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const errors = [];
const warnings = [];

// 1. Guard keys. Losing one is always an error.
const kb = keysOf(before);
const ka = keysOf(after);
const lostKeys = [...kb].filter((k) => !ka.has(k)).sort();
const newKeys = [...ka].filter((k) => !kb.has(k)).sort();
if (lostKeys.length) {
  errors.push(
    `${lostKeys.length} @guards key(s) no longer appear anywhere in the suite: ${lostKeys.join(", ")}`,
  );
}

// 2. Scenarios, by behaviour rather than by path — a move is not a loss.
const tb = titlesOf(before);
const ta = titlesOf(after);
const allowedGone = new Set(opt.merged.map(normalise).filter(Boolean));
const goneTitles = [...tb.keys()].filter((t) => !ta.has(t));
const lostTitles = goneTitles.filter((t) => !allowedGone.has(t));
const mergedTitles = goneTitles.filter((t) => allowedGone.has(t));

// A `--merged` title that is still present means the claim does not match the
// tree. Reported, because a wrong claim here is how a real loss gets waved past
// on the next run by a flag somebody copied from the last one.
const staleMerged = [...allowedGone].filter((t) => ta.has(t) || !tb.has(t));

if (lostTitles.length) {
  errors.push(
    `${lostTitles.length} scenario(s) present before and absent after:\n` +
      lostTitles.map((t) => `    - ${t}`).join("\n") +
      `\n  If one was deliberately folded into another, pass it as` +
      `\n  --merged "<title>" so the decision is stated rather than inferred.`,
  );
}
if (staleMerged.length) {
  warnings.push(
    `--merged named ${staleMerged.length} title(s) that did not disappear: ` +
      staleMerged.join(" | ") +
      `. Check the flag matches what you actually did.`,
  );
}
if (mergedTitles.length) {
  warnings.push(
    `${mergedTitles.length} scenario(s) folded away by declaration: ` +
      mergedTitles.join(" | ") +
      `. Their @guards keys are still checked above and must survive.`,
  );
}

// 3. Tier demotion. `@fresh` -> `@demo` takes a spec out of CI without failing it.
const demoted = [...tb.entries()]
  .filter(([t, b]) => ta.has(t) && b.tier === "fresh" && ta.get(t).tier !== "fresh")
  .map(([t]) => t);
if (demoted.length) {
  errors.push(
    `${demoted.length} scenario(s) dropped out of the @fresh tier — they no longer gate a PR:\n` +
      demoted.map((t) => `    - ${t}`).join("\n"),
  );
}

// 4. Newly skipped. A scenario that became `fixme`/`skip` still reports as present.
const silenced = [...tb.entries()]
  .filter(([t, b]) => {
    const a = ta.get(t);
    return a && !b.fixme && !b.skip && (a.fixme || a.skip);
  })
  .map(([t]) => t);
if (silenced.length) {
  errors.push(
    `${silenced.length} scenario(s) became fixme/skip — present but no longer asserting:\n` +
      silenced.map((t) => `    - ${t}`).join("\n"),
  );
}

// 5. Areas. An area that had runnable @fresh coverage and now has none.
const lostAreas = (before.areas_covered ?? []).filter(
  (a) => !(after.areas_covered ?? []).includes(a),
);
if (lostAreas.length) {
  errors.push(`area(s) lost all runnable @fresh coverage: ${lostAreas.join(", ")}`);
}

// 6. Counts. A drop is legitimate when scenarios were merged, so it warns.
if (after.tests < before.tests) {
  warnings.push(
    `test count fell ${before.tests} -> ${after.tests}. Legitimate if scenarios were ` +
      `merged (two findings, one behaviour, both keys on one scenario) — say which in the report.`,
  );
}
if (after.hygiene?.incomplete_docblocks > (before.hygiene?.incomplete_docblocks ?? 0)) {
  warnings.push(
    `incomplete docblocks rose ${before.hygiene.incomplete_docblocks} -> ` +
      `${after.hygiene.incomplete_docblocks}. A migrated scenario keeps its @why.`,
  );
}

const ok = errors.length === 0;
const payload = {
  ok,
  before: { files: before.spec_files, tests: before.tests, keys: kb.size },
  after: { files: after.spec_files, tests: after.tests, keys: ka.size },
  lost_guards: lostKeys,
  new_guards: newKeys,
  lost_scenarios: lostTitles,
  merged_away: mergedTitles,
  demoted_from_fresh: demoted,
  newly_skipped: silenced,
  lost_areas: lostAreas,
  errors,
  warnings,
};

if (opt.json) {
  process.stdout.write(JSON.stringify(payload) + "\n");
  process.exit(ok ? 0 : 1);
}

console.log(
  `files ${before.spec_files} -> ${after.spec_files} · ` +
    `tests ${before.tests} -> ${after.tests} · ` +
    `guarded keys ${kb.size} -> ${ka.size}`,
);
for (const w of warnings) console.log(`warning  ${w}`);
if (ok) {
  console.log("EQUIVALENT — nothing lost." + (newKeys.length ? ` new keys: ${newKeys.join(", ")}` : ""));
  process.exit(0);
}
for (const e of errors) console.log(`LOST     ${e}`);
console.log(
  "\nThe migration dropped coverage. Restore it before committing — a green suite " +
    "with less in it is the one outcome this gate exists to stop.",
);
process.exit(1);
