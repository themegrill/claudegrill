#!/usr/bin/env node
/**
 * Boot a disposable WordPress with the product under test mounted live, and
 * print the URL and credentials the agent should drive.
 *
 * Node rather than bash so Windows and macOS both work with nothing installed
 * beyond Node. Windows specifics handled here: `npx` resolves to `npx.cmd`,
 * paths are joined with the platform separator, and stopping the server uses
 * `taskkill /T` because killing a PID on Windows leaves the child tree running.
 *
 * Engines
 *   playground (default) — PHP-WASM + SQLite. Seconds to boot, no Docker.
 *                          Right for UI, editor, customizer and frontend work.
 *   wp-env               — real MySQL and PHP in Docker. Slower, but correct for
 *                          MySQL-specific SQL, real cron, mail, or multisite.
 *
 * Usage
 *   node scripts/boot-wp.mjs [--engine playground|wp-env] [--wp 6.9] [--php 8.3]
 *                           [--port 9400] [--with slug=path ...] [--reset]
 *   node scripts/boot-wp.mjs --with-pro colormag-pro --license
 *   node scripts/boot-wp.mjs --stop
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { resolveQaHome } from "./lib/qa-home.mjs";
import { isWindows, killTree, npxCommand, shellQuote } from "./lib/platform.mjs";
import { loadRegistry } from "./lib/license/registry.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

const qaHome = resolveQaHome(here);

const stateFile = path.join(os.tmpdir(), "claudegrill-playground.json");
const logFile = path.join(os.tmpdir(), "claudegrill-playground.log");

// ------------------------------------------------------------------ arguments

const argv = process.argv.slice(2);
const opt = {
  engine: "playground",
  wp: process.env.WP_VERSION || "latest",
  php: process.env.PHP_VERSION || "8.3",
  port: Number(process.env.PORT || 9400),
  reset: false,
  stop: false,
  with: [],
  withPro: [], // slug or slug=path, resolved against licenses.json
  license: false,
};

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--engine") opt.engine = argv[++i];
  else if (a === "--wp") opt.wp = argv[++i];
  else if (a === "--php") opt.php = argv[++i];
  else if (a === "--port") opt.port = Number(argv[++i]);
  else if (a === "--with") opt.with.push(argv[++i]);
  else if (a === "--with-pro") opt.withPro.push(argv[++i]);
  else if (a === "--license") opt.license = true;
  else if (a === "--reset") opt.reset = true;
  else if (a === "--stop") opt.stop = true;
  else {
    console.error(`unknown flag: ${a}`);
    process.exit(2);
  }
}

// ------------------------------------------------------------------- helpers

/**
 * Follow redirects the way a browser does — carrying cookies.
 *
 * This is the whole reason readiness detection used to fail. Playground's
 * `--login` flag makes `/` answer 302 with three `Set-Cookie` headers and
 * `Location: /` — a redirect to ITSELF, which only terminates once the client
 * sends the cookies back. A bare `fetch(url, { redirect: "follow" })` keeps no
 * cookies, so it bounces between `/` and `/` until Node's internal redirect
 * limit throws, and the caller reads that as "not listening yet".
 *
 * Diagnosed against a real running site: `curl` without a cookie jar looped,
 * `curl -L -c jar -b jar` returned 200 and 71KB of correct ColorMag markup from
 * the same server at the same moment. The earlier Windows report — polls seeing
 * 502s for 600s while a manual cookie-aware request got a clean 200 — is this
 * bug, not a platform issue and not the SQLite `lockWholeFile` warnings it was
 * provisionally blamed on.
 */
async function fetchFollowingCookies(url, maxHops = 8) {
  const jar = new Map();
  let current = url;

  for (let hop = 0; hop <= maxHops; hop++) {
    const cookie = [...jar]
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");

    const res = await fetch(current, {
      redirect: "manual", // we follow by hand so the jar survives each hop
      headers: cookie ? { cookie } : {},
    });

    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const pair = raw.split(";")[0];
      const eq = pair.indexOf("=");
      if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) return res;
      current = new URL(location, current).toString();
      continue;
    }
    return res;
  }
  return null; // still redirecting after maxHops — treat as not ready
}

