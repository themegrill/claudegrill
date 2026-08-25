# Spec conventions

Every spec in every ThemeGrill product repo follows these. They are lifted from a
working WordPress plugin suite that had already settled them in practice, adapted
for a catalogue that is part themes and part plugins.

Ten rules. The first four are about not writing brittle tests; the next five are
about tests that still mean something in a year; the tenth is about a test being
runnable at all in the place it is meant to run.

---

## 1. Select on markup we own

A spec that reaches for a theme's class names passes on the theme it was written
against and fails on every other one. That is the opposite of the point.

**Plugins** — add your own data attributes to plugin-rendered markup and select
only on those:

```js
const TIMELINE = '[data-ur-membership-list]';
await expect(page.locator(TIMELINE)).toBeVisible();
```

Prefix per product: `data-ur-*`, `data-ef-*`, `data-mst-*`, `data-ba-*`.

**Themes** — the markup *is* the product, and much of what a theme renders is
WooCommerce or block output we cannot annotate. So semantic selectors are the
default:

```js
await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sample Article 1');
```

Reserve owned data attributes for theme-specific chrome that has no semantic
equivalent — header layout variants, footer column counts, customizer-driven
regions:

```html
<header data-colormag-header-layout="centered">
```

Adding those is a real change to shipped markup. It is a small one, and it is
worth it: without them, every header-layout test is pinned to class names that
change on the next redesign.

**Never** select on `.wp-block-*`, `.woocommerce-*`, Elementor classes, or
generated utility classes.

## 2. Expose state through data attributes, not inferred from text

For React admin screens — Masteriyo, URM, Everest Forms builders — do not infer
which step or tab you are on from visible copy, which is translated and gets
reworded. Have the app state its own state:

```html
<div data-ur-wizard-step="payment">
```

```js
await expect(page.locator('[data-ur-wizard-step]'))
  .toHaveAttribute('data-ur-wizard-step', 'payment');
```

This is the single highest-value change you can ask a developer to make for
testability, and it costs one attribute.

## 3. Seed state; click only what is under test

If a spec is about the membership list, do not walk the setup wizard to get
there — write the option:

```js
await completeSetup(requestUtils);   // one CLI call
```

A four-step click-through in someone else's fixture is four more things that can
fail for reasons unrelated to what is being tested. Click through a flow **only
when that flow is the subject of the spec**, and then click all of it.

Seeding goes through WP-CLI (`packages/core/wp-cli.js`), because it is the one
route that can set up any state the product can reach.

## 4. Tag every fixture; clean up after yourself

Every row a spec creates carries a meta key identifying it:

```js
const { createPost, cleanupFixtures } = require('@themegrill-qa/core');

test.afterAll(async ({ requestUtils }) => {
  await cleanupFixtures(requestUtils);
});
```

Untagged fixtures accumulate, slow the database, and — worse — leak between
specs. A spec that picks "the first published product" behaves differently
depending on what an earlier spec left behind, which is how you get a suite that
passes alone and fails in sequence.

Clean up **child tables before parent tables**, and clean up everything you
created — posts, users, terms, custom-table rows. A teardown that misses one
table leaves orphan rows that a later count assertion will trip over.

## 5. Write the negative test first

The most valuable spec in a suite is usually the one asserting that something is
*absent*:

```js
test('renders nothing before the plugin is configured', async ({ page }) => {
  await page.goto('/my-account/');
  await expect(page.locator('[data-ur-profile]')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('[user_registration');
});
```

That `not.toContainText('[')` line catches raw shortcode leakage — a real bug
class that ships regularly and that no happy-path test sees.

For themes the equivalent is: before demo import, before configuration, on a site
with no content — does it render cleanly, or does it emit a PHP notice and an
empty container?

## 6. Every spec states why it exists

A docblock on each spec file saying what promise it guards, and a comment on any
helper that takes a non-obvious route:

```js
/**
 * Orders are created through WP-CLI rather than the Store API, because the Store
 * API needs a cart and a checkout and none of these specs are about purchasing —
 * they are about what the plugin shows once an order exists.
 */
```

The person who reads this next is deciding whether a failure is a real bug or a
stale test. Whether they can tell depends entirely on whether you wrote down why.

## 7. Guard declared invariants with named tests

