/**
 * Which areas a diff could have broken.
 *
 * Deterministic, so it lives in a script and not in a skill (invariant 1). A
 * machine cannot infer that `inc/colormag-wp-query.php` relates to the
 * `content` area — somebody has to say so. That mapping is `area_paths` in the
 * product's `.themegrill-qa/suite.json`:
 *
 *   "area_paths": {
 *     "header":  ["inc/customizer/options/header/**", "template-parts/header/**"],
 *     "content": ["inc/colormag-wp-query.php", "template-parts/content/**"]
 *   }
 *
 * THE SAFETY RULE, and the reason this is trustworthy: **a changed file that
 * matches no pattern means run everything.** Narrowing on a diff nobody mapped
 * is how a change ships with zero coverage and a green tick over it. Silence
 * must cost time, never coverage.
 *
 * Contract: SUITE.md §2.
 */

import { execFileSync } from "node:child_process";
import path from "node:path";

/** Files changed between `since` and the working tree. */
export function changedFiles(root, since) {
  const run = (args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split(/\r?\n/)
      .filter(Boolean);

  const out = new Set();
  try {
    // `A...B` is the merge-base diff — what this branch changed, not what the
    // base branch moved on to. Blaming a PR for the base's commits is the
    // fastest way to lose trust in a check.
    for (const f of run(["diff", "--name-only", `${since}...HEAD`])) out.add(f);
  } catch {
    try {
      for (const f of run(["diff", "--name-only", since])) out.add(f);
    } catch {
      return { ok: false, files: [] };
    }
  }

  // Uncommitted work counts too, for the local case.
  try {
    for (const f of run(["diff", "--name-only", "HEAD"])) out.add(f);
  } catch {
    /* no HEAD yet */
  }

  return { ok: true, files: [...out] };
}

/**
 * Glob to RegExp. Supports `**`, `*` and `?`; everything else is literal.
 *
 * Deliberately small — the patterns here are repo paths written by hand, not
 * user input, and a dependency for this would be the largest in the project.
 */
export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**/` crosses directories; a trailing `**` matches the rest.
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

const SOURCE_EXT = /\.(php|js|jsx|ts|tsx|mjs|cjs|scss|sass|css)$/i;

/**
 * Map changed files onto areas.
 *
 * @returns {{areas: string[], unmapped: string[], specs: string[], full: boolean, reason: string}}
 */
export function affectedAreas(files, manifest, specIndex = []) {
  const areaPaths = manifest.area_paths ?? {};
  const specDir = String(manifest.spec_dir ?? "").replace(/\/+$/, "");

  const areas = new Set();
  const unmapped = [];
  const specs = [];
  const harness = [];

  const compiled = Object.entries(areaPaths).map(([area, patterns]) => [
    area,
    (Array.isArray(patterns) ? patterns : [patterns]).map(globToRegExp),
  ]);

  for (const file of files) {
    const posix = file.split(path.sep).join("/");

    // A changed spec speaks for itself: run its own area.
    if (
      /\.spec\.[cm]?[jt]sx?$/.test(posix) ||
      (specDir && posix.startsWith(`${specDir}/`))
    ) {
      specs.push(posix);
      for (const t of specIndex) {
        if (t.file === posix && t.area) areas.add(String(t.area).replace(/^@/, ""));
      }
      continue;
    }

    // Test-harness files — fixtures, setup, config, helpers under tests/ that
    // are not themselves specs. A broken fixture can break ANY spec, so these
    // force the full tier. They are tracked separately from unmapped product
    // source because the reason matters: "the harness changed" is a different
    // message from "nobody mapped this file", and conflating them sends people
    // to edit area_paths when the answer is that a fixture moved.
    if (/(^|\/)tests?\//i.test(posix)) {
      if (SOURCE_EXT.test(posix)) harness.push(posix);
      continue;
    }

    // Only product source can break a spec. Docs, translations and CI config
    // cannot, and treating them as unmapped would run the full suite on a typo.
    if (!SOURCE_EXT.test(posix)) continue;

    let matched = false;
    for (const [area, regexes] of compiled) {
      if (regexes.some((r) => r.test(posix))) {
        areas.add(area);
        matched = true;
      }
    }
    if (!matched) unmapped.push(posix);
  }

  if (Object.keys(areaPaths).length === 0) {
    return {
      areas: [],
      unmapped,
      harness,
      specs,
      full: true,
      reason:
        "the manifest declares no area_paths, so nothing can be narrowed safely",
    };
  }

  if (harness.length > 0) {
    return {
      areas: [...areas],
      unmapped,
      harness,
      specs,
      full: true,
      reason: `the test harness changed (${harness.slice(0, 3).join(", ")}${harness.length > 3 ? ", …" : ""}), which can affect any spec`,
    };
  }

  if (unmapped.length > 0) {
    return {
      areas: [...areas],
      unmapped,
      harness,
      specs,
      full: true,
      reason: `${unmapped.length} changed source file(s) match no area_paths pattern: ${unmapped
        .slice(0, 5)
        .join(", ")}${unmapped.length > 5 ? ", …" : ""}`,
    };
  }

  if (areas.size === 0) {
    return {
      areas: [],
      unmapped,
      harness,
      specs,
      full: false,
      reason: "no product source changed",
    };
  }

  return {
    areas: [...areas],
    unmapped,
    harness,
    specs,
    full: false,
    reason: `mapped to ${areas.size} area(s)`,
  };
}

/**
 * Specs that name a Jira key, so a fix for CMAG-1234 always runs the spec
 * guarding CMAG-1234 whatever area it happens to live in.
 */
export function areasGuarding(ticket, specIndex) {
  if (!ticket) return [];
  const out = new Set();
  for (const t of specIndex) {
    if ((t.guards ?? []).some((g) => g.toUpperCase() === ticket.toUpperCase())) {
      if (t.area) out.add(String(t.area).replace(/^@/, ""));
    }
  }
  return [...out];
}
