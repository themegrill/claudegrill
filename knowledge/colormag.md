# ColorMag — starter removed deliberately

**The real handbook is `.themegrill-qa/knowledge.md` in the ColorMag repository.**
Written from theme source, git history, the docs site, and a live browser session
against a running site. Read that, not this.

## Why this starter was deleted rather than updated

It was seeded from generic magazine-theme assumptions and **one of them was
wrong.** It listed as a critical flow:

> Front page news blocks — assign categories to each block → correct posts appear
> in the correct block

ColorMag 4.2.2 has no such control. Its live Customizer **Front Page** panel
contains exactly one toggle plus a Pro upsell, and the real mechanism is
WordPress widget areas populated through Appearance → Widgets — which ColorMag's
own documentation states plainly. The first live QA session caught it and
corrected the handbook, citing both the panel contents and the doc URL.

That is the failure mode this whole system is built to avoid, and a seed file is
the worst place for it: a wrong line in a handbook produces *confidently* wrong
QA, and a plausible-sounding genre assumption survives review far longer than an
obvious error would.

**So: never pre-fill a product handbook from what a product of that kind usually
does.** Derive structure from source, intent from the product's own docs,
fragility from git history, and behaviour from a browser. Leave everything else
`TODO`. `/knowledge-init` is built to work that way; use it instead of a starter.

The same warning applies to `zakra.md`, which is still an unverified starter and
should be treated as guesswork until a live session replaces it.