Where a product's knowledge file states a hard rule, there is a spec whose only
job is to enforce it, referencing the rule:

```js
// .themegrill-qa/knowledge.md, hard rule 4: a subscriber can never reach the
// customizer. Any regression here is a security issue, not a UX one.
test('subscriber cannot reach the customizer', async ({ page, requestUtils }) => {
  await loginAs(requestUtils, page, 'qa_subscriber');
  await page.goto('/wp-admin/customize.php');
  await expect(page.locator('#customize-controls')).toHaveCount(0);
});
```

This is the bridge between the knowledge layer and the test layer. Invariants
declared in prose and never asserted decay silently; invariants with a test
attached do not.

## 8. Two viewports, by project — not by loop

Configure desktop and mobile as Playwright projects so every spec runs at both
for free, rather than each spec looping viewports itself:

```js
projects: [
  { name: 'desktop', use: { viewport: { width: 1440, height: 900 } } },
  { name: 'mobile',  use: { viewport: { width: 375,  height: 812 } } },
],
```

Mobile layout regressions are a dominant bug class across this catalogue and this
is the cheapest possible coverage of them.

## 9. The matrix runs the other way for themes

Know which shape you are in, because a spec written for the wrong one tests
nothing:

| | Under test | Varied across |
|---|---|---|
| **A plugin** (URM, Everest Forms, Masteriyo, block plugins) | the plugin | themes — Storefront, Astra, Kadence, Zakra, ColorMag, Twenty Twenty-Five |
| **A theme** (ColorMag, Zakra) | the theme | plugins — WooCommerce, Elementor, your own block plugins — plus WP and PHP versions |

For plugins, activating a different theme must not change any assertion — that is
what rule 1 buys you. For themes, the varied axis is what is *installed
alongside*, and the assertions are mostly visual, which is what snapshots are
for.

## 10. Tier every test, and match the harness the product already has

### Tiering

A spec that cannot run where it is meant to run is not coverage — it is a red
tick somebody will learn to ignore. So every test declares where it can run, as
a tag **in its title**, because the title is what Playwright's `--grep` matches:

| Tag | Runs on | Meaning |
|---|---|---|
| `@fresh` | a clean `boot-wp` site seeded only by the blueprint | CI-safe. This is the tier that gates PRs. |
| `@demo` | a site with the product's demo content imported | Local / nightly only. **Not CI coverage.** |

```js
test('centered header keeps the tagline @fresh @header', async ({ page }) => {
```

Three consequences, and none of them is negotiable:

- **An untagged test is treated as `@demo`.** The conservative reading. A test
  nobody tiered was written against whatever site its author had open, and
  assuming that was a clean one is how a green CI run becomes a lie.
- **CI runs `@fresh` only.** A `@demo` test cannot be reproduced on a runner, so
  it must never gate a pull request.
- **If a bug only reproduces on a demo-imported site, the blueprint requirement
  is itself the finding.** Report what the blueprint would need to seed. Do not
  write a `@demo` spec and call the area covered.

Add an `@area` tag matching a critical flow from the product's knowledge file —
`@header`, `@customizer` — so a sweep shard can run only its own area, and so
`suite-index.mjs` can tell the agent which areas it does *not* need to explore.

Each test also carries the docblock from `SUITE.md` §3: `@area`, `@tier`,
`@guards`, `@source`, and the `@why` that rule 6 already requires.

### Match the existing harness

Earlier drafts of this document assumed `.spec.js`. ColorMag's suite is
TypeScript on pnpm. **The suite is the reality and the convention yields to it:
match the product's existing harness and do not introduce a second one.**

If the product writes TypeScript on pnpm, write TypeScript on pnpm — not
JavaScript, not a new config, not a different test-utility package because you
prefer it. A product with two harnesses has neither: the second rots, because
only the person who added it ever runs it.

The examples throughout this document are JavaScript for readability. They are
illustrations of a rule, not a statement about which language to write in.

---

## Two WordPress Customizer traps

Both of these were found the hard way during the first live ColorMag session, and
both will bite any spec that drives the Customizer.

### Clear stale changesets before every Customizer spec

