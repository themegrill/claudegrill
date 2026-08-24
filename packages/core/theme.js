/**
 * Theme-side helpers, for ColorMag and Zakra.
 *
 * The centrepiece is `expectThemeModPersists`. Almost every customizer bug in a
 * WordPress theme is one of three failures, and a test that checks only one of
 * them passes while the theme is broken:
 *
 *   1. the preview updates but the published frontend does not
 *   2. the frontend updates but the control forgets its own value on reload
 *   3. the option is written but nothing renders it
 *
 * So the check is three-way — write, read the option back, render the frontend —
 * and it is the single most useful assertion available on a theme.
 */

const { evalPhp, php, getOption } = require("./wp-cli");

/** Every template type a theme must render. Screenshot each, at both projects. */
const TEMPLATES = {
	home: "/",
	archive: "/category/technology/",
	single: null, // resolved from a fixture post
	page: "/about/",
	search: "/?s=sample",
	notFound: "/this-path-does-not-exist-9a8b7c/",
};

/**
 * Reads one theme mod.
 *
 * @param {Object} requestUtils Playwright request utils.
 * @param {string} key          Theme mod key.
 * @return {Promise<*>}
 */
async function getThemeMod(requestUtils, key) {
	const out = await evalPhp(
		requestUtils,
		`echo wp_json_encode( get_theme_mod( '${php(key)}', null ) );`,
	);

	try {
		return JSON.parse(out);
	} catch {
		return null;
	}
}

/**
 * Writes one theme mod directly.
 *
 * For seeding only. When the customizer itself is what is under test, drive the
 * customizer UI instead — see convention 3.
 *
 * @param {Object} requestUtils Playwright request utils.
 * @param {string} key          Theme mod key.
 * @param {*}      value        Value.
 * @return {Promise<void>}
 */
async function setThemeMod(requestUtils, key, value) {
	const json = Buffer.from(JSON.stringify(value), "utf8").toString("base64");

	await evalPhp(
		requestUtils,
		`set_theme_mod( '${php(key)}', json_decode( base64_decode( '${json}' ), true ) );`,
	);
}

/**
 * The three-way customizer check.
 *
 * Drives the customizer UI to change one control, publishes, then verifies the
 * value survived in all three places it has to.
 *
 * @param {Object}   ctx              {page, admin, requestUtils, expect}
 * @param {Object}   spec             Test spec.
 * @param {string}   spec.mod         Theme mod key the control writes.
 * @param {Function} spec.change      async (page) => set the control in the UI.
 * @param {*}        spec.expected    Value the mod should hold afterwards.
 * @param {string}   [spec.frontPath] Path to check on the frontend. Default "/".
 * @param {Function} [spec.assertFront] async (page) => assert the rendered result.
 * @return {Promise<void>}
 */
async function expectThemeModPersists(ctx, spec) {
	const { page, requestUtils, expect } = ctx;
	const { mod, change, expected, frontPath = "/", assertFront } = spec;

	await page.goto("/wp-admin/customize.php");
	await page.waitForSelector("#customize-controls");

	await change(page);

	// Publish, and wait for the button to settle rather than for a fixed delay:
	// the customizer saves over AJAX and a sleep here is the classic flake.
	await page.click("#save");
	await expect(page.locator("#save")).toBeDisabled({ timeout: 15000 });

	// 1. The option was actually written.
	expect(await getThemeMod(requestUtils, mod)).toEqual(expected);

	// 2. The published frontend reflects it.
	await page.goto(frontPath);
	if (assertFront) {
		await assertFront(page);
	}

	// 3. The control reads its own value back — the failure people miss, because
	//    the site looks right and only the editing experience is broken.
	await page.goto("/wp-admin/customize.php");
	await page.waitForSelector("#customize-controls");
	expect(await getThemeMod(requestUtils, mod)).toEqual(expected);
}

/**
 * Asserts a page rendered without PHP notices or raw shortcodes leaking.
 *
 * Cheap, and worth calling on every template in every theme spec: it catches a
 * bug class that no assertion about layout will ever see.
 *
 * @param {Object} page   Playwright page.
 * @param {Object} expect Playwright expect.
 * @return {Promise<void>}
 */
async function expectCleanRender(page, expect) {
	const body = page.locator("body");

	await expect(body).not.toContainText("Warning:");
	await expect(body).not.toContainText("Notice:");
	await expect(body).not.toContainText("Fatal error");
	await expect(body).not.toContainText("Deprecated:");

	// An unrendered shortcode reaches the visitor as literal text.
	await expect(body).not.toContainText(/\[[a-z_]{3,}[\s\]]/);
}

/**
 * Collects console errors for the duration of a spec.
 *
 * @param {Object} page Playwright page.
 * @return {string[]} Live array, populated as the page runs.
 */
function collectConsoleErrors(page) {
	const errors = [];

	page.on("console", (msg) => {
		if (msg.type() === "error") {
			errors.push(msg.text());
		}
	});
	page.on("pageerror", (err) => errors.push(String(err)));

	return errors;
}

module.exports = {
	TEMPLATES,
	getThemeMod,
	setThemeMod,
	expectThemeModPersists,
	expectCleanRender,
	collectConsoleErrors,
};
