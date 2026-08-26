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
 *   node scripts/boot-wp.mjs --stop
 */

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { resolveQaHome } from "./lib/qa-home.mjs";
import { isWindows, killTree, npxCommand, shellQuote } from "./lib/platform.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

const qaHome = resolveQaHome(here);

const stateFile = path.join(os.tmpdir(), "themegrill-qa-playground.json");
const logFile = path.join(os.tmpdir(), "themegrill-qa-playground.log");

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
};

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--engine") opt.engine = argv[++i];
  else if (a === "--wp") opt.wp = argv[++i];
  else if (a === "--php") opt.php = argv[++i];
  else if (a === "--port") opt.port = Number(argv[++i]);
  else if (a === "--with") opt.with.push(argv[++i]);
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
      `themegrill-qa-blueprint-${process.pid}.json`,
    );
    const filled = fs
      .readFileSync(blueprint, "utf8")
      .replaceAll("__SLUG__", info.slug)
      .replaceAll("__ENTRY__", info.entry);
    fs.writeFileSync(rendered, filled);
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