Every Customizer session — including every automated one — leaves an `auto-draft`
`customize_changeset` post behind. They accumulate, and WordPress's own "restore
the more recent autosave" prompt can then silently load one **instead of the
published state**. A spec that opens the Customizer and reads a control may be
reading an abandoned draft from an earlier run.

So the fixture that opens the Customizer trashes stale changesets first:

```js
await evalPhp(requestUtils, `
  $ids = get_posts( array(
    'post_type'   => 'customize_changeset',
    'post_status' => 'auto-draft',
    'numberposts' => -1,
    'fields'      => 'ids',
  ) );
  foreach ( $ids as $id ) { wp_trash_post( $id ); }
  echo count( $ids );
`);
```

This is WordPress core behaviour, not a product bug. It presents as a flaky test
or as "the setting reverted", which is why it is worth knowing about before you
spend an afternoon on it.

### A spec that publishes must revert in teardown, not at the end of the test

Found the hard way on ColorMag: a Customizer spec published a test value and then
failed *before* reaching its own revert line. It left the live site mutated, and
the damage surfaced somewhere else entirely — an unrelated layout spec measured a
gap three times its expected size. The failure looked like a layout bug and was
not one.

Reverting on the happy path only is not enough, because the case that needs the
revert most is the failing one.

```js
// Snapshot once, globally.
export default async function globalSetup() {
  const mods = await getOption(requestUtils, `theme_mods_${SLUG}`);
  fs.writeFileSync(".auth/theme-mods-baseline.json", JSON.stringify(mods));
}

// Restore in the fixture's teardown, which runs whether the test passed or not.
export const test = base.extend({
  customizer: async ({ requestUtils }, use) => {
    await use(makeCustomizer(requestUtils));
    const baseline = JSON.parse(fs.readFileSync(".auth/theme-mods-baseline.json", "utf8"));
    await setOption(requestUtils, `theme_mods_${SLUG}`, baseline);
  },
});
```

Any spec that writes site-wide state — theme mods, options, active theme, active
plugins — restores it in a fixture teardown. Never in the test body.

### Do not wait on a button's disabled state to know a publish finished

Also found on ColorMag: waiting for `#save` to re-enable after publishing took
8.5 seconds once and had still not happened after 45 seconds on another run —
while the failure screenshot showed the button visibly enabled. Three specs were
shelved because of it.

The button's state is a rendering detail of whatever framework draws the
Customizer. Wait on the save itself:

```js
async function publish(page) {
  const saved = page.waitForResponse(
    (r) => r.url().includes("admin-ajax.php") && r.status() === 200 &&
           (r.request().postData() ?? "").includes("customize_save"),
  );
  await page.click("#save");
  await saved;

  // Then confirm from the Customizer's own state, not from the DOM.
  await page.waitForFunction(
    () => window.wp?.customize?.state?.("saved")?.get() === true,
    null,
    { timeout: 15000 },
  );
}
```

The general rule: when an assertion about "has it finished" can be made against
the network or the application's own state, prefer that over anything visual.
Visual waits on a framework-rendered admin screen are the main source of
slow-flaky specs on these products.

`wp.customize('some_id').set(value)` updates the underlying setting reliably —
publish and the live frontend both reflect it. But on a Customizer built as a
React app it does **not** necessarily trigger the framework's own re-render, so
the *live preview* may not update even though nothing is broken. A real user
clicking the control does update it.

Consequences for specs:

- The **publish** and **reopen** legs of the three-way check are safe to automate
  via `.set()`.
- The **live-preview** leg is not, on a React-driven Customizer. Drive the actual
  control, or leave that leg to a human and say so in the spec.
- **Never report "live preview broken" from a `.set()`-driven test.** Confirm by
  hand first. This is the highest-probability false positive available on these
  products, and reporting it once costs more trust than the test was worth.

## Snapshots

Visual checks use Playwright's built-in snapshots, per project, per theme:

```bash
npm run test:e2e -- --update-snapshots
```

Two standing rules. **Never update snapshots in the same commit as a behaviour
change** — the diff is the only evidence of what changed, and a mixed commit
destroys it. And because `--update-snapshots` makes rubber-stamping a real
regression exactly as easy as accepting an intended restyle, snapshot diffs are
the one place an agent reviewer earns its keep: it classifies each diff as
intended or regression, and a human confirms.
