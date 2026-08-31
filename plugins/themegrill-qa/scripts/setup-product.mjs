#!/usr/bin/env node
/**
 * Set a product up for themegrill-qa, one idempotent step at a time.
 *
 * This is the deterministic half of `/themegrill-qa:setup`. Everything here is
 * a fact-check or a file write with a knowable answer: does this directory
 * exist, is that key already set, what does the registry say this product
 * needs. The skill above it does the only genuinely ambiguous part — asking a
 * human for a docs URL, a password, a licence key — and hands the answers back.
 *
 * Every action is safe to run twice. `status` is the contract: it reports what
 * is already done so the wizard can skip it, and nothing else in this file
 * overwrites a file that already exists unless --force is passed.
 *
 * SECRETS NEVER TRAVEL IN ARGV. `write-env` reads its values from the
 * environment, because arguments are visible in the process list to every other
 * process on the machine. `status` reports which keys are set, never a value.
 *
 * Usage
 *   node scripts/setup-product.mjs list [--site <wp root>]
 *   node scripts/setup-product.mjs status --type theme --slug colormag-pro
 *   node scripts/setup-product.mjs init-dir       --root <p>
 *   node scripts/setup-product.mjs write-suite    --root <p>
 *   node scripts/setup-product.mjs write-env      --root <p>      # values via env
 *   node scripts/setup-product.mjs write-workflow --root <p>
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { resolveQaHome } from "./lib/qa-home.mjs";
import { loadRegistry } from "./lib/license/registry.mjs";
import { detectProduct, loadManifest } from "./lib/suite-manifest.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const qaHome = resolveQaHome(here);

const ACTIONS = [
  "list",
  "status",
  "init-dir",
  "write-suite",
  "write-env",
  "write-workflow",
];

const opt = { type: null, slug: null, root: null, site: null, force: false };
const argv = process.argv.slice(2);
const action = argv.shift();

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--type") opt.type = argv[++i];
  else if (a === "--slug") opt.slug = argv[++i];
  else if (a === "--root") opt.root = argv[++i];
  else if (a === "--site") opt.site = argv[++i];
  else if (a === "--force") opt.force = true;
  else die(`unknown flag: ${a}`);
}

if (!ACTIONS.includes(action)) {
  die(`usage: setup-product.mjs <${ACTIONS.join("|")}> [flags]`);
}

function die(msg) {
  process.stdout.write(JSON.stringify({ ok: false, error: msg }, null, 2) + "\n");
  process.exit(2);
}

function out(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}

// --------------------------------------------------------------- the WP root

/**
 * The WordPress installation a product lives inside.
 *
 * Walked up from the working directory rather than configured, because a
 * developer working on a theme is, by construction, standing inside the site
 * that runs it. `--site` and `TGQA_SITE_PATH` cover the checkout kept somewhere
 * else entirely.
 */
