/**
 * Example spec — the house style, for a theme.
 *
 * **One file, one feature: the header layout.** Copy it into a product repo as
 * `tests/e2e/specs/header/header-layout.spec.js` and adapt. It exists to show
 * the conventions in use rather than to be run as-is: the theme mod keys and
 * control selectors below are placeholders, and `.themegrill-qa/knowledge.md`
 * is where the real ones are recorded.
 *
 * What it demonstrates, in order:
 *   1. the primary flow — the three-way customizer check, which is the
 *      assertion that matters most
 *   2. an edge case of the same feature — the layout at mobile width
 *   3. a negative case — what the feature must NOT do
 *   4. a regression scenario, carrying the keys that caused it to be written
 *
 * Note what is NOT here, because that is rule 11 (`CONVENTIONS.md`) in
 * practice. "Every template renders cleanly" and "a subscriber cannot reach the
 * customizer" are real specs this product needs, and neither belongs in this
 * file: they are their own features, in `specs/rendering/` and `specs/roles/`.
 * A file that collects everything an area touches is an area, not a feature, and
 * it grows until nobody can say what it covers.
 *
 * Note also what the regression scenario is called. It is named for the
 * behaviour a customer would describe; the two Jira keys live in `@guards`,
 * where they explain the history without becoming the test's identity. Both
 * tickets describe one user-visible behaviour, so they share one scenario
 * rather than getting one each — rule 11's table, row 5.
 *
 * Semantic selectors throughout, because this is a theme: the markup is the
 * product and much of it is WooCommerce or block output we cannot annotate.
 * See CONVENTIONS.md rule 1.
 */

const { test, expect } = require("@wordpress/e2e-test-utils-playwright");
const {
	createPost,
	cleanupFixtures,
	getThemeMod,
	setThemeMod,
	expectThemeModPersists,
	expectCleanRender,
} = require("@claudegrill/core");

test.describe("Header layout", () => {
	test.beforeAll(async ({ requestUtils }) => {
		await createPost(requestUtils, {
			title: "Sample Article One — a headline long enough to wrap on narrow viewports",
			category: "Technology",
		});
		await createPost(requestUtils, { title: "About", type: "page" });
	});

	test.afterAll(async ({ requestUtils }) => {
		await cleanupFixtures(requestUtils);
	});

	// ------------------------------------------------- 1. the primary flow

	/**
	 * @area    header
	 * @tier    fresh
	 * @source  human 2026-08-24
	 * @why     The layout control is the feature's main promise: what you pick in
	 *          the Customizer is what the site serves, and it survives a reload.
	 *          Asserts the control, the published value and the front end agree —
	 *          not how the layout is styled.
	 */
	test("a layout change survives publish, frontend and reload @fresh @header", async ({
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
					await p.click("li#accordion-section-colormag_header_options");
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

	// --------------------------------------------------- 2. an edge case

	/**
	 * @area    header
	 * @tier    fresh
	 * @source  human 2026-08-24
	 * @why     Mobile layout regressions are a dominant bug class across this
	 *          catalogue. Runs under both projects; only meaningful under
	 *          `mobile`, and harmless under `desktop` where the toggle is absent.
	 */
	test("the menu remains reachable at mobile width @fresh @header", async ({ page }) => {
		await page.goto("/");

		const toggle = page.getByRole("button", { name: /menu/i });

		if (await toggle.count()) {
			await toggle.click();
			await expect(page.getByRole("navigation", { name: /primary/i })).toBeVisible();
			await expect(page.getByRole("link", { name: "About" })).toBeVisible();
		}
	});

	// ------------------------------------------------- 3. the negative case

	/**
	 * @area    header
	 * @tier    fresh
	 * @source  human 2026-08-24
	 * @why     Theme mods are stored per theme, so losing them on a theme switch
	 *          is by design. The promise is narrower: coming BACK restores this
	 *          theme's own values rather than resetting them. States what the
	 *          feature must not do, per rule 5.
	 */
	test("settings survive switching away and back @fresh @header", async ({ requestUtils }) => {
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

	// ------------------------------------------------ 4. the regression

	/**
	 * @area    header
	 * @tier    fresh
	 * @guards  CMAG-650, CMAG-702
	 * @source  verify-fix 2026-08-25
	 * @why     A lone logo was squeezed to 30% of the header width, with no
	 *          Customizer setting able to compensate: a width constraint meant
	 *          for columns holding several builder elements was applied to every
	 *          column. Asserts the constraint applies only where it is earned.
	 *          Does NOT assert the column's exact width — that is styling, and
	 *          pinning it here would fail on every intended redesign.
	 */
	test("a lone logo keeps its full header column width @fresh @header", async ({ page }) => {
		await page.goto("/");

		const column = page.getByRole("banner").locator("[data-colormag-header-col]").first();
		await expect(column).toBeVisible();

		const { constrained, multiple } = await column.evaluate((el) => ({
			constrained: getComputedStyle(el).flexBasis !== "auto",
			multiple: el.dataset.colormagHeaderColElements !== "1",
		}));

		// The invariant the regression violated: constrain a column only when it
		// actually carries more than one builder element. Asserting the invariant
		// rather than a pixel width is what keeps this scenario meaningful across
		// header layouts it was never written against.
		expect(
			constrained && !multiple,
			"a single-element header column must not carry the multi-element width constraint",
		).toBe(false);
	});
});
