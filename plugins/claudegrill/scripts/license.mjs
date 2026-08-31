#!/usr/bin/env node
/**
 * Own the licence layer for ThemeGrill's pro products.
 *
 * The rule this script exists to enforce: a `@pro` run either has a licence that
 * resolved to VALID, or it fails. There is no third state where the suite quietly
 * exercises the free code path and reports pro coverage. That would be worse than
 * having no pro suite at all, because it reports coverage that does not exist.
 *
 * Providers differ, and the difference is not cosmetic:
 *   edd       — a plain HTTP protocol we can drive from here (User Registration
 *               Pro, Everest Forms Pro).
 *   freemius  — an SDK handshake that only happens inside WordPress (ColorMag
 *               Pro, Zakra Pro). We hand over the key and verify afterwards; see
 *               lib/license/freemius.mjs for why we do not reimplement it.
 *
 * Output contract, as everywhere else in this repo: exactly one line of JSON on
 * stdout, human chatter on stderr.
 *
 * Exit codes — callers MUST distinguish these:
 *   0  valid
 *   1  invalid / expired / disabled — a real licence problem
 *   2  could not determine: no key, network failure, incomplete registry row.
 *      "Unlicensed" and "harness broken" are different incidents with different
 *      owners, and collapsing them sends a store outage to the product team.
 *
 * Usage
 *   node scripts/license.mjs status     --product colormag-pro
 *   node scripts/license.mjs activate   --product user-registration-pro --site-url http://127.0.0.1:9400
 *   node scripts/license.mjs deactivate --product user-registration-pro --site-url http://...
 *   node scripts/license.mjs seed       --product colormag-pro --out <dir>
 *   node scripts/license.mjs check-all
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { resolveQaHome } from "./lib/qa-home.mjs";
import * as edd from "./lib/license/edd.mjs";
import * as freemius from "./lib/license/freemius.mjs";
import {
  completeness,
  keyFor,
  loadEnvFile,
  loadRegistry,
  redact,
} from "./lib/license/registry.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const qaHome = resolveQaHome(here);

const ADAPTERS = { edd, freemius };

// ------------------------------------------------------------------ arguments

const argv = process.argv.slice(2);
const cmd = argv.shift();

const opt = {
  product: null,
  siteUrl: null,
  out: null,
  envFile: null,
  json: true,
};

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--product") opt.product = argv[++i];
  else if (a === "--site-url") opt.siteUrl = argv[++i];
  else if (a === "--out") opt.out = argv[++i];
  else if (a === "--env-file") opt.envFile = argv[++i];
  else {
    console.error(`unknown flag: ${a}`);
    process.exit(2);
  }
}

const COMMANDS = ["status", "activate", "deactivate", "seed", "check-all"];
if (!COMMANDS.includes(cmd)) {
  console.error(
    `usage: license.mjs <${COMMANDS.join("|")}> [--product <slug>] [--site-url <url>] [--out <dir>]`,
  );
  process.exit(2);
}

/** Human output. Never carries a key — see redact(). */
const say = (s) => process.stderr.write(`${s}\n`);

/** The single line of stdout, then out. */
function emit(payload, code) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  process.exit(code);
}

// ------------------------------------------------------------------- registry

let registry;
try {
  registry = loadRegistry(qaHome);
} catch (err) {
  say(err.message);
  emit({ ok: false, reason: "registry_unreadable", detail: err.message }, 2);
}

/**
 * `.env.local` next to the product under test, then next to this repo.
 *
 * A developer keeps one gitignored file beside the product they are working on;
 * CI supplies environment variables and this finds nothing, which is correct.
 */
function envFileCandidates() {
  if (opt.envFile) return [path.resolve(opt.envFile)];
  return [
    path.join(process.cwd(), ".themegrill-qa", ".env.local"),
    path.join(process.cwd(), ".env.local"),
    path.join(qaHome, ".env.local"),
  ];
}

const envFile = envFileCandidates().reduce(
  (acc, f) => ({ ...loadEnvFile(f), ...acc }),
  {},
);

function entryOrDie(slug) {
  const entry = registry[slug];
  if (!entry) {
    say(`unknown product: ${slug}`);
    say(`known: ${Object.keys(registry).join(", ")}`);
    emit({ ok: false, product: slug, reason: "unknown_product" }, 2);
  }
  return entry;
}

// --------------------------------------------------------------------- verdict

/**
 * What we hold and what the provider says, for one product.
 *
 * `network` false means: report only what is knowable locally. `status` uses it
 * so a developer can ask "is my key even set?" without a round trip and without
 * touching anybody's activation count.
 */