function findWpRoot(from = process.cwd()) {
  const explicit = opt.site ?? process.env.TGQA_SITE_PATH ?? null;
  if (explicit) {
    const wpContent = path.join(explicit, "wp-content");
    return fs.existsSync(wpContent) ? explicit : null;
  }
  for (let d = path.resolve(from); ; ) {
    if (fs.existsSync(path.join(d, "wp-content"))) return d;
    if (path.basename(d) === "wp-content") return path.dirname(d);
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

const CONTENT_DIR = { theme: "themes", plugin: "plugins" };

// Same conventional locations `suite-manifest.mjs` infers from, so `status` and
// `write-suite` never disagree about whether a suite exists.
const SPEC_DIRS = ["tests/e2e/specs", "tests/e2e", "e2e", "tests"];
const PW_CONFIGS = [
  "playwright.config.ts",
  "playwright.config.js",
  "playwright.config.mjs",
  "playwright.config.cjs",
];

/** Every product checkout the site holds, with what each already has. */
function listProducts() {
  const wpRoot = findWpRoot();
  if (!wpRoot) {
    return { ok: false, error: "no WordPress installation found above the working directory — pass --site <wp root>" };
  }

  const registry = loadRegistry(qaHome);
  const found = [];

  for (const [type, dir] of Object.entries(CONTENT_DIR)) {
    const base = path.join(wpRoot, "wp-content", dir);
    let names = [];
    try {
      names = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of names) {
      if (!e.isDirectory()) continue;
      const root = path.join(base, e.name);
      const info = detectProduct(qaHome, root);
      if (!info.ok) continue;
      found.push({
        type,
        dir: e.name,
        slug: info.info.slug,
        name: info.info.name,
        version: info.info.version,
        root,
        pro: Boolean(registry[e.name]),
        // A product not in git cannot receive a workflow or a spec commit.
        git: fs.existsSync(path.join(root, ".git")),
        configured: fs.existsSync(path.join(root, ".themegrill-qa")),
      });
    }
  }

  return { ok: true, wp_root: wpRoot, products: found };
}

/** Where this product's checkout is. Explicit root wins, then type+slug, then cwd. */
function resolveRoot() {
  if (opt.root) {
    const r = path.resolve(opt.root);
    if (!fs.existsSync(r)) die(`no such directory: ${r}`);
    return r;
  }

  if (opt.slug && opt.type) {
    if (!CONTENT_DIR[opt.type]) die(`--type must be theme or plugin (got: ${opt.type})`);
    const wpRoot = findWpRoot();
    if (!wpRoot) {
      die(
        `no WordPress installation found above the working directory. Pass ` +
          `--root <path to the ${opt.slug} checkout>, or --site <wp root>.`,
      );
    }
    // The directory name, not the text domain: ColorMag Pro's style.css declares
    // `Text Domain: colormag`, so a slug lookup would land on the free theme.
    const r = path.join(wpRoot, "wp-content", CONTENT_DIR[opt.type], opt.slug);
    if (!fs.existsSync(r)) {
      die(`no ${opt.type} directory named "${opt.slug}" in ${path.join(wpRoot, "wp-content", CONTENT_DIR[opt.type])}`);
    }
    return r;
  }

  const info = detectProduct(qaHome);
  if (!info.ok) {
    die("not in a product checkout — pass --type and --slug, or --root");
  }
  return info.info.root;
}

// ------------------------------------------------------------------- status

/** Which keys a .env.local already holds. NAMES ONLY — never a value. */
function envKeys(file) {
  if (!fs.existsSync(file)) return null;
  const keys = [];
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m && m[2].trim() !== "") keys.push(m[1]);
  }
  return keys;
}

