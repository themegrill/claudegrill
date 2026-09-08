/**
 * The ThemeGrill SDK licensing protocol — `api.themegrill.com/licenses/*`.
 *
 * A third provider alongside `edd` and `freemius`. It is EDD-*shaped* in spirit
 * (activate / deactivate / check against a store, a `license` token in the
 * reply) but NOT on the wire, which is exactly why it cannot reuse `edd.mjs`:
 *
 *                    ThemeGrill SDK                     edd.mjs
 *   URL              {api}/licenses/<action>            {store}/edd-sl-api/
 *   action           a PATH segment                     `edd_action` param
 *   encoding         JSON body                          form-encoded body
 *   key field        `license_key`                      `license`
 *   site field       `site_url`                          `url`
 *   item_id          always sent                        optional
 *
 * Pointing the EDD adapter at this store would produce a well-formed request
 * that the store does not understand, and a false "licence not active" — the
 * worst failure mode for a QA gate, because it looks like a product bug.
 *
 * Proved against the vendored SDK:
 *   Licenser::request()      src/Modules/Licenser.php:226-260  (JSON, action in path)
 *   Licenser::activate()     :94-115
 *   Licenser::deactivate()   :124-143
 *   Licenser::check()        :153-168
 *   Licenser::is_valid()     :188   — stored status must be exactly 'valid'
 *   Product::API_URL         src/Product.php:131
 *   LICENSES_PATH            src/Modules/Licenser.php:34
 *
 * The one subtlety that matters: `activate`/`deactivate` wrap their payload in
 * a `data` key and `check` returns it flat (Licenser.php:255-260). Reading the
 * `license` token from the wrong level silently yields `undefined`, which would
 * read as "not valid" for a perfectly good key.
 */

import { redact, scrub } from "./registry.mjs";

/** Errors the store reports, in words a human can act on. */
const REASONS = {
  site_inactive: "the key is valid but not activated for this site — activate it first",
  expired: "the licence has expired",
  missing: "the store does not recognise this key",
  invalid: "the store rejected this key for this site",
  disabled: "the key has been revoked",
  no_activations_left: "the key has no activation slots left — deactivate another site",
  item_id_mismatch: "the key is for a different product than item_id claims",
  invalid_item_id: "the item_id does not match the key's product",
};

/** `{api}/licenses/<action>` — action in the path, not the body. */
function endpoint(entry, action) {
  const base = String(entry.store_url).replace(/\/+$/, "");
  const path = String(entry.api_path ?? "licenses/").replace(/^\/+|\/+$/g, "");
  return `${base}/${path}/${action}`;
}

async function call(entry, action, key, siteUrl, timeoutMs = 20000) {
  // `check` may omit site_url (Licenser.php:159); activate/deactivate never do.
  const body = { license_key: key, item_id: entry.item_id ?? null };
  if (siteUrl) body.site_url = siteUrl;
  if (body.item_id === null) delete body.item_id;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint(entry, action), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ac.signal,
    });

    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      // A store behind a WAF or a maintenance page answers with HTML. That is a
      // harness problem, not an invalid licence, and the outcome must say so.
      return {
        outcome: "unknown",
        reason: `store did not return JSON (HTTP ${res.status}; maintenance page, WAF, or wrong store_url?)`,
        raw: scrub(text.slice(0, 400), [key]),
      };
    }

    if (!res.ok && !data) {
      return { outcome: "unknown", reason: `store returned HTTP ${res.status}` };
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
 * One reply, one verdict.
 *
 * `license: "valid"` is the ONLY token that counts, because that is the only
 * one the product's own gate accepts (`Licenser::is_valid()`). In particular
 * `"active"` does NOT: the store returns it alongside `error: "site_inactive"`
 * for a good key that was never activated here, and treating that as licensed
 * would open the gate on a site with no activation.
 */
export function interpret(data, key) {
  // activate/deactivate wrap the payload; check returns it flat.
  const payload = data && typeof data.data === "object" && data.data !== null ? data.data : data;

  const token = payload?.license ? String(payload.license) : null;
  const error = payload?.error ? String(payload.error) : null;

  const common = {
    raw: payload ?? null,
    license: token,
    error,
    item_id: payload?.item_id ?? null,
    item_name: payload?.item_name ?? null,
    expires: payload?.expires ?? null,
  };

  if (token === "valid") {
    return { outcome: "valid", ...common };
  }

  if (error && error in REASONS) {
    return { outcome: "invalid", reason: REASONS[error], ...common };
  }

  if (token) {
    return {
      outcome: "invalid",
      reason: `store answered license="${token}"${error ? ` (error "${error}")` : ""}, and the product's gate accepts only "valid"`,
      ...common,
    };
  }

  // No token at all is not a verdict — an unrecognised envelope must never be
  // reported as "invalid licence", which would send someone hunting a key that
  // is fine.
  return {
    outcome: "unknown",
    reason: `store reply carried no "license" field${error ? ` (error "${error}")` : ""}`,
    ...common,
  };
}

export function activate(entry, key, siteUrl) {
  return call(entry, "activate", key, siteUrl);
}

export function check(entry, key, siteUrl) {
  return call(entry, "check", key, siteUrl);
}

export function deactivate(entry, key, siteUrl) {
  return call(entry, "deactivate", key, siteUrl);
}

/**
 * What the mu-plugin writes into WordPress.
 *
 * Unlike EDD-on-UR, `option_status` here holds a plain STATUS STRING, not the
 * decoded response object — `Licenser::store_status()` does
 * `update_option($key.'_license_status', $status)` and puts the object in a
 * separate `_license_data` option (Licenser.php:269-272). Writing an object
 * into `_license_status` would make `isValid()` false for a valid licence.
 */
export function seedFor(entry, key, verdict) {
  return {
    provider: "themegrill-sdk",
    option_key: entry.option_key,
    option_status: entry.option_status ?? null,
    option_data: entry.option_data ?? null,
    key,
    key_redacted: redact(key),
    // The literal the gate compares against, so the mu-plugin never has to
    // guess what "licensed" spells.
    status: verdict?.outcome === "valid" ? "valid" : (verdict?.license ?? "inactive"),
    store_url: entry.store_url,
    api_path: entry.api_path ?? "licenses/",
    item_id: entry.item_id ?? null,
    response: verdict?.raw ?? null,
  };
}
