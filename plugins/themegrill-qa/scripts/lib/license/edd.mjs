/**
 * EDD Software Licensing, over HTTP.
 *
 * Modelled on what the products actually send, not on the EDD documentation:
 * `UR_Updater_Key_API` (includes/admin/updater/class-ur-plugin-updater-api.php)
 * posts `license`, `url` and `edd_action` to `{store}/edd-sl-api/` and sends NO
 * `item_id` — the store resolves the product from the key. `item_id` is
 * therefore optional here and sent only when the registry names one.
 *
 * Everything is form-encoded POST, which is what the products send and what the
 * EDD endpoint expects; a GET works too but is not what production does, and
 * matching production is the whole point of testing.
 */

import { redact, scrub } from "./registry.mjs";

/**
 * The documented `error` values, mapped to something a human can act on.
 *
 * This table is the reason the adapter exists at all. "Activation failed" with
 * no reason costs hours; "the key expired on 2026-01-04" costs a renewal.
 */
const ERRORS = {
  missing: "the key is not recognised by this store — wrong key, or wrong store",
  expired: "the licence expired",
  disabled: "the licence was revoked or disabled",
  revoked: "the licence was revoked or disabled",
  no_activations_left: "the licence has reached its activation limit",
  key_mismatch: "the key does not belong to this product",
  invalid_item_id: "the item_id does not match the key's product",
  item_name_mismatch: "the key does not belong to this product",
  site_inactive: "this site is not among the licence's activated sites",
  // Ambiguous by design at the EDD end: `check_license` answers "invalid" both
  // for a key the store has never seen and for a real key not yet activated on
  // this URL. Saying only the second would send someone hunting an activation
  // problem for a key with a typo in it, so the message names both.
  invalid: "the store does not recognise this key for this site — unknown key, or not activated here",
  license_not_activable: "this is a bundle key — use the product-specific key",
};

function endpoint(entry) {
  const base = String(entry.store_url).replace(/\/+$/, "");
  const path = entry.api_path ?? "/edd-sl-api/";
  return base + (path.startsWith("/") ? path : `/${path}`);
}

async function call(entry, action, key, siteUrl, timeoutMs = 20000) {
  const body = new URLSearchParams({
    edd_action: action,
    license: key,
    url: siteUrl,
  });
  if (entry.item_id) body.set("item_id", String(entry.item_id));

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint(entry), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: ac.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      return {
        outcome: "unknown",
        reason: `store returned HTTP ${res.status}`,
        raw: scrub(text.slice(0, 400), [key]),
      };
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      // A store behind a WAF or a maintenance page answers 200 with HTML. That
      // is a harness problem, not an invalid licence, and the exit code must
      // say so — hence "unknown" rather than "invalid".
      return {
        outcome: "unknown",
        reason: "store did not return JSON (maintenance page, WAF, or wrong store_url?)",
        raw: scrub(text.slice(0, 400), [key]),
      };
    }
    return interpret(data, key);
  } catch (err) {
    return {
      outcome: "unknown",
      reason:
        err.name === "AbortError"
          ? `store did not answer within ${timeoutMs}ms`
          : `could not reach the store: ${scrub(err.message, [key])}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The `license` values that are a definite NO, with or without an `error`.
 *
 * This list is here because of something checked rather than assumed, against
 * the real wpeverest.com store: **`check_license` omits `error` entirely.**
 *
 *   check_license    {"success":false,"license":"invalid","item_id":false,…}
 *   activate_license {"success":false,"license":"invalid",…,"error":"missing"}
 *
 * The first implementation keyed the verdict off `error`, so a `check` of a bad
 * key came back "unknown" — which routes a genuinely invalid licence to the
 * harness owner as a suspected store outage. `license` is the authoritative
 * field; `error` only refines the reason when the store bothers to send it.
 */
const NEGATIVE = new Set([
  "invalid",
  "expired",
  "disabled",
  "revoked",
  "inactive",
  "site_inactive",
  "item_name_mismatch",
  "failed",
]);

/**
 * One EDD response object -> our verdict.
 *
 * `license: "valid"` is the only thing that counts as valid. A recognised
 * negative is a definite no. Anything else is "unknown", never a silent pass —
 * reporting coverage that does not exist is the failure mode this whole layer is
 * built to prevent.
 */
function interpret(data, key) {
  if (data && data.error_code) {
    return { outcome: "unknown", reason: scrub(String(data.error ?? data.error_code), [key]), raw: data };
  }

  const activationsLeft =
    data?.license_limit === 0 || data?.license_limit === "0"
      ? "unlimited"
      : (data?.activations_left ?? null);

  const common = {
    expires: data?.expires ?? null,
    license_limit: data?.license_limit ?? null,
    site_count: data?.site_count ?? null,
    activations_left: activationsLeft,
    item_name: data?.item_name ?? null,
    raw: data,
  };

  if (data?.license === "valid") return { outcome: "valid", ...common };

  const err = data?.error ? String(data.error) : null;
  const state = data?.license ? String(data.license) : null;

  if (err || (state && NEGATIVE.has(state))) {
    return {
      outcome: "invalid",
      error: err ?? state,
      // `error` is the specific reason when the store sends one; `license`
      // alone is all `check_license` gives us, and it still names the state.
      reason:
        (err && ERRORS[err]) ||
        (state && ERRORS[state]) ||
        `store reported: ${err ?? state}`,
      ...common,
    };
  }

  return {
    outcome: "unknown",
    reason: `store answered without a license verdict (license=${JSON.stringify(data?.license ?? null)})`,
    ...common,
  };
}

/** Activate this site against the store. */
export function activate(entry, key, siteUrl) {
  return call(entry, "activate_license", key, siteUrl);
}

/** Ask the store what it thinks, without changing anything. */
export function check(entry, key, siteUrl) {
  return call(entry, "check_license", key, siteUrl);
}

/** Release this site's activation. */
export function deactivate(entry, key, siteUrl) {
  return call(entry, "deactivate_license", key, siteUrl);
}

/**
 * What the mu-plugin needs in order to put the result where WordPress sees it.
 *
 * The Node side owns the protocol; PHP only writes options. That split is what
 * keeps the mu-plugin small enough to trust.
 */
export function seedFor(entry, key, verdict) {
  return {
    provider: "edd",
    option_key: entry.option_key,
    option_status: entry.option_status ?? null,
    transient_plan: entry.transient_plan ?? null,
    key,
    key_redacted: redact(key),
    status: verdict?.outcome === "valid" ? "valid" : "invalid",
    store_url: entry.store_url,
    api_path: entry.api_path ?? "/edd-sl-api/",
    item_id: entry.item_id ?? null,
    response: verdict?.raw ?? null,
  };
}