async function verdictFor(entry, { network, siteUrl }) {
  const key = keyFor(entry, envFile);
  const gaps = completeness(entry);

  const base = {
    product: entry.slug,
    provider: entry.provider,
    type: entry.type,
    requires: entry.requires ?? null,
    key_env: entry.key_env,
    key_present: Boolean(key),
    key_redacted: redact(key),
  };

  if (!gaps.complete) {
    return {
      ...base,
      state: "unknown",
      reason: `registry row is incomplete: missing ${gaps.missing.join(", ")}`,
      registry_incomplete: gaps.missing,
      exit: 2,
    };
  }

  if (!key) {
    return {
      ...base,
      state: "unknown",
      reason: `no key: set ${entry.key_env} in the environment or in a gitignored .env.local`,
      exit: 2,
    };
  }

  const adapter = ADAPTERS[entry.provider];
  if (!adapter) {
    return { ...base, state: "unknown", reason: `no adapter for provider "${entry.provider}"`, exit: 2 };
  }

  if (!network) {
    return { ...base, state: "held", reason: "key present; not checked with the provider", exit: 0 };
  }

  const url = siteUrl ?? "http://127.0.0.1:9400";
  const res = await adapter.check(entry, key, url);

  if (res.outcome === "deferred") {
    // Freemius. Not a failure — just not answerable from out here.
    return {
      ...base,
      state: "deferred",
      reason: res.reason,
      localhost_exempt: entry.provider === "freemius" ? freemius.isLocalhost(url) : null,
      exit: 0,
    };
  }

  return {
    ...base,
    state: res.outcome, // valid | invalid | unknown
    reason: res.reason ?? null,
    error: res.error ?? null,
    expires: res.expires ?? null,
    license_limit: res.license_limit ?? null,
    site_count: res.site_count ?? null,
    activations_left: res.activations_left ?? null,
    item_name: res.item_name ?? null,
    uncapped:
      res.license_limit === 0 || res.license_limit === "0" || res.activations_left === "unlimited",
    exit: res.outcome === "valid" ? 0 : res.outcome === "invalid" ? 1 : 2,
  };
}

// -------------------------------------------------------------------- commands

if (cmd === "status") {
  if (!opt.product) {
    say("status needs --product");
    emit({ ok: false, reason: "missing_product" }, 2);
  }
  const v = await verdictFor(entryOrDie(opt.product), { network: false });
  say(`${v.product}: ${v.state} — ${v.reason ?? "key present"} (${v.key_redacted})`);
  emit({ ok: v.exit === 0, ...v }, v.exit);
}

if (cmd === "activate" || cmd === "deactivate") {
  if (!opt.product) {
    say(`${cmd} needs --product`);
    emit({ ok: false, reason: "missing_product" }, 2);
  }
  const entry = entryOrDie(opt.product);
  const key = keyFor(entry, envFile);
  const gaps = completeness(entry);

  if (!gaps.complete) {
    say(`${entry.slug}: registry row is incomplete — missing ${gaps.missing.join(", ")}`);
    emit(
      { ok: false, product: entry.slug, state: "unknown", reason: "registry_incomplete", registry_incomplete: gaps.missing },
      2,
    );
  }
  if (!key) {
    say(`${entry.slug}: no key — set ${entry.key_env}`);
    emit({ ok: false, product: entry.slug, state: "unknown", reason: "no_key", key_env: entry.key_env }, 2);
  }

  const siteUrl = opt.siteUrl ?? process.env.TGQA_BASE_URL ?? null;
  if (!siteUrl) {
    say(`${cmd} needs --site-url (or TGQA_BASE_URL)`);
    emit({ ok: false, product: entry.slug, reason: "missing_site_url" }, 2);
  }

  const adapter = ADAPTERS[entry.provider];
  const res = await adapter[cmd](entry, key, siteUrl);

  if (res.outcome === "deferred") {
    say(`${entry.slug}: ${res.reason}`);
    emit({ ok: true, product: entry.slug, provider: entry.provider, state: "deferred", reason: res.reason }, 0);
  }

  const code = res.outcome === "valid" ? 0 : res.outcome === "invalid" ? 1 : 2;
  say(
    `${entry.slug}: ${res.outcome}${res.reason ? ` — ${res.reason}` : ""} ` +
      `(key ${redact(key)}, site ${siteUrl})`,
  );
  emit(
    {
      ok: code === 0,
      product: entry.slug,
      provider: entry.provider,
      action: cmd,
      state: res.outcome,
      reason: res.reason ?? null,
      error: res.error ?? null,
      expires: res.expires ?? null,
      license_limit: res.license_limit ?? null,
      site_count: res.site_count ?? null,
      activations_left: res.activations_left ?? null,
      site_url: siteUrl,
    },
    code,
  );
}