function isIgnored(root, rel) {
  try {
    execFileSync("git", ["check-ignore", "-q", rel], {
      cwd: root,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

function status() {
  const root = resolveRoot();
  const detected = detectProduct(qaHome, root);
  if (!detected.ok) {
    return { ok: false, root, error: `${root} is not a WordPress theme or plugin` };
  }
  const info = detected.info;

  const registry = loadRegistry(qaHome);
  // Registry keys are directory names (colormag-pro), which is also what the
  // pro repos are called. The text domain is not reliable here — see resolveRoot.
  const proEntry = registry[path.basename(root)] ?? null;

  const qaDir = path.join(root, ".themegrill-qa");
  const envFile = path.join(qaDir, ".env.local");
  const keys = envKeys(envFile);
  const manifest = loadManifest(root);

  const workflowName = proEntry ? "qa-pro.yml" : "qa-suite.yml";
  const workflow = path.join(root, ".github", "workflows", workflowName);

  const pkg = path.join(root, "package.json");
  const playwright = path.join(root, "node_modules", "@playwright", "test");

  const licenceKeyName = proEntry?.key_env ?? null;
  const licencePresent = licenceKeyName
    ? Boolean(process.env[licenceKeyName]) || Boolean(keys?.includes(licenceKeyName))
    : null;

  const steps = {
    product: {
      done: true,
      root,
      type: info.type,
      slug: info.slug,
      dir: path.basename(root),
      name: info.name,
      version: info.version,
      git: fs.existsSync(path.join(root, ".git")),
    },
    pro: {
      done: true,
      is_pro: Boolean(proEntry),
      free_slug: proEntry?.requires ?? null,
      free_repo: proEntry?.requires ? `${proEntry.repo.split("/")[0]}/${proEntry.requires}` : null,
      license_env: licenceKeyName,
      license_present: licencePresent,
    },
    qa_dir: { done: fs.existsSync(qaDir), path: ".themegrill-qa/" },
    suite: {
      done: fs.existsSync(path.join(qaDir, "suite.json")),
      // A product can have a runnable suite and no manifest. The wizard needs to
      // know which, because `write-suite` can describe the first and not the
      // second — and "no specs yet" is a different conversation from "no
      // manifest yet".
      has_specs: SPEC_DIRS.some((d) => fs.existsSync(path.join(root, d))),
      has_config: PW_CONFIGS.some((c) => fs.existsSync(path.join(root, c))),
      spec_dir: manifest.manifest?.spec_dir ?? null,
      error: manifest.error ?? null,
    },
    docs: {
      done: fs.existsSync(path.join(qaDir, "docs-index.json")),
      path: ".themegrill-qa/docs-index.json",
    },
    knowledge: {
      done: fs.existsSync(path.join(qaDir, "knowledge.md")),
      path: ".themegrill-qa/knowledge.md",
    },
    env: {
      done: Boolean(keys?.length),
      keys: keys ?? [],
      gitignored: fs.existsSync(envFile) ? isIgnored(root, ".themegrill-qa/.env.local") : null,
      needs: [
        "TGQA_BASE_URL",
        manifest.manifest?.env?.admin_user ?? "TGQA_ADMIN_USER",
        manifest.manifest?.env?.admin_pass ?? "TGQA_ADMIN_PASS",
        ...(licenceKeyName ? [licenceKeyName] : []),
      ],
    },
    playwright: {
      done: fs.existsSync(playwright),
      package_json: fs.existsSync(pkg),
      package_manager: manifest.manifest?.package_manager ?? "pnpm",
    },
    workflow: { done: fs.existsSync(workflow), path: `.github/workflows/${workflowName}` },
  };

  // The licence is a hard requirement on a pro product and irrelevant on a free
  // one, so it is a step rather than a footnote.
  if (proEntry) {
    steps.license = {
      done: Boolean(licencePresent),
      env: licenceKeyName,
      required: true,
    };
  }

  const remaining = Object.entries(steps)
    .filter(([, v]) => v.done === false)
    .map(([k]) => k);

  return { ok: true, root, steps, remaining, complete: remaining.length === 0 };
}

// -------------------------------------------------------------------- writes

function initDir() {
  const root = resolveRoot();
  const dir = path.join(root, ".themegrill-qa");
  const existed = fs.existsSync(dir);
  if (!existed) fs.mkdirSync(dir, { recursive: true });
  return { ok: true, root, created: !existed, path: ".themegrill-qa/" };
}

/**
 * A suite manifest built from what the product already has.
 *
 * Every value is written explicitly even where `loadManifest` would infer it,
 * because an inferred value is invisible: the next person reading suite.json
 * cannot tell what the runner will actually do. `area_paths` is deliberately
 * left out — nobody can guess a product's area map, and a wrong one silently
 * narrows CI.
 */
function writeSuite() {
  const root = resolveRoot();
  const file = path.join(root, ".themegrill-qa", "suite.json");
  if (fs.existsSync(file) && !opt.force) {
    return { ok: true, root, skipped: "already exists", path: ".themegrill-qa/suite.json" };
  }

  // Bootstrap through loadManifest rather than reimplementing its inference: it
  // only fills in a manifest that already exists, so write an empty one, let it
  // resolve every field, then persist what it worked out. One implementation of
  // "what does this suite look like", not two that can disagree.
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const hadFile = fs.existsSync(file);
  const previous = hadFile ? fs.readFileSync(file, "utf8") : null;
  fs.writeFileSync(file, "{}\n");

  const m = loadManifest(root);
  if (!m.manifest) {
    // Put back exactly what was there, including nothing.
    if (hadFile) fs.writeFileSync(file, previous);
    else fs.rmSync(file, { force: true });
    return {
      ok: false,
      root,
      error:
        m.error ??
        "no Playwright suite found — nothing to describe. Add a playwright config " +
          "and tests/e2e/specs first, then run this again.",
    };
  }

  const detected = detectProduct(qaHome, root);
  const slug = detected.ok ? detected.info.slug : path.basename(root);
  const prefix = slug.replace(/[^a-z0-9]+/gi, "_").toUpperCase();

  // The install command has to match the package manager that was inferred, or
  // CI runs `pnpm install` in an npm project and fails on a missing binary.
  const pm = m.manifest.package_manager ?? "pnpm";
  const INSTALL = {
    pnpm: "pnpm install --frozen-lockfile",
    yarn: "yarn install --frozen-lockfile",
    npm: "npm ci",
  };

  const manifest = {
    runner: "playwright",
    package_manager: pm,
    install: m.manifest.install ?? INSTALL[pm] ?? "npm ci",
    command: m.manifest.command,
    config: m.manifest.config,
    spec_dir: m.manifest.spec_dir,
    spec_extension: m.manifest.spec_extension,
    json_report: m.manifest.json_report,
    env: {
      base_url: m.manifest.env?.base_url ?? `${prefix}_BASE_URL`,
      admin_user: m.manifest.env?.admin_user ?? `${prefix}_ADMIN_USER`,
      admin_pass: m.manifest.env?.admin_pass ?? `${prefix}_ADMIN_PASS`,
    },
    tiers: m.manifest.tiers,
  };

  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
  return {
    ok: true,
    root,
    written: ".themegrill-qa/suite.json",
    inferred: m.inferred ?? [],
    // area_paths is the one thing nobody can infer, and its absence means every
    // CI run is a full run — correct, just slower. Say so rather than let it
    // look finished.
    next: "add `area_paths` to narrow CI runs to the areas a diff touches (SUITE.md)",
  };
}

/**
 * `.env.local`, from the environment.
 *
 * Refuses to write until the file is gitignored. A licence key or an admin
 * password one `git add .` away from a public repository is not a risk worth
 * taking for the convenience of writing the file first and tidying up after.
 */
function writeEnv() {
  const root = resolveRoot();
  const dir = path.join(root, ".themegrill-qa");
  const file = path.join(dir, ".env.local");

  const wanted = {};
  for (const [envName, key] of [
    ["TGQA_SETUP_BASE_URL", "base_url"],
    ["TGQA_SETUP_ADMIN_USER", "admin_user"],
    ["TGQA_SETUP_ADMIN_PASS", "admin_pass"],
    ["TGQA_SETUP_LICENSE", "license"],
  ]) {
    const v = process.env[envName];
    if (v && v.trim() !== "") wanted[key] = v.trim();
  }

  if (Object.keys(wanted).length === 0) {
    return {
      ok: false,
      root,
      error:
        "no values supplied. Set TGQA_SETUP_BASE_URL, TGQA_SETUP_ADMIN_USER, " +
        "TGQA_SETUP_ADMIN_PASS and (pro only) TGQA_SETUP_LICENSE in the environment. " +
        "Never pass them as arguments.",
    };
  }

  fs.mkdirSync(dir, { recursive: true });

  // Ignore it BEFORE it holds anything.
  const gitignore = path.join(root, ".gitignore");
  const rule = ".themegrill-qa/.env.local";
  let addedRule = false;
  if (!isIgnored(root, rule)) {
    const current = fs.existsSync(gitignore) ? fs.readFileSync(gitignore, "utf8") : "";
    const sep = current === "" || current.endsWith("\n") ? "" : "\n";
    fs.appendFileSync(gitignore, `${sep}\n# themegrill-qa — local credentials, never commit\n${rule}\n`);
    addedRule = true;
  }
  if (!isIgnored(root, rule)) {
    return {
      ok: false,
      root,
      error: `${rule} is still not gitignored after writing a rule — refusing to write credentials`,
    };
  }

  const m = loadManifest(root);
  const registry = loadRegistry(qaHome);
  const proEntry = registry[path.basename(root)] ?? null;

  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const lines = existing === "" ? ["# themegrill-qa — local only. Gitignored, never committed."] : existing.replace(/\n+$/, "").split("\n");

  const setKey = (name, value) => {
    if (!name || value === undefined) return null;
    const re = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`);
    const at = lines.findIndex((l) => re.test(l));
    if (at >= 0) {
      if (!opt.force) return "kept";
      lines[at] = `${name}=${value}`;
      return "replaced";
    }
    lines.push(`${name}=${value}`);
    return "added";
  };

  const applied = {};
  if (wanted.base_url) {
    applied.TGQA_BASE_URL = setKey("TGQA_BASE_URL", wanted.base_url);
    const declared = m.manifest?.env?.base_url;
    if (declared && declared !== "TGQA_BASE_URL") applied[declared] = setKey(declared, wanted.base_url);
  }
  if (wanted.admin_user) {
    const name = m.manifest?.env?.admin_user ?? "TGQA_ADMIN_USER";
    applied[name] = setKey(name, wanted.admin_user);
  }
  if (wanted.admin_pass) {
    const name = m.manifest?.env?.admin_pass ?? "TGQA_ADMIN_PASS";
    applied[name] = setKey(name, wanted.admin_pass);
  }
  if (wanted.license) {
    if (!proEntry) {
      return { ok: false, root, error: `${path.basename(root)} is not a pro product in licenses.json — refusing to write a licence key` };
    }
    applied[proEntry.key_env] = setKey(proEntry.key_env, wanted.license);
  }

  fs.writeFileSync(file, lines.join("\n") + "\n", { mode: 0o600 });

  // Names and what happened to each. Never a value.
  return { ok: true, root, path: ".themegrill-qa/.env.local", gitignore_rule_added: addedRule, keys: applied };
}

/** Is the free product a theme or a plugin? On-disk truth first, registry second. */
function freeProductType(proRoot, proEntry) {
  if (!proEntry.requires) return null;
  const wpContent = path.dirname(path.dirname(proRoot)); // …/wp-content
  for (const [type, dir] of Object.entries(CONTENT_DIR)) {
    if (fs.existsSync(path.join(wpContent, dir, proEntry.requires))) return type;
  }
  return proEntry.requires_type ?? null;
}

function writeWorkflow() {
  const root = resolveRoot();
  const registry = loadRegistry(qaHome);
  const proEntry = registry[path.basename(root)] ?? null;
  const detected = detectProduct(qaHome, root);
  if (!detected.ok) return { ok: false, root, error: "not a WordPress theme or plugin" };

  const name = proEntry ? "qa-pro.yml" : "qa-suite.yml";
  const dest = path.join(root, ".github", "workflows", name);
  if (fs.existsSync(dest) && !opt.force) {
    return { ok: true, root, skipped: "already exists", path: `.github/workflows/${name}` };
  }

  const template = path.join(qaHome, "templates", name);
  if (!fs.existsSync(template)) return { ok: false, root, error: `missing template: ${template}` };

  let body = fs.readFileSync(template, "utf8");

  if (proEntry) {
    if (!proEntry.requires) {
      return { ok: false, root, error: `licenses.json has no \`requires\` for ${path.basename(root)} — cannot name the free repo` };
    }
    // `product_type` describes the FREE product, not this one, and the two
    // genuinely differ: Zakra Pro is a PLUGIN extending a free THEME. Reading it
    // off the pro entry rendered `plugin` for Zakra and would have booted the
    // wrong shape of site. Prefer the free checkout if it is on this machine,
    // fall back to the registry, and refuse rather than guess.
    const owner = proEntry.repo.split("/")[0];
    const freeType = freeProductType(root, proEntry);
    if (!freeType) {
      return {
        ok: false,
        root,
        error:
          `cannot tell whether the free product "${proEntry.requires}" is a theme or a ` +
          `plugin. Add \`requires_type\` to its licenses.json entry, or check the free ` +
          `product out alongside this one.`,
      };
    }
    body = body
      .replace(/__PRODUCT_SLUG__/g, proEntry.requires)
      .replace(/__PRODUCT_TYPE__/g, freeType)
      .replace(/__FREE_REPO__/g, `${owner}/${proEntry.requires}`)
      .replace(/__PRO_SLUG__/g, path.basename(root))
      .replace(/__LICENSE_SECRET__/g, proEntry.key_env);
  } else {
    body = body
      .replace(/__PRODUCT_SLUG__/g, detected.info.slug)
      .replace(/__PRODUCT_TYPE__/g, detected.info.type);
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, body);
  return { ok: true, root, written: `.github/workflows/${name}`, pro: Boolean(proEntry) };
}

// ---------------------------------------------------------------------- main

switch (action) {
  case "list":
    out(listProducts());
    break;
  case "status": {
    const s = status();
    out(s);
    if (!s.ok) process.exit(2);
    break;
  }
  case "init-dir":
    out(initDir());
    break;
  case "write-suite": {
    const r = writeSuite();
    out(r);
    if (!r.ok) process.exit(2);
    break;
  }
  case "write-env": {
    const r = writeEnv();
    out(r);
    if (!r.ok) process.exit(2);
    break;
  }
  case "write-workflow": {
    const r = writeWorkflow();
    out(r);
    if (!r.ok) process.exit(2);
    break;
  }
}
