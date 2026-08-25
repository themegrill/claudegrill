/**
 * Where this plugin lives on disk.
 *
 * Extracted from `boot-wp.mjs` so `run-suite.mjs` cannot drift from it. Two
 * scripts resolving the plugin root by two slightly different rules is the kind
 * of difference that only shows up on the one machine where the layout is
 * unusual, which is the worst possible time to find it.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

/**
 * The plugin root — the directory holding `scripts/` and `blueprints/`.
 *
 * Resolved from the calling file's own location first, which is correct whether
 * we are running from an installed plugin (the Claude Code plugin cache), a git
 * clone, or a CI checkout. `THEMEGRILL_QA_HOME` is honoured only as a fallback,
 * and tolerates being pointed at either the plugin directory or the repository
 * root above it, because both are things people reasonably set it to.
 *
 * @param {string} here  the directory of the caller, i.e.
 *                       `path.dirname(fileURLToPath(import.meta.url))`
 * @param {number} up    how far above `here` the plugin root sits — 1 for a
 *                       script in `scripts/`, 2 for one in `scripts/lib/`.
 */
export function resolveQaHome(here, up = 1) {
  const selfRelative = path.resolve(here, ...Array(up).fill(".."));
  if (fs.existsSync(path.join(selfRelative, "blueprints"))) return selfRelative;

  const env = process.env.THEMEGRILL_QA_HOME;
  if (env) {
    for (const candidate of [
      path.resolve(env),
      path.resolve(env, "plugins", "themegrill-qa"),
    ]) {
      if (fs.existsSync(path.join(candidate, "blueprints"))) return candidate;
    }
  }
  return selfRelative; // let the caller report the miss against a concrete path
}
