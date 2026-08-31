/**
 * Freemius — and the deliberate decision NOT to reimplement its API.
 *
 * Freemius activation is an opt-in handshake performed by the vendored SDK from
 * inside WordPress: it registers an install, exchanges the key for a user and a
 * licence, and stores the result under the `fs_accounts` option in a shape the
 * SDK owns and changes between versions. Reproducing that over HTTP would mean
 * pinning ourselves to SDK internals we do not control, and getting it subtly
 * wrong produces a site that LOOKS licensed and is not.
 *
 * So this adapter does two things and no more:
 *
 *   1. hands the key to the mu-plugin, which calls the product's own activation
 *      entry point (recorded in `licenses.json`, found by reading the product
 *      source — FS_ThemeGrill::init for ColorMag Pro, FS_ZakraTheme::init for
 *      Zakra Pro);
 *   2. verifies afterwards, from inside WordPress, that
 *      `can_use_premium_code()` returns true.
 *
 * If activation fails, that is reported as a Freemius-side failure. We do not
 * try to force it.
 *
 * One fact from reading the vendored SDK (2.13.1) that shapes the CI design:
 * `FS_Site::is_localhost_by_address()` — freemius/includes/entities/class-fs-site.php:143
 * — treats `127.0.0.1`, `localhost`, and hosts ending `.local` / `.test` /
 * `.dev` / `.staging` as localhost. Playground serves on 127.0.0.1, so every
 * Playground boot is a localhost install and consumes no activation slot. That
 * is why `boot-wp.mjs` must NOT rewrite the site URL to something prettier.
 */

import { redact } from "./registry.mjs";

/** Freemius resolves state inside WordPress; there is nothing to ask from here. */
export function activate() {
  return {
    outcome: "deferred",
    reason:
      "Freemius activation runs inside WordPress via the SDK — boot the site with --license and read the verdict from the mu-plugin's log line",
  };
}

export const check = activate;

export function deactivate() {
  return {
    outcome: "deferred",
    reason:
      "Freemius deactivation runs inside WordPress via the SDK; deactivate from the product's own licence screen",
  };
}

/**
 * Config for the mu-plugin's Freemius branch.
 *
 * `accessor` is a PHP expression naming the product's own Freemius instance —
 * `FS_ThemeGrill::freemius()`. The mu-plugin evaluates it defensively and gives
 * up loudly if the class is not there, rather than reaching into the SDK.
 */
export function seedFor(entry, key) {
  return {
    provider: "freemius",
    freemius_id: entry.freemius_id,
    freemius_slug: entry.freemius_slug,
    accessor: entry.accessor ?? null,
    key,
    key_redacted: redact(key),
    localhost_exempt: true,
  };
}

/**
 * Does this host count as localhost to Freemius?
 *
 * Transcribed from the SDK rather than remembered, so a boot on `127.0.0.1` can
 * be reported as slot-free with a citation instead of a hope.
 */
export function isLocalhost(url) {
  const s = String(url);
  if (s.includes("127.0.0.1") || s.includes("localhost")) return true;
  let host;
  try {
    host = new URL(s.startsWith("http") ? s : `http://${s}`).hostname;
  } catch {
    return false;
  }
  const starts = ["local.", "dev.", "test.", "stage.", "staging."];
  const ends = [".dev", ".test", ".staging", ".local", ".example", ".invalid"];
  return starts.some((p) => host.startsWith(p)) || ends.some((e) => host.endsWith(e));
}