/**
 * Wait for a site that actually serves WordPress.
 *
 * A mere HTTP response is not enough: while Playground is failing to fetch
 * WordPress it still answers on the port, with 502s and error pages. Accepting
 * any status here hands the agent a broken site and produces a confusing failure
 * three steps later, so require a non-error status *and* markup that looks like
 * WordPress before declaring victory.
 *
 * 180s was too tight for a first-time boot, which downloads WordPress core and
 * PHP.wasm and then runs every blueprint step through an emulated PHP runtime.
 * A cached, non-reset boot is fast; this budget only matters for the slow first
 * provision, so it costs nothing on the common path.
 */
async function waitForServer(url, childAlive, timeoutMs = 600000) {
  const started = Date.now();
  let lastStatus = null;

  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetchFollowingCookies(url);
      if (res) {
        lastStatus = res.status;
        if (res.status < 400) {
          const body = await res.text();
          if (/wp-content|wp-includes|wp-json|<body/i.test(body)) {
            return { ok: true };
          }
        }
      }
    } catch {
      /* not listening yet */
    }
    if (!childAlive()) return { ok: false, lastStatus, reason: "exited" };
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { ok: false, lastStatus, reason: "timeout" };
}

/**
 * Ask the booted site what it believes.
 *
 * Cookie-aware, like `waitForServer` and for the same reason: `--login` makes
 * Playground answer `/` with a 302 to itself that only terminates once the
 * client sends its cookies back, so a bare `fetch` bounces until Node's redirect
 * limit throws. That bug cost this project weeks and was misdiagnosed as a
 * Windows problem; every request from here carries the jar.
 *
 * A probe that does not answer is reported as such and never guessed at — the
 * caller prints "probe did not answer", which is a legible failure, rather than
 * an invented "environment_type: local".
 */
async function probeSite(url, token, timeoutMs = 120000) {
  const started = Date.now();
  let last = null;

  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetchFollowingCookies(`${url}/?tgqa_probe=${token}`);
      if (res && res.status === 200) {
        const body = await res.text();
        try {
          const parsed = JSON.parse(body);
          last = parsed;
          // The marker is the whole point. Playground answers requests while
          // later blueprint steps are still applying, so an answer alone proves
          // nothing about the state it describes.
          if (parsed.boot_complete === token) return parsed;
        } catch {
          /* not our JSON yet — mu-plugins may not have been copied */
        }
      }
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  // Return what we last saw, MARKED as unsettled, rather than nothing. Losing
  // the observation entirely helps nobody debug; presenting it as settled would
  // be the exact lie the marker exists to prevent.
  return last ? { ...last, settled: false } : null;
}