if (cmd === "seed") {
  // Write the config file the mu-plugin reads. Called by boot-wp.mjs --license.
  //
  // A file rather than wp-config constants, deliberately: constants defined in
  // wp-config end up in `wp config list`, in debug dumps, and in any plugin that
  // prints its environment. A file mounted only into the disposable site, mode
  // 0600, is reachable by PHP and by nothing else.
  if (!opt.product || !opt.out) {
    say("seed needs --product and --out <dir>");
    emit({ ok: false, reason: "missing_args" }, 2);
  }
  const entry = entryOrDie(opt.product);
  const key = keyFor(entry, envFile);
  const gaps = completeness(entry);

  if (!gaps.complete || !key) {
    const reason = !gaps.complete
      ? `registry row is incomplete: missing ${gaps.missing.join(", ")}`
      : `no key: set ${entry.key_env}`;
    say(`${entry.slug}: ${reason} — seeding a "not attempted" config so the run fails loudly`);
    // Still write a config. A missing file would let the mu-plugin no-op
    // silently, which is the one outcome this design forbids.
    const cfg = { product: entry.slug, provider: entry.provider, attempted: false, reason };
    fs.mkdirSync(opt.out, { recursive: true });
    const f = path.join(opt.out, "tgqa-license.json");
    fs.writeFileSync(f, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    emit({ ok: false, product: entry.slug, state: "unknown", reason, config: f }, 2);
  }

  const siteUrl = opt.siteUrl ?? process.env.TGQA_BASE_URL ?? "http://127.0.0.1:9400";

  let seed;
  let state = "deferred";
  if (entry.provider === "edd") {
    // Activate from here so the mu-plugin only has to write options — one HTTP
    // request per boot rather than one per spec.
    const res = await edd.activate(entry, key, siteUrl);
    state = res.outcome;
    seed = edd.seedFor(entry, key, res);
    say(
      `${entry.slug}: EDD activation ${res.outcome}${res.reason ? ` — ${res.reason}` : ""} ` +
        `(key ${redact(key)})`,
    );
  } else {
    seed = freemius.seedFor(entry, key);
    say(
      `${entry.slug}: Freemius key staged for in-WordPress activation ` +
        `(key ${redact(key)}, localhost=${freemius.isLocalhost(siteUrl)})`,
    );
  }

  const cfg = {
    product: entry.slug,
    provider: entry.provider,
    pro_check: entry.pro_check ?? null,
    site_url: siteUrl,
    attempted: true,
    expected_state: state,
    ...seed,
  };

  fs.mkdirSync(opt.out, { recursive: true });
  const f = path.join(opt.out, "tgqa-license.json");
  fs.writeFileSync(f, JSON.stringify(cfg, null, 2), { mode: 0o600 });

  const code = entry.provider === "edd" ? (state === "valid" ? 0 : state === "invalid" ? 1 : 2) : 0;
  emit(
    {
      ok: code === 0,
      product: entry.slug,
      provider: entry.provider,
      state,
      config: f,
      key_redacted: redact(key),
    },
    code,
  );
}

if (cmd === "check-all") {
  const results = [];
  for (const entry of Object.values(registry)) {
    // eslint-disable-next-line no-await-in-loop -- serial on purpose: a burst of
    // parallel activation checks against one store looks like abuse.
    const v = await verdictFor(entry, { network: true, siteUrl: opt.siteUrl });
    results.push(v);
    const bits = [v.state];
    if (v.expires) bits.push(`expires ${v.expires}`);
    if (v.activations_left !== null && v.activations_left !== undefined) {
      bits.push(`activations left ${v.activations_left}`);
    }
    if (v.reason) bits.push(v.reason);
    say(`${entry.slug.padEnd(24)} ${entry.provider.padEnd(9)} ${bits.join(" · ")}`);
  }

  // The exit code is the worst individual outcome, so a wrapper can branch on
  // one number. "unknown" outranks "invalid": a store we cannot reach is a
  // harness incident, and telling the product team their licence is bad when
  // the store is down wastes the wrong people's time.
  const code = results.some((r) => r.exit === 2) ? 2 : results.some((r) => r.exit === 1) ? 1 : 0;
  emit(
    {
      ok: code === 0,
      checked: results.length,
      products: results.map(({ exit, ...rest }) => rest),
    },
    code,
  );
}
