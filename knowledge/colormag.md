# ColorMag

<!--
PARTIALLY PRE-FILLED. Everything marked TODO is a guess or a blank that the
ColorMag maintainer must confirm before the agents rely on it. A wrong line in
this file produces confidently wrong QA, so correcting these is the highest-
value hour anyone can spend on this pipeline.
-->

- **Slug:** `colormag`
- **Type:** theme
- **Repo:** TODO
- **Pro companion:** ColorMag Pro — TODO repo
- **Jira project key:** TODO
- **Supported:** WP TODO+ · PHP TODO+
- **Companion plugins:** ThemeGrill Demo Importer (starter sites)

## What it is, in two sentences

A magazine / news WordPress theme. Its value to a customer is the front page:
a grid of category-driven news blocks with featured sliders, plus heavy
customizer control over colours, typography, header layout and post layout.

## Critical flows

Ordered by blast radius. The agent tests these first.

1. **Fresh activation** — activate on a site with existing posts → front page
   renders without a fatal, notice, or unstyled flash → no console errors.
2. **Starter demo import** — Appearance → Demo Importer → import a demo →
   completes without timeout → front page matches the demo preview →
   menus, widgets and front-page settings are all assigned.
3. **Customizer round-trip** — change a setting → preview updates live → Publish
   → hard reload the frontend → the change persists → reopen the customizer and
   the control still shows the new value. *This three-way check (preview, front,
   re-read) catches the most common class of theme bug.*
4. **Front page news blocks** — assign categories to each block → correct posts
   appear in the correct block, in the correct order, respecting the post count.
5. **Header layout variants** — switch between each header/logo layout → logo,
   menu, search and social icons all still render and are clickable.
6. **Primary menu at mobile width** — hamburger opens, dropdowns and third-level
   items are reachable, menu closes, focus is not trapped.
7. **Archive / single / search / 404** — each renders with correct sidebar
   placement and pagination.
8. **WooCommerce** — shop, product, cart and checkout inherit theme styling and
   are usable at 375px.
9. **Theme switch away and back** — customizer settings survive. TODO: confirm
   expected behaviour; theme mods are per-theme so some loss is by design.

## Admin surfaces

| Surface | Where | Notes |
|---|---|---|
| Customizer | `/wp-admin/customize.php` | The main settings surface |
| Demo Importer | Appearance → Demo Importer | Provided by companion plugin |
| Widgets | `/wp-admin/widgets.php` | TODO: list theme-specific widgets |
| Menus | `/wp-admin/nav-menus.php` | TODO: list registered menu locations |

## Frontend surfaces

Front page (static and blog), category archive, tag archive, author archive,
date archive, single post, page, search results, 404. Every one of these must be
screenshotted at 375 / 768 / 1440 during a sweep.

TODO: list the theme's own widgets and any shortcodes.

## Roles and capabilities

| Role | Should be able to | Must NOT be able to |
|---|---|---|
| Administrator | Customize, import demos, switch theme | — |
| Editor | Publish content | Reach the customizer or demo importer |
| Subscriber | Read the frontend | Any theme option |
| Logged out | Read the frontend | Everything admin |

## Integrations

- **WooCommerce** — TODO: which templates are overridden.
- **Elementor** — TODO: full-width / canvas template support.
- **Gutenberg** — block styling, wide/full alignment, editor styles matching
  frontend.
- **ThemeGrill Demo Importer** — required for starter sites.

## Data model / persistence

Settings are **theme mods** (`get_theme_mod` / `set_theme_mod`), stored in the
`theme_mods_colormag` option. To verify a save actually persisted, read that
option directly rather than trusting the customizer UI:

```bash
wp option get theme_mods_colormag --format=json
```

TODO: confirm the option name and list any settings stored outside theme mods.

## Upgrade paths that matter

TODO — this is the section most worth filling in. For each major version
transition that migrated settings, record: what changed, what must survive, and
how to seed the old shape. An update that silently resets a customer's colours
is the worst bug this theme can ship.

## Known-fragile areas

Seed from your own bug history. Starting candidates for a magazine theme:

- Front-page news block category assignment after a demo import
- Sticky header behaviour combined with the admin bar
- Menu dropdowns at the tablet breakpoint
- Featured image aspect ratios across block layouts
- RTL layout
- Customizer controls that depend on another control being enabled first

## Known non-issues

<!-- Every false positive the agent reports gets a line here, with a reason. -->

- TODO

## Environment notes

- Demo import needs **networking enabled** in the Playground blueprint and will
  be slow; allow generous timeouts.
- Demo import writes many attachments — under SQLite this is fine but slow.
  Prefer `wp-env` for a full demo-import test.