function readLog() {
  try {
    return fs.readFileSync(logFile, "utf8");
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------- stop

if (opt.stop) {
  if (!fs.existsSync(stateFile)) {
    console.error("nothing recorded as running");
    process.exit(0);
  }
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const ok = killTree(state.pid);
  fs.rmSync(stateFile, { force: true });
  console.log(ok ? `stopped pid ${state.pid}` : `could not stop pid ${state.pid}`);
  process.exit(0);
}

// ------------------------------------------------------------------ identify

let info;
try {
  const out = execFileSync(
    process.execPath,
    [path.join(qaHome, "scripts", "detect-product.mjs")],
    { encoding: "utf8" },
  );
  info = JSON.parse(out);
} catch (err) {
  console.error(
    "could not identify the product here. Run this from inside a theme or plugin checkout.",
  );
  if (err.stdout) console.error(String(err.stdout).trim());
  process.exit(1);
}

// ------------------------------------------------------------------ pro code

/**
 * Resolve `--with-pro <slug>[=<path>]` against the registry.
 *
 * The registry, not a guess, decides where a pro product mounts. That matters
 * because the four pro products are delivered three different ways and no rule
 * covers them all:
 *
 *   colormag-pro          a STANDALONE THEME that replaces the free theme — not
 *                         a child theme, and not a companion plugin. The free
 *                         and pro themes must never be active together.
 *   zakra-pro             a companion PLUGIN extending the free Zakra THEME, so
 *                         the free theme stays active and the plugin is added.
 *   user-registration-pro a plugin that replaces the free plugin.
 *   everest-forms-pro     a companion plugin alongside the free one.
 *
 * Assuming any one of those shapes for the others produces a site that boots and
 * tests nothing.
 */
function resolveProMounts() {
  if (opt.withPro.length === 0) return [];

  let registry;
  try {
    registry = loadRegistry(qaHome);
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }

  return opt.withPro.map((spec) => {
    const idx = spec.indexOf("=");
    const slug = idx === -1 ? spec : spec.slice(0, idx);
    const entry = registry[slug];

    if (!entry) {
      console.error(
        `--with-pro: unknown product "${slug}". Known: ${Object.keys(registry).join(", ")}`,
      );
      process.exit(2);
    }

    // An explicit path wins. Otherwise look beside the product under test, then
    // beside its wp-content directory — the two layouts a developer actually
    // has: sibling git clones, or a Local site's wp-content.
    let dir = idx === -1 ? null : path.resolve(spec.slice(idx + 1));
    if (!dir) {
      const contentDir = entry.type === "theme" ? "themes" : "plugins";
      for (const candidate of [
        path.resolve(info.root, "..", slug),
        path.resolve(info.root, "..", "..", contentDir, slug),
      ]) {
        if (fs.existsSync(candidate)) {
          dir = candidate;
          break;
        }
      }
    }

    if (!dir || !fs.existsSync(dir)) {
      console.error(
        `--with-pro ${slug}: no checkout found. Pass an explicit path as ` +
          `--with-pro ${slug}=/path/to/${slug}, or clone ${entry.repo} beside the product.`,
      );
      process.exit(1);
    }

    return { slug, entry, dir, contentDir: entry.type === "theme" ? "themes" : "plugins" };
  });
}

const proMounts = resolveProMounts();

if (opt.license && proMounts.length === 0) {
  console.error("--license needs at least one --with-pro; there is nothing to license");
  process.exit(2);
}

/**
 * Stage the QA-only mu-plugins, and the licence config if one was asked for.
 *
 * Staged into a neutral directory and copied into `mu-plugins/` by a blueprint
 * step, rather than mounted over `wp-content/mu-plugins` directly. Playground
 * puts its own must-use plugins there, and mounting a host directory onto that
 * path replaces them — which breaks the site in a way that looks like a
 * Playground bug rather than our mount.
 *
 * The probe is staged on every boot: it is how the caller OBSERVES the resulting
 * site instead of assuming the blueprint did what it was told. The licence
 * config is staged only with `--license`.
 *
 * Returns the directory, the probe token, and the per-product seed verdicts. A
 * product whose seed failed still gets a config written — with
 * `attempted: false` — because a MISSING config would let the mu-plugin no-op
 * silently, and silence is the one outcome forbidden here.
 */
function stageMuPlugins(siteUrl) {
  const dir = path.join(os.tmpdir(), `claudegrill-mu-${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  for (const f of ["tgqa-probe.php", ...(opt.license ? ["tgqa-license.php"] : [])]) {
    fs.copyFileSync(path.join(qaHome, "mu-plugins", f), path.join(dir, f));
  }

  const token = crypto.randomBytes(16).toString("hex");
  fs.writeFileSync(path.join(dir, "tgqa-probe.token"), token, { mode: 0o600 });

  const verdicts = [];
  if (opt.license) {
    // One config file per boot. Two pro products in one site would collide on
    // `tgqa-license.json`; saying so beats silently licensing whichever wrote
    // last.
    if (proMounts.length > 1) {
      console.error(
        "note: --license with more than one --with-pro is not supported — " +
          "only the last product's config survives. Boot one pro product at a time.",
      );
    }

    for (const m of proMounts) {
      const res = spawnSync(
        process.execPath,
        [
          path.join(qaHome, "scripts", "license.mjs"),
          "seed",
          "--product",
          m.slug,
          "--site-url",
          siteUrl,
          "--out",
          dir,
        ],
        { encoding: "utf8" },
      );
      // stderr is the human line, already redacted by license.mjs. Pass it
      // through so a failed activation is visible at boot rather than only in
      // the suite's report an hour later.
      if (res.stderr) process.stderr.write(res.stderr);
      let parsed;
      try {
        parsed = JSON.parse(String(res.stdout).trim().split("\n").pop());
      } catch {
        parsed = {
          ok: false,
          product: m.slug,
          state: "unknown",
          reason: "license.mjs produced no JSON",
        };
      }
      verdicts.push(parsed);
    }
  }

  return { dir, token, verdicts };
}

/**
 * Add the pro activation steps to a blueprint's step list.
 *
 * Order is the whole content of this function, and it is not interchangeable:
 *
 *   1. the free product is activated by the blueprint's own step;
 *   2. the pro THEME, if any, is activated next — which DEACTIVATES the free
 *      theme, because WordPress has exactly one active theme. ColorMag Pro is a
 *      standalone theme, so "install pro" genuinely means "switch theme", and a
 *      run that left the free theme active would have tested the free theme;
 *   3. pro PLUGINS are activated after, so Zakra Pro finds its free theme in
 *      place — it is a companion to the theme, and activating it against a
 *      different theme exercises nothing;
 *   4. the licence resolves last, on `plugins_loaded`, once everything is there.
 *
 * `WP_ENVIRONMENT_TYPE` goes in FIRST, ahead of every other step, because a
 * const defined after the code that reads it is a const that did nothing.
 */
function withProSteps(steps, token) {
  // The blueprints carry it too, so a blueprint handed to Playground directly
  // still gets it. Prepend only when it is genuinely absent — two
  // defineWpConfigConsts steps for the same const is harmless but confusing to
  // read in a failed boot log.
  const hasEnvConst = steps.some(
    (st) => st?.step === "defineWpConfigConsts" && st?.consts?.WP_ENVIRONMENT_TYPE,
  );

  const out = [
    ...(hasEnvConst ? [] : [{
      // Not required for activation — the keys are uncapped, and Freemius
      // exempts 127.0.0.1 anyway (FS_Site::is_localhost_by_address, SDK
      // 2.13.1). It is here because it keeps EDD's `site_count` from filling
      // with thousands of throwaway CI sites, and because it is simply true
      // about what this environment is.
      step: "defineWpConfigConsts",
      consts: { WP_ENVIRONMENT_TYPE: "local" },
    }]),
    {
      // Copy, do not mount. `wp-content/mu-plugins` already holds Playground's
      // own must-use plugins, and mounting a host directory onto that path
      // replaces them — a failure that presents as a broken Playground rather
      // than as our mount.
      step: "runPHP",
      code:
        "<?php $src = '/wordpress/wp-content/tgqa'; $dst = '/wordpress/wp-content/mu-plugins'; " +
        "if ( ! is_dir( $dst ) ) { mkdir( $dst, 0755, true ); } " +
        "foreach ( (array) glob( $src . '/*' ) as $f ) { copy( $f, $dst . '/' . basename( $f ) ); }",
    },
    ...steps,
  ];

  for (const m of proMounts.filter((x) => x.entry.type === "theme")) {
    out.push({ step: "activateTheme", themeFolderName: m.slug });
  }

  for (const m of proMounts.filter((x) => x.entry.type === "plugin")) {
    // `activatePlugin` wants the plugin's entry file, and the pro products do
    // not agree on it: user-registration-pro's entry is `user-registration.php`,
    // not `user-registration-pro.php`. Discover it rather than deriving it from
    // the slug, which is the assumption that would silently fail to activate.
    out.push({
      step: "runPHP",
      code:
        "<?php require '/wordpress/wp-load.php'; " +
        "require_once ABSPATH . 'wp-admin/includes/plugin.php'; " +
        `$dir = WP_PLUGIN_DIR . '/${m.slug}'; ` +
        "$entry = null; " +
        "foreach ( (array) glob( $dir . '/*.php' ) as $f ) { " +
        "  $head = get_plugin_data( $f, false, false ); " +
        "  if ( ! empty( $head['Name'] ) ) { $entry = basename( $dir ) . '/' . basename( $f ); break; } " +
        "} " +
        "if ( $entry ) { activate_plugin( $entry ); } " +
        `else { error_log( 'TGQA: no plugin header found in ${m.slug}' ); }`,
    });
  }

  // LAST, always. This is the deterministic "the blueprint finished" signal, and
  // it exists because of a real misreport: Playground prints "Ready!" and starts
  // answering requests while later blueprint steps are still applying. The first
  // probe of a boot with `--with-pro colormag-pro` came back
  // `active_theme: "colormag"` — the free theme — and a second probe seconds
  // later, against the same running site, correctly said `colormag-pro`.
  //
  // Reporting the first answer would have been a lie of exactly the kind this
  // repo has shipped before: a value that looks like an observation and is
  // actually a race. `probeSite` now waits for this marker to carry the token,
  // so "the pro theme is not active" can only mean it genuinely is not.
  out.push({
    step: "runPHP",
    code:
      "<?php require '/wordpress/wp-load.php'; " +
      `update_option( 'tgqa_boot_complete', '${token}', false );`,
  });

  return out;
}

// ---------------------------------------------------------------- playground

if (opt.engine === "playground") {
  // Mount EXPLICITLY, by slug — do not let Playground auto-mount.
  //
  // `--path` auto-detects the project type and mounts it at
  // `wp-content/themes/<basename of the directory>`. The blueprint then
  // activates `<slug>`, taken from the Text Domain. Those two agree only when
  // the checkout directory happens to be named after the slug.
  //
  // In CI it is not. `actions/checkout` with `path: product` produces
  // `/home/runner/work/colormag/colormag/product`, so Playground mounted
  // `wp-content/themes/product` while the blueprint tried to activate
  // `colormag`, and the boot died on blueprint step #2 with "Theme not found at
  // the provided theme path". Confirmed from a real failed run.
  //
  // `--no-auto-mount` plus an explicit `--mount` makes the virtual path depend
  // on the slug alone, so it no longer matters what anyone named the directory.
  // `--path` stays because it still decides which site directory Playground
  // reuses, which is what keeps two products from sharing one site locally.
  const contentDir = info.type === "theme" ? "themes" : "plugins";
  const args = [
    "--yes",
    "@wp-playground/cli@latest",
    "start",
    `--path=${info.root}`,
    "--no-auto-mount",
    `--mount=${info.root}:/wordpress/wp-content/${contentDir}/${info.slug}`,
    `--php=${opt.php}`,
    `--wp=${opt.wp}`,
    `--port=${opt.port}`,
    "--login",
    "--skip-browser",
    "--quiet",
    "--define-bool",
    "WP_DEBUG",
    "true",
    "--define-bool",
    "WP_DEBUG_LOG",
    "true",
    "--define-bool",
    "WP_DEBUG_DISPLAY",
    "false",
  ];

  if (opt.reset) args.push("--reset");

  // Extra plugins or themes mounted alongside — a pro add-on, or WooCommerce
  // checked out locally for a compatibility run.
  for (const spec of opt.with) {
    const idx = spec.indexOf("=");
    if (idx < 1) {
      console.error(`--with expects slug=path, got: ${spec}`);
      process.exit(2);
    }
    const slug = spec.slice(0, idx);
    const dir = path.resolve(spec.slice(idx + 1));
    args.push(`--mount=${dir}:/wordpress/wp-content/plugins/${slug}`);
  }

  // Pro code, mounted where the registry says it belongs.
  for (const m of proMounts) {
    args.push(`--mount=${m.dir}:/wordpress/wp-content/${m.contentDir}/${m.slug}`);
  }

  // The QA-only mu-plugins: the probe always, the licence seeder with --license.
  // Staged at a neutral path; a blueprint step copies them into mu-plugins/ so
  // Playground's own must-use plugins survive. See stageMuPlugins().
  const siteUrl = `http://127.0.0.1:${opt.port}`;
  const staged = stageMuPlugins(siteUrl);
  args.push(`--mount=${staged.dir}:/wordpress/wp-content/tgqa`);

  // A blueprint activates the product and seeds content, so the agent lands on a
  // site that exercises it rather than a bare install.
  const blueprint = path.join(
    qaHome,
    "blueprints",
    info.type === "theme" ? "theme-test.json" : "plugin-test.json",
  );
  if (fs.existsSync(blueprint)) {
    const rendered = path.join(
      os.tmpdir(),
      `claudegrill-blueprint-${process.pid}.json`,
    );
    const filled = fs
      .readFileSync(blueprint, "utf8")
      .replaceAll("__SLUG__", info.slug)
      .replaceAll("__ENTRY__", info.entry);

    // Splice the pro activation steps in as data rather than as text.
    // String-substituting JSON fragments into a template is how a blueprint ends
    // up unparseable on the one path nobody exercised; parsing and re-emitting
    // cannot produce invalid JSON at all.
    const doc = JSON.parse(filled);
    doc.steps = withProSteps(doc.steps ?? [], staged.token);
    fs.writeFileSync(rendered, JSON.stringify(doc, null, 2));
    args.push(`--blueprint=${rendered}`);
  }

  const out = fs.openSync(logFile, "w");
  const child = spawn(npxCommand(), args.map(shellQuote), {
    cwd: info.root,
    stdio: ["ignore", out, out],
    detached: !isWindows, // own process group, so we can kill the tree
    shell: isWindows, // .cmd needs a shell on Windows
    windowsHide: true,
  });
  child.unref();

  let exited = false;
  child.on("exit", () => {
    exited = true;
  });

  const url = `http://127.0.0.1:${opt.port}`;
  const ready = await waitForServer(url, () => !exited);

  if (!ready.ok) {
    const log = readLog();
    console.error(
      `Playground did not come up (${ready.reason}` +
        `${ready.lastStatus ? `, last HTTP status ${ready.lastStatus}` : ""}). Log follows:\n`,
    );
    console.error(log || "(empty log)");

    // First boot fetches WordPress and PHP.wasm over the network. In a locked
    // down environment that surfaces as an opaque JSON parse error, because an
    // HTML error page arrives where a zip was expected.
    if (
      /not valid JSON|Host not|ENOTFOUND|ETIMEDOUT|certificate|EAI_AGAIN/i.test(log)
    ) {
      console.error(
        [
          "",
          "HINT: this looks like blocked network access, not a bad config.",
          "      Playground needs playground.wordpress.net and wordpress.org on",
          "      first boot. Allowlist them, or use --engine wp-env instead.",
        ].join("\n"),
      );
    }
    killTree(child.pid);
    process.exit(1);
  }

  fs.writeFileSync(
    stateFile,
    JSON.stringify({ pid: child.pid, port: opt.port, url }, null, 2),
  );

  // Observe the site rather than assuming the blueprint worked. This is where
  // `WP_ENVIRONMENT_TYPE` and the pro gate stop being things we asked for and
  // become things we saw.
  const probe = await probeSite(url, staged.token);

  if (opt.license) {
    const state = probe?.license?.state ?? null;
    if (state !== "valid") {
      // Loud, and on stderr so it survives --json. NOT fatal: the caller may be
      // booting deliberately unlicensed to test that state. The suite's own
      // gate is what refuses to run @pro specs; see run-suite.mjs.
      console.error(
        `WARNING: licence did not resolve to valid (state=${state ?? "unknown"}). ` +
          `Pro features are NOT under test. ` +
          `Detail: ${probe?.license?.detail ?? "no mu-plugin log — did the copy step run?"}`,
      );
    }
  }

  if (probe && probe.settled === false) {
    console.error(
      "WARNING: the blueprint's completion marker never arrived — the state below " +
        "was read while the site was still being built and may be stale.",
    );
  }

  if (probe && probe.environment_type !== "local") {
    console.error(
      `WARNING: WP_ENVIRONMENT_TYPE is "${probe.environment_type}", expected "local" — ` +
        `the defineWpConfigConsts step did not land.`,
    );
  }

  console.log(
    JSON.stringify({
      engine: "playground",
      url,
      admin: `${url}/wp-admin/`,
      user: "admin",
      pass: "password",
      autologin: true,
      pid: child.pid,
      log: logFile,
      stop: `node scripts/boot-wp.mjs --stop`,
      php: opt.php,
      wp: opt.wp,
      slug: info.slug,
      type: info.type,
      platform: process.platform,
      pro: proMounts.map((m) => ({ slug: m.slug, type: m.entry.type, path: m.dir })),
      licensed: opt.license ? (probe?.license?.state ?? "unknown") : false,
      license_seed: staged.verdicts,
      probe: probe
        ? {
            settled: probe.settled !== false,
            environment_type: probe.environment_type,
            active_theme: probe.active_theme,
            active_plugins: probe.active_plugins,
            pro_active: probe.pro?.checked ? probe.pro.active : null,
            pro_check: probe.pro?.expression ?? null,
            // WHY it could not be evaluated. Omitting this made a missing
            // Freemius submodule ("no Freemius instance") indistinguishable
            // from a licence failure, which cost two CI round trips.
            pro_reason: probe.pro?.reason ?? null,
            license: probe.license ?? null,
          }
        : { error: "probe did not answer" },
      probe_url: `${url}/?tgqa_probe=${staged.token}`,
      caveats: ["SQLite not MySQL", "no real cron", "no outbound mail"],
    }),
  );
  process.exit(0);
}

// -------------------------------------------------------------------- wp-env

if (opt.engine === "wp-env") {
  try {
    execFileSync(isWindows ? "docker.exe" : "docker", ["info"], {
      stdio: "ignore",
    });
  } catch {
    console.error(
      "wp-env needs Docker Desktop running. Start it, or use --engine playground.",
    );
    process.exit(1);
  }

  const run = (args) =>
    execFileSync(
      npxCommand(),
      ["--yes", "@wordpress/env@latest", ...args].map(shellQuote),
      {
        cwd: info.root,
        stdio: "inherit",
        shell: isWindows,
      },
    );

  run(["start"]);
  try {
    run([
      "run",
      "cli",
      "wp",
      info.type === "theme" ? "theme" : "plugin",
      "activate",
      info.slug,
    ]);
  } catch {
    console.error(`note: could not activate ${info.slug} automatically`);
  }

  console.log(
    JSON.stringify({
      engine: "wp-env",
      url: "http://localhost:8888",
      admin: "http://localhost:8888/wp-admin/",
      user: "admin",
      pass: "password",
      autologin: false,
      slug: info.slug,
      type: info.type,
      platform: process.platform,
      caveats: [],
    }),
  );
  process.exit(0);
}

console.error(`unknown engine: ${opt.engine}`);
process.exit(2);
