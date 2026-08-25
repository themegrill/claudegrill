/**
 * Read Playwright specs as text and pull out what the platform needs to know.
 *
 * Regex over source, deliberately — there is no TypeScript parser anywhere in
 * this repo and there will not be one. The whole platform's dependency budget is
 * zero, and a parser would be the largest dependency in it, bought to extract
 * five string fields.
 *
 * The cost of that choice is that this is tolerant rather than exact: a missing
 * field is `null`, an unparseable file yields no tests rather than an exception,
 * and a test title built by string concatenation will be recorded as whatever
 * literal opened it. Callers surface the incomplete count so the inaccuracy is
 * visible rather than assumed away.
 *
 * Contract: SUITE.md §3.
 */

/** Tags as Playwright sees them — bare `@word` runs in the test title. */
export function tagsOf(title) {
  return (title.match(/@[\w-]+/g) ?? []).map((t) => t.toLowerCase());
}

/**
 * Which tier a test belongs to.
 *
 * The conservative reading, and the reason it is written down twice: **an
 * untagged test is `demo`, never `fresh`.** A test nobody tiered was written
 * against whatever site its author had, and assuming that was a clean one is how
 * a green CI run becomes a lie.
 */
export function tierOf(tags, tiers = { fresh: "@fresh", demo: "@demo" }) {
  const fresh = String(tiers.fresh ?? "@fresh").toLowerCase();
  const demo = String(tiers.demo ?? "@demo").toLowerCase();
  if (tags.includes(fresh)) return "fresh";
  if (tags.includes(demo)) return "demo";
  return "demo";
}

/** Tags that are not the tier — `@header`, `@customizer`, and so on. */
export function areaTagsOf(tags, tiers = { fresh: "@fresh", demo: "@demo" }) {
  const tierTags = new Set(
    [tiers.fresh ?? "@fresh", tiers.demo ?? "@demo"].map((t) =>
      String(t).toLowerCase(),
    ),
  );
  return tags.filter((t) => !tierTags.has(t));
}

/**
 * The docblock immediately above an offset, if there is one.
 *
 * "Immediately" means nothing but whitespace between the closing `* /` and the
 * `test(` call. A docblock separated by another statement belongs to that
 * statement, not to this test, and attaching it here would silently mislabel it.
 */
function docblockAbove(text, offset) {
  const before = text.slice(0, offset);
  const close = before.lastIndexOf("*/");
  if (close === -1) return null;
  if (/[^\s]/.test(before.slice(close + 2))) return null;

  const open = before.lastIndexOf("/**", close);
  if (open === -1) return null;

  return before.slice(open, close + 2);
}

/** One `@field` out of a docblock, with continuation lines folded in. */
function docField(block, field) {
  if (!block) return null;

  // Strip the block's own delimiters before stripping per-line asterisks.
  // Doing it the other way round leaves the closing `*/` as a bare `/`, which
  // then folds into the last continuation line — confirmed against the fixture,
  // where a `@why` came back ending in " /".
  const lines = block
    .replace(/^\s*\/\*+/, "")
    .replace(/\*+\/\s*$/, "")
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*\*?\s?/, ""));
  const start = lines.findIndex((l) => new RegExp(`^@${field}\\b`).test(l));
  if (start === -1) return null;

  const parts = [lines[start].replace(new RegExp(`^@${field}\\s*`), "")];
  // Continuation: subsequent lines that do not open another @field.
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^@[\w-]+\b/.test(l) || /^\s*\/?\*+\/?\s*$/.test(l)) break;
    if (l.trim() === "") break;
    parts.push(l.trim());
  }

  const value = parts.join(" ").trim();
  return value === "" ? null : value;
}

/**
 * Every test declared in one spec file.
 *
 * Matches `test(`, `test.fixme(`, `test.skip(` and `test.only(` followed by a
 * quoted title. `test.describe` is deliberately excluded: a describe block is
 * not a test and counting it as one inflates every coverage number that follows.
 */
export function parseSpecFile(text, relPath, tiers) {
  const out = [];
  const src = text.replace(/\r\n/g, "\n");

  // The leading `(^|[\n;{}])` requires the `test` token to be in statement
  // position. Without it a string that merely contains `test('…')` — a fixture
  // building source code, a comment quoting a spec — is counted as a test.
  // Confirmed against the fixture: a `const weird = "test('… @nope'"` line
  // invented a whole `nope` area out of nothing.
  const re =
    /(^|[\n;{}])\s*\btest(?:\.(fixme|skip|only|serial|concurrent))?\s*\(\s*(['"`])((?:\\.|(?!\3)[\s\S])*?)\3/g;

  let m;
  while ((m = re.exec(src)) !== null) {
    const modifier = m[2] ?? null;
    const title = m[4].replace(/\\(['"`\\])/g, "$1");
    // Offset of the `test` token itself, not of the prefix character, so the
    // line number and the docblock lookup both anchor where a reader would.
    const tokenAt = m.index + m[0].indexOf("test");
    const line = src.slice(0, tokenAt).split("\n").length;

    const tags = tagsOf(title);
    const block = docblockAbove(src, tokenAt);

    const guardsRaw = docField(block, "guards");
    const guards = guardsRaw
      ? guardsRaw
          .split(/[,\s]+/)
          .map((g) => g.trim())
          .filter(Boolean)
      : [];

    const docArea = docField(block, "area");
    const docTier = docField(block, "tier");
    const why = docField(block, "why");
    const source = docField(block, "source");

    const areaTags = areaTagsOf(tags, tiers);
    const titleTier = tierOf(tags, tiers);

    out.push({
      title,
      file: relPath,
      line,
      tags,
      // The title is authoritative for tier and area, because the title is what
      // `--grep` actually selects on. The docblock is checked against it and a
      // disagreement is reported, never silently resolved in either direction.
      tier: titleTier,
      area: areaTags[0] ?? docArea ?? null,
      area_tags: areaTags,
      guards,
      why,
      source,
      fixme: modifier === "fixme",
      skip: modifier === "skip",
      only: modifier === "only",
      doc: {
        area: docArea,
        tier: docTier,
        has_why: Boolean(why),
        // Hygiene, not correctness: these are what a reviewer would ask for.
        complete: Boolean(why) && Boolean(docArea) && Boolean(docTier),
        tier_mismatch: Boolean(docTier) && docTier.toLowerCase() !== titleTier,
        area_mismatch:
          Boolean(docArea) &&
          areaTags.length > 0 &&
          !areaTags.includes(`@${docArea.toLowerCase()}`),
      },
      untagged_tier: !tags.some((t) =>
        [
          String(tiers?.fresh ?? "@fresh").toLowerCase(),
          String(tiers?.demo ?? "@demo").toLowerCase(),
        ].includes(t),
      ),
    });
  }

  return out;
}
