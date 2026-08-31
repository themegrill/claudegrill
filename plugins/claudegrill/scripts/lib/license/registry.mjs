/**
 * Read `licenses.json`, resolve keys out of the environment, and redact.
 *
 * Two jobs, kept together because they are the same job: nothing else in this
 * repo is allowed to read a licence key, so the one module that does is also the
 * one that owns how a key is printed.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

/**
 * A key, safe to print.
 *
 * First four and last four, and — deliberately — the LENGTH is not disclosed
 * either, because "32 characters, starts abcd, ends wxyz" is a meaningful
 * narrowing of a keyspace when combined with a leak elsewhere. A short value is
 * fully masked rather than partially revealed.
 *
 * Every log line, every error message and every thrown exception in the licence
 * path goes through this. The error paths especially: an unredacted key most
 * often escapes through a stack trace or a "request failed: <url>" line, not
 * through the happy path anybody reviewed.
 */
export function redact(key) {
  if (key === null || key === undefined) return "(none)";
  const s = String(key);
  if (s.length === 0) return "(empty)";
  if (s.length < 12) return "****";
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

/**
 * Scrub every known key out of an arbitrary string.
 *
 * Belt and braces for the paths `redact()` cannot reach — a provider echoing the
 * key back inside an error message, a URL captured in a stack trace. Call this
 * on anything derived from a network response before it is printed.
 */
export function scrub(text, keys) {
  let out = String(text ?? "");
  for (const k of keys) {
    if (k && String(k).length >= 8) {
      out = out.split(String(k)).join(redact(k));
    }
  }
  return out;
}

/** The registry, parsed, with the `$comment` block dropped. */
export function loadRegistry(qaHome) {
  const file = path.join(qaHome, "licenses.json");
  if (!fs.existsSync(file)) {
    throw new Error(`licenses.json not found at ${file}`);
  }
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const out = {};
  for (const [slug, entry] of Object.entries(raw)) {
    if (slug.startsWith("$")) continue;
    out[slug] = { slug, ...entry };
  }
  return out;
}

/**
 * `.env.local` next to the product, if there is one.
 *
 * Same file `run-suite.mjs` already reads for the base URL, so a developer sets
 * their key in one place and both the suite and the licence layer find it. It is
 * gitignored in every product repo; `check-env-ignored()` below verifies that
 * rather than trusting it.
 */
export function loadEnvFile(file) {
  const out = {};
  if (!file || !fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

/**
 * The key for one product: process environment first, then `.env.local`.
 *
 * That order matters in CI, where the secret arrives as an environment variable
 * and a stale `.env.local` must never win over it.
 */
export function keyFor(entry, envFile = {}) {
  const name = entry.key_env;
  if (!name) return null;
  const v = process.env[name] ?? envFile[name] ?? null;
  return v && String(v).trim() !== "" ? String(v).trim() : null;
}

/**
 * Is this entry complete enough to act on?
 *
 * The registry deliberately carries incomplete rows — everest-forms-pro, whose
 * store endpoint lives in a repo nobody here has checked out. Acting on one
 * would mean inventing a URL, and an invented URL produces a licence layer that
 * silently never activates anything, which is the exact failure this whole
 * design exists to make impossible.
 */
export function completeness(entry) {
  const missing = [];
  if (Array.isArray(entry.incomplete)) missing.push(...entry.incomplete);

  if (entry.provider === "edd") {
    if (!entry.store_url) missing.push("store_url");
    if (!entry.option_key) missing.push("option_key");
  } else if (entry.provider === "freemius") {
    if (!entry.freemius_id) missing.push("freemius_id");
    if (!entry.freemius_slug) missing.push("freemius_slug");
  }

  const unique = [...new Set(missing)];
  return { complete: unique.length === 0, missing: unique };
}
