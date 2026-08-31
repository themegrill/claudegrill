/**
 * Load and normalise a product's `.themegrill-qa/suite.json`.
 *
 * Shared by `run-suite.mjs` and `suite-index.mjs` so the two cannot disagree
 * about what a manifest means — an index that globs one `spec_dir` while the
 * runner runs another would report coverage the runner never executes, which is
 * the most expensive kind of wrong this platform can be.
 *
 * Contract: SUITE.md §1.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

export const DEFAULT_TIERS = { fresh: "@fresh", demo: "@demo" };

/**
 * Identify the product by delegating to `detect-product.mjs`.
 *
 * Delegated rather than reimplemented because that script's JSON is the
 * contract every consumer in this platform reads (invariant 2). A second
 * implementation of "which product is this" would be a second thing to keep
 * right.
 */
export function detectProduct(qaHome, cwd = process.cwd()) {
  try {
    const out = execFileSync(
      process.execPath,
      [path.join(qaHome, "scripts", "detect-product.mjs")],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return { ok: true, info: JSON.parse(out) };
  } catch (err) {
    return {
      ok: false,
      reason:
        "not a WordPress theme or plugin — run this from inside a product checkout",
      detail: err.stdout ? String(err.stdout).trim() : String(err.message),
    };
  }
}

/** First existing path from a list, or null. */
function firstExisting(root, names) {
  for (const n of names) {
    if (fs.existsSync(path.join(root, n))) return n;
  }
  return null;
}

/**
 * Read the manifest and fill in what it did not declare.
 *
 * Every inferred value is recorded in `inferred` so the caller can print it.
 * A wrong inference that nobody sees is far worse than one that announces
 * itself — the failure it causes surfaces several steps later, attached to
 * something else.
 *
 * @returns {{present: boolean, manifest?: object, inferred?: string[], error?: string}}
 */
export function loadManifest(productRoot) {
  const file = path.join(productRoot, ".themegrill-qa", "suite.json");
  if (!fs.existsSync(file)) return { present: false };

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    return { present: true, error: `suite.json is not valid JSON: ${err.message}` };
  }

  const inferred = [];
  const m = { ...raw };

  m.runner = m.runner ?? "playwright";

  if (!m.package_manager) {
    const lock = firstExisting(productRoot, [
      "pnpm-lock.yaml",
      "yarn.lock",
      "package-lock.json",
    ]);
    m.package_manager =
      { "pnpm-lock.yaml": "pnpm", "yarn.lock": "yarn", "package-lock.json": "npm" }[
        lock
      ] ?? "npm";
    inferred.push(
      `package_manager: ${m.package_manager}${lock ? ` (from ${lock})` : " (no lockfile found)"}`,
    );
  }

  if (!m.command) {
    m.command =
      m.package_manager === "pnpm"
        ? "pnpm exec playwright test"
        : m.package_manager === "yarn"
          ? "yarn playwright test"
          : "npx playwright test";
    inferred.push(`command: ${m.command}`);
  }

  if (!m.config) {
    const cfg = firstExisting(productRoot, [
      "playwright.config.ts",
      "playwright.config.js",
      "playwright.config.mjs",
      "playwright.config.cjs",
    ]);
    if (cfg) {
      m.config = cfg;
      inferred.push(`config: ${cfg}`);
    }
  }

  if (!m.spec_dir) {
    const dir = firstExisting(productRoot, [
      "tests/e2e/specs",
      "tests/e2e",
      "e2e",
      "tests",
    ]);
    if (dir) {
      m.spec_dir = dir;
      inferred.push(`spec_dir: ${dir}`);
    }
  }

  if (!m.spec_extension) {
    m.spec_extension = ".spec.ts";
    inferred.push("spec_extension: .spec.ts");
  }

  if (!m.json_report) {
    m.json_report = "test-results/results.json";
    inferred.push(`json_report: ${m.json_report}`);
  }

  m.tiers = { ...DEFAULT_TIERS, ...(m.tiers ?? {}) };
  m.env = m.env ?? {};

  if (!m.spec_dir) {
    return {
      present: true,
      error:
        "suite.json declares no spec_dir and none of the conventional paths exist",
    };
  }

  return { present: true, manifest: m, inferred, file };
}

/**
 * Areas the product says it has, from the knowledge file or an ingested docs
 * index. This is the denominator of every coverage number the platform prints,
 * so when it is empty the honest answer is "unknown", never "zero".
 */
export function declaredAreas(productRoot, knowledgeRelPath) {
  const areas = new Set();

  // 1. An ingested docs index, if `ingest-docs.mjs` has run.
  const docsIndex = path.join(productRoot, ".themegrill-qa", "docs-index.json");
  if (fs.existsSync(docsIndex)) {
    try {
      const idx = JSON.parse(fs.readFileSync(docsIndex, "utf8"));
      for (const a of idx.suggested_areas ?? []) {
        if (typeof a === "string") areas.add(slugifyArea(a));
        else if (a && typeof a.name === "string") areas.add(slugifyArea(a.name));
      }
    } catch {
      /* a malformed index is not worth failing the run over */
    }
  }

  // 2. The knowledge file's critical-flows list.
  if (knowledgeRelPath) {
    const kf = path.join(productRoot, knowledgeRelPath);
    if (fs.existsSync(kf)) {
      for (const a of areasFromKnowledge(fs.readFileSync(kf, "utf8"))) {
        areas.add(a);
      }
    }
  }

  return [...areas];
}

export function slugifyArea(s) {
  return String(s)
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Pull the area list out of a knowledge file.
 *
 * Looks for a heading whose text contains "critical flow" or "area", then takes
 * that section's list items or table rows. Tolerant by design: the knowledge
 * files are written by humans for humans and their exact shape varies, so a
 * miss here degrades to "no declared areas" rather than to a crash.
 */
export function areasFromKnowledge(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const areas = [];
  let inSection = false;

  for (const line of lines) {
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      inSection = /critical flow|^areas\b|test areas|functional area/i.test(
        heading[1].trim(),
      );
      continue;
    }
    if (!inSection) continue;

    // `- **Header** — ...`, `- header`, `1. Header`
    const item = line.match(/^\s*(?:[-*+]|\d+\.)\s+(.+)$/);
    if (item) {
      const label = item[1]
        .replace(/^\*\*(.+?)\*\*.*$/, "$1")
        .replace(/^`(.+?)`.*$/, "$1")
        .split(/[—–:|]/)[0]
        .trim();
      if (label) areas.push(slugifyArea(label));
      continue;
    }

    // `| header | ... |`
    const row = line.match(/^\s*\|\s*([^|]+?)\s*\|/);
    if (row && !/^-+$/.test(row[1].trim())) {
      const label = row[1].replace(/^\*\*(.+?)\*\*$/, "$1").replace(/`/g, "").trim();
      if (label && !/^area$|^flow$|^name$/i.test(label)) areas.push(slugifyArea(label));
    }
  }

  return areas.filter(Boolean);
}
