/**
 * Read the mail a test site was asked to send, on any engine.
 *
 * Playground cannot send mail and has no catcher to read, so "the member was
 * emailed" had nothing to observe. `tgqa-seed.php` (SUITE.md §2c) records what
 * `wp_mail()` is asked to send, and this is the client for it: plain `fetch`, no
 * Playwright dependency, so any product's helpers can wrap it.
 *
 * Capture is OFF until `captureMail(true)`, which also clears the log. Turn it off
 * in teardown: a capturing site sends no mail at all.
 *
 * The probe URL is the one the runner exports as `TGQA_PROBE_URL`.
 */

/** @return {{origin: string, token: string}|null} */
function seedBase(probeUrl = process.env.TGQA_PROBE_URL) {
	if (!probeUrl) {
		return null;
	}
	try {
		const u = new URL(probeUrl);
		const token = u.searchParams.get("tgqa_probe");
		return token ? { origin: u.origin, token } : null;
	} catch {
		return null;
	}
}

/** True when the runner staged the seed endpoint for this run. */
const mailCaptureAvailable = (probeUrl) => seedBase(probeUrl) !== null;

/**
 * Playground's autologin answers the first request with a redirect that sets
 * cookies, and a POST sent into it loses its body. A GET first, following the
 * redirects by hand with the cookies it sets, leaves a jar every later request can
 * send. Without it the first POST of a run is the one that fails.
 */
async function warmUp(origin) {
	const jar = new Map();
	let url = origin + "/";
	for (let i = 0; i < 8; i++) {
		const res = await fetch(url, {
			redirect: "manual",
			headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") },
		});
		for (const c of res.headers.getSetCookie?.() ?? []) {
			const [pair] = c.split(";");
			const eq = pair.indexOf("=");
			jar.set(pair.slice(0, eq), pair.slice(eq + 1));
		}
		const next = res.headers.get("location");
		if (res.status < 300 || res.status >= 400 || !next) {
			break;
		}
		url = new URL(next, url).href;
	}
	return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
}

async function mailCall(body, probeUrl) {
	const base = seedBase(probeUrl);
	if (!base) {
		throw new Error("no TGQA_PROBE_URL: the seed endpoint was not staged for this run");
	}
	const cookie = await warmUp(base.origin);
	const res = await fetch(`${base.origin}/?tgqa_seed=${base.token}&op=mail`, {
		method: body === undefined ? "GET" : "POST",
		headers: { cookie, "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
		redirect: "follow",
	});
	const json = await res.json().catch(() => ({}));
	if (!res.ok) {
		throw new Error(`seed mail refused (HTTP ${res.status}): ${json.error ?? "no reason given"}`);
	}
	return json;
}

/**
 * Start (`true`) or stop (`false`) recording. Starting clears the log.
 *
 * @param {boolean} on
 * @param {string}  [probeUrl] Defaults to TGQA_PROBE_URL.
 */
const captureMail = async (on, probeUrl) => {
	await mailCall({ capture: !!on }, probeUrl);
};

/**
 * Everything recorded since capture started, oldest first.
 *
 * @return {Promise<Array<{to: string[], subject: string, message: string, headers: unknown}>>}
 */
const capturedMail = async (probeUrl) => (await mailCall(undefined, probeUrl)).mail;

/**
 * Poll until a captured mail matches, or return null after `timeoutMs`. Polls
 * because a request that sends mail can answer before the mail is recorded.
 *
 * @param {(m: object) => boolean} match
 * @param {number} [timeoutMs]
 * @param {string} [probeUrl]
 */
const waitForMail = async (match, timeoutMs = 10000, probeUrl) => {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const found = (await capturedMail(probeUrl)).find(match);
		if (found || Date.now() >= deadline) {
			return found ?? null;
		}
		await new Promise((r) => setTimeout(r, 500));
	}
};

module.exports = { mailCaptureAvailable, captureMail, capturedMail, waitForMail };
