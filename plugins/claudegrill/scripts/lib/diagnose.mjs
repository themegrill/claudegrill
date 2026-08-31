/**
 * Turn a Playwright failure into a plain-English cause and a first thing to check.
 *
 * This is a lookup table, not a judgement. It runs on the PR path, where the
 * team's decision is that no agent runs at all, so it must be deterministic,
 * free, and reproducible — the same failure always reads the same way.
 *
 * The wording is deliberately hedged ("usually means"). A deterministic guess
 * that is labelled a guess helps a reviewer start in the right place; the same
 * guess dressed up as a finding would undercut invariant 5, which says a finding
 * needs reproduction twice plus cited evidence. Nothing here has either.
 *
 * Rules are matched in order, so the specific ones come before the general.
 */

/**
 * @param {object} failure a `failures[]` entry from run-suite.mjs
 * @returns {{id: string, cause: string, check: string, confidence: "high"|"medium"|"low"}}
 */
export function diagnose(failure = {}) {
  const text = [
    failure.error_full ?? failure.error ?? "",
    failure.error_snippet ?? "",
    ...(failure.errors ?? []),
  ].join("\n");

  for (const rule of RULES) {
    if (rule.match.test(text)) {
      return {
        id: rule.id,
        cause: rule.cause,
        check: typeof rule.check === "function" ? rule.check(failure, text) : rule.check,
        confidence: rule.confidence,
      };
    }
  }

  return {
    id: "unclassified",
    cause: "this failure does not match a known pattern",
    check:
      "open the trace in the report — it carries the last action, the DOM at " +
      "that moment, the network log and the console",
    confidence: "low",
  };
}

/** Where the failure actually happened, phrased for a sentence. */
function at(failure) {
  const loc = failure.location;
  if (!loc?.file) return "the failing line";
  return `${loc.file}:${loc.line ?? "?"}`;
}

const RULES = [
  {
    id: "site-unreachable",
    // The site never answered. This is the harness, and saying so stops a
    // developer hunting for a bug in a diff that was never exercised.
    match: /net::ERR_CONNECTION_REFUSED|net::ERR_EMPTY_RESPONSE|net::ERR_CONNECTION_RESET|ECONNREFUSED|502 Bad Gateway|503 Service/i,
    cause: "the WordPress site was not serving when the spec ran",
    check:
      "the boot step, not this change — nothing was actually tested. If the " +
      "engine was Playground, it sometimes reports ready before its workers are",
    confidence: "high",
  },
  {
    id: "auth",
    match: /rest_cookie_invalid_nonce|invalid nonce|\b401\b|\b403\b|not (?:logged in|authorized)|rest_forbidden/i,
    cause: "an authentication or nonce error, which is the environment rather than the product",
    check:
      "whether the site was logged in as admin when the spec ran, and whether " +
      "the spec creates a user or calls the REST API without a fresh nonce",
    confidence: "medium",
  },
  {
    id: "screenshot-diff",
    match: /toHaveScreenshot|Screenshot comparison failed|snapshot .*(?:doesn't|does not) match/i,
    cause: "the page renders differently from the committed baseline",
    check:
      "the expected / actual / diff images in the report — then decide whether " +
      "this is an intended restyle (update the baseline) or a regression (fix the code)",
    confidence: "high",
  },
  {
    id: "strict-mode",
    // Note this must precede the locator rules: a strict-mode violation also
    // mentions the locator, but the cause is the opposite of "not found".
    match: /strict mode violation/i,
    cause: "the selector matched more than one element, so Playwright refused to guess",
    check:
      (f) =>
        `the selector at ${at(f)} — this change probably duplicated the markup, ` +
        "or the selector is too loose to identify one node",
    confidence: "high",
  },
  {
    id: "wait-for-function",
    match: /waitForFunction|page\.waitForFunction/i,
    cause: "an in-page JavaScript condition never became true",
    check:
      "whether the script that sets it still runs. Known environment case: on " +
      "Playground the Customizer runs under WASM PHP and is slower than a 20s " +
      "wait allows, so this can be the engine rather than the diff",
    confidence: "medium",
  },
  {
    id: "element-missing",
    match: /resolved to 0 elements|waiting for (?:locator|get[A-Za-z]+)|toBeVisible|toBeAttached|element is not (?:visible|attached)/i,
    cause: "the element never appeared, so the test gave up waiting for it",
    check:
      (f) =>
        `the selector at ${at(f)}. Either this change altered the markup it ` +
        "looks for, or the page needs a state (a menu, a widget, demo content) " +
        "that a fresh site never seeds",
    confidence: "high",
  },
  {
    id: "assertion",
    // Last of the specific rules: many failures mention expect(), so anything
    // with a more precise signature must have matched already.
    match: /expect\(.*\)\.(?:toBe|toEqual|toHaveText|toHaveCount|toHaveValue|toHaveAttribute|toContain|toMatch)|Expected:.*\n.*Received:/is,
    cause: "the product did something different from what the spec asserts",
    check:
      "the Expected / Received lines below — this is a behavioural change, so " +
      "either the change is wrong or the spec now encodes stale behaviour",
    confidence: "high",
  },
  {
    id: "test-timeout",
    // Deliberately late. A test timeout is usually a SYMPTOM of one of the
    // above; reporting the symptom when the cause is visible helps nobody.
    match: /Test timeout of \d+ms exceeded|Timeout of \d+ms exceeded/i,
    cause: "the test ran out of time before finishing",
    check:
      "the last step in the trace rather than the assertion — a timeout names " +
      "where the test stopped, not what went wrong",
    confidence: "medium",
  },
  {
    id: "page-closed",
    match: /Target (?:page|closed|context or browser has been closed)|browser has been closed|Execution context was destroyed/i,
    cause: "the page went away mid-action — a crash, or a navigation the spec did not expect",
    check:
      "the console and network panes in the trace, at the last action before it closed",
    confidence: "medium",
  },
];
