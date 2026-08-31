/**
 * Example spec — the house style, for a theme.
 *
 * Copy this into a product repo as `tests/e2e/customizer.spec.js` and adapt. It
 * exists to show the conventions in use rather than to be run as-is: the theme
 * mod keys and control selectors below are placeholders, and
 * `.themegrill-qa/knowledge.md` is where the real ones are recorded.
 *
 * What it demonstrates, in order:
 *   1. the negative test first — a clean render before anything is configured
 *   2. the three-way customizer check, which is the assertion that matters most
 *   3. an invariant from the knowledge file, guarded by a named test
 *   4. every template type rendering cleanly, at both projects
 *
 * Semantic selectors throughout, because this is a theme: the markup is the
 * product and much of it is WooCommerce or block output we cannot annotate.
 * See CONVENTIONS.md rule 1.
 */

const { test, expect } = require("@wordpress/e2e-test-utils-playwright");
const {
	createPost,
	createUser,
	loginAs,
	cleanupFixtures,
	getThemeMod,
	setThemeMod,
	expectThemeModPersists,
	expectCleanRender,
	collectConsoleErrors,
} = require("@claudegrill/core");

test.describe("ColorMag — customizer and rendering", () => {
	let postId;

	test.beforeAll(async ({ requestUtils }) => {
		postId = await createPost(requestUtils, {
			title: "Sample Article One — a headline long enough to wrap on narrow viewports",
			category: "Technology",
		});
		await createPost(requestUtils, { title: "About", type: "page" });
		await createUser(requestUtils, "qa_subscriber", "subscriber");
	});

	test.afterAll(async ({ requestUtils }) => {
		await cleanupFixtures(requestUtils);
	});

	// ---------------------------------------------------------------- 1

	test("renders every template cleanly with default settings", async ({ page }) => {
		const errors = collectConsoleErrors(page);

		for (const [name, path] of [
			["home", "/"],
			["archive", "/category/technology/"],
			["single", `/?p=${postId}`],
			["page", "/about/"],
			["search", "/?s=sample"],
			["404", "/no-such-path-9a8b7c/"],
		]) {
			await page.goto(path);
			await expectCleanRender(page, expect);
			await expect(page.locator("body")).toBeVisible();

			// Snapshot per template. Playwright suffixes by project, so desktop
			// and mobile land in separate files automatically.
			await expect(page).toHaveScreenshot(`colormag-${name}.png`, {
				fullPage: true,
				maxDiffPixelRatio: 0.01,
			});
		}

		expect(errors, `console errors: ${errors.join(" | ")}`).toHaveLength(0);
	});

	// ---------------------------------------------------------------- 2

	test("a header layout change survives publish, frontend and reload", async ({
		page,
		admin,
		requestUtils,
	}) => {
		await expectThemeModPersists(
			{ page, admin, requestUtils, expect },
			{
				// TODO replace with the real key from .themegrill-qa/knowledge.md
				mod: "colormag_header_layout",
				expected: "centered",

				async change(p) {
					await p.click('li#accordion-section-colormag_header_options');
					await p.selectOption(
						'[data-customize-setting-link="colormag_header_layout"]',
						"centered",
					);
				},

				async assertFront(p) {
					// Semantic: the site title and primary nav must both still be
					// reachable in the new layout. A layout switch that renders but
					// loses the menu is the actual bug being guarded here.
					await expect(
						p.getByRole("navigation", { name: /primary/i }),
					).toBeVisible();
					await expect(p.getByRole("link", { name: /QA Test Site/i })).toBeVisible();
					await expectCleanRender(p, expect);
				},
			},
		);
	});

	test("menu remains reachable at mobile width", async ({ page }) => {
		// Runs under both projects; only meaningful under `mobile`, and harmless
		// under `desktop` where the toggle is absent.
		await page.goto("/");

		const toggle = page.getByRole("button", { name: /menu/i });

		if (await toggle.count()) {
			await toggle.click();
			await expect(page.getByRole("navigation", { name: /primary/i })).toBeVisible();
			await expect(page.getByRole("link", { name: "About" })).toBeVisible();
		}
	});

	// ---------------------------------------------------------------- 3

	test("subscriber cannot reach the customizer", async ({ page }) => {
		// .themegrill-qa/knowledge.md, roles table: a subscriber must never reach
		// any theme option. A regression here is a security issue, not a UX one,
		// which is why it has its own named test rather than living in a checklist.
		await loginAs(page, "qa_subscriber");
		await page.goto("/wp-admin/customize.php");

		await expect(page.locator("#customize-controls")).toHaveCount(0);
	});

	// ---------------------------------------------------------------- 4

	test("settings survive switching away and back", async ({ requestUtils }) => {
		// Theme mods are stored per theme, so some loss is by design — the point
		// is that returning to ColorMag restores ColorMag's own values rather
		// than resetting them.
		await setThemeMod(requestUtils, "colormag_header_layout", "centered");

		await requestUtils.rest({
			method: "POST",
			path: "/claudegrill/v1/cli",
			data: { command: "theme activate twentytwentyfive" },
		});
		await requestUtils.rest({
			method: "POST",
			path: "/claudegrill/v1/cli",
			data: { command: "theme activate colormag" },
		});

		expect(await getThemeMod(requestUtils, "colormag_header_layout")).toBe("centered");
	});
});
