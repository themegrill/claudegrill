/**
 * The one way specs run PHP or WP-CLI against a test site.
 *
 * Everything else in this package builds on it. It exists as a single module
 * because the alternative — each fixture file assembling its own
 * `eval "..."` command — means each one escapes slightly differently, and the
 * first fixture value containing an apostrophe breaks whichever one got it
 * wrong.
 *
 * The PHP is base64-encoded rather than quoted, so the command string is
 * alphanumeric plus `+/=` and cannot collide with any quoting layer between here
 * and the shell. Uglier to read; removes a whole class of fixture bug.
 *
 * SECURITY — read before wiring this up. This needs an endpoint that executes
 * arbitrary PHP. Whatever mu-plugin provides it must exist only on disposable
 * test sites and must never appear in a free or pro build. Put an assertion in
 * the release checklist rather than trusting that nobody copies it into `src/`.
 * Under `wp-env` prefer `npx wp-env run tests-cli` from the shell where you can;
 * this REST route is for state changes needed mid-spec.
 */

const CLI_ROUTE = "/claudegrill/v1/cli";

/**
 * Runs a WP-CLI command. `command` excludes the leading `wp`.
 *
 * @param {Object} requestUtils Playwright request utils.
 * @param {string} command      e.g. "option delete colormag_setup_state".
 * @return {Promise<string>} Trimmed stdout.
 */
async function wpCli(requestUtils, command) {
	const { stdout } = await requestUtils.rest({
		method: "POST",
		path: CLI_ROUTE,
		data: { command },
	});

	return String(stdout ?? "").trim();
}

/**
 * Evaluates PHP on the test site.
 *
 * @param {Object} requestUtils Playwright request utils.
 * @param {string} php          PHP source. No wrapping quotes needed.
 * @return {Promise<string>} Trimmed stdout.
 */
async function evalPhp(requestUtils, php) {
	const encoded = Buffer.from(php.trim(), "utf8").toString("base64");

	return wpCli(requestUtils, `eval "eval(base64_decode('${encoded}'));"`);
}

/**
 * Escapes a value for interpolation into a single-quoted PHP string.
 *
 * Use this for every value that comes from a spec rather than from this package.
 * It matters most for the boundary tests that deliberately pass awkward input:
 * without it the harness breaks instead of the product being tested, which is
 * the least useful possible failure.
 *
 * @param {*} value Raw value.
 * @return {string} Safe inside single quotes.
 */
function php(value) {
	return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/**
 * Reads an option as JSON, or null when unset.
 *
 * @param {Object} requestUtils Playwright request utils.
 * @param {string} name         Option name.
 * @return {Promise<*>}
 */
async function getOption(requestUtils, name) {
	const out = await evalPhp(
		requestUtils,
		`$v = get_option( '${php(name)}', null ); echo wp_json_encode( $v );`,
	);

	try {
		return JSON.parse(out);
	} catch {
		return null;
	}
}

/**
 * Writes an option.
 *
 * @param {Object} requestUtils Playwright request utils.
 * @param {string} name         Option name.
 * @param {*}      value        Any JSON-serialisable value.
 * @return {Promise<void>}
 */
async function setOption(requestUtils, name, value) {
	const json = Buffer.from(JSON.stringify(value), "utf8").toString("base64");

	await evalPhp(
		requestUtils,
		`update_option( '${php(name)}', json_decode( base64_decode( '${json}' ), true ), false );`,
	);
}

module.exports = { CLI_ROUTE, wpCli, evalPhp, php, getOption, setOption };
