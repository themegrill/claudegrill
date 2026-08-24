# Zakra

<!--
PARTIALLY PRE-FILLED. Everything marked TODO must be confirmed by the Zakra
maintainer before the agents rely on it.
-->

- **Slug:** `zakra`
- **Type:** theme
- **Repo:** TODO
- **Pro companion:** Zakra Pro — TODO repo
- **Jira project key:** TODO
- **Supported:** WP TODO+ · PHP TODO+
- **Companion plugins:** ThemeGrill Demo Importer (starter sites)

## What it is, in two sentences

A lightweight multipurpose WordPress theme sold on flexibility and speed: broad
customizer control over layout, header, footer, typography and colours, with a
large library of starter demos aimed at many different site types. Unlike
ColorMag it is not tied to one content shape, so its risk surface is the
*combination* of layout options rather than any single page type.

## Critical flows

1. **Fresh activation** — no fatal, no notice, frontend renders styled.
2. **Starter demo import** — import completes, matches preview, menus/widgets/
   front-page settings assigned. TODO: list which demos are highest priority.
3. **Customizer round-trip** — change → live preview → publish → hard reload →
   reopen and confirm the control reads back. Run this against at least one
   control from each panel, not just one control overall.
4. **Container / layout width options** — boxed, wide, full: each must apply on
   every template type, not only the front page.
5. **Header layout variants** — TODO: enumerate. Each variant × logo present/
   absent × menu present/absent.
6. **Footer widget columns** — 1/2/3/4 column configurations render correctly
   and collapse sensibly at 375px.
7. **Sidebar layout per context** — global default vs per-post override. The
   per-post override winning over the global setting is a classic regression.
8. **Page-builder compatibility** — Elementor full-width and canvas templates
   suppress theme header/footer correctly.
9. **WooCommerce** — shop/product/cart/checkout styling and mobile usability.
10. **Performance guard** — Zakra sells partly on being lightweight. TODO: agree
    a page-weight / request-count budget and assert against it; a silent
    regression here undermines the product's main claim.

## Admin surfaces

| Surface | Where | Notes |
|---|---|---|
| Customizer | `/wp-admin/customize.php` | Primary settings surface |
| Demo Importer | Appearance → Demo Importer | Companion plugin |
| Per-post meta box | Post/page editor sidebar | Layout overrides |
| Widgets | `/wp-admin/widgets.php` | TODO: registered sidebars |

## Frontend surfaces

Front page (static + blog), archives (category/tag/author/date), single, page,
search, 404, plus WooCommerce templates. Screenshot each at 375 / 768 / 1440.

## Roles and capabilities

| Role | Should be able to | Must NOT be able to |
|---|---|---|
| Administrator | Everything | — |
| Editor | Publish; set per-post layout overrides | Customizer, demo import |
| Author | Own posts, own layout overrides | Others' posts |
| Subscriber | Read | Any theme setting |
| Logged out | Read | Everything admin |

TODO: confirm which capability actually gates the per-post layout meta box —
if it is `edit_posts` rather than something narrower, note it here as intended.

## Integrations

- **Elementor** — heavily used with Zakra; canvas/full-width templates matter.
- **WooCommerce**
- **Gutenberg** — wide/full alignment must respect the container width setting.
- **ThemeGrill Demo Importer**

## Data model / persistence

Theme mods in `theme_mods_zakra`, plus per-post meta for layout overrides.

```bash
wp option get theme_mods_zakra --format=json
wp post meta list <id>
```

TODO: confirm option name and the per-post meta keys.

## Upgrade paths that matter

TODO. Same reasoning as ColorMag: record every settings migration, what must
survive, and how to seed the previous shape.

## Known-fragile areas

Starting candidates for a highly-configurable multipurpose theme:

- Interaction between global layout settings and per-post overrides
- Header variants at the tablet breakpoint
- Container width vs Gutenberg wide/full alignment
- Elementor canvas template still emitting theme header markup
- Footer column collapse on mobile
- Settings from a previously-imported demo bleeding into a newly-imported one

## Known non-issues

- TODO

## Environment notes

- Demo import needs networking and is slow; prefer `wp-env` for full import runs.
- Elementor is a heavy plugin; installing it inside Playground works but adds
  significant boot time. Budget for it or use `wp-env` for Elementor missions.
