# ColorMag — current state

ColorMag is the pilot product and is **already set up**. This is its status, not
a walkthrough — for onboarding a new product, follow
[SETUP.md](SETUP.md) Phase 2, and Phase 4 for its pro edition.

## What is in place

### ColorMag (free)

| | Where |
|---|---|
| Suite manifest | `.themegrill-qa/suite.json` |
| Knowledge file | `.themegrill-qa/knowledge.md` |
| Ingested docs | `.themegrill-qa/docs/`, from `https://docs.themegrill.com/colormag` |
| Specs | `tests/e2e/specs/` — 18 files, 23 tests, 19 `@fresh` / 4 `@demo` |
| CI | `.github/workflows/qa-suite.yml` |

### ColorMag Pro

A standalone **theme**, not a companion plugin — it replaces ColorMag rather than
loading alongside it, which is why its jobs boot their own site.

| | Where |
|---|---|
| Suite manifest | `.themegrill-qa/suite.json`, with `area_paths` for all 8 areas |
| Knowledge file | `.themegrill-qa/knowledge.md` |
| Specs | `tests/e2e/specs/` — 19 files, 31 tests, all `@fresh`: 18 `@pro`, 12 free, 1 `@unlicensed` |
| CI | `.github/workflows/qa-pro.yml` |
| Licence | `TGQA_LICENSE_COLORMAG_PRO` — in `.env.local` locally, a repo secret in CI |

Only `footer` has no coverage. Note that its `style.css` declares
`Text Domain: colormag`, so `detect-product.mjs` reports slug `colormag` for the
pro checkout — harmless against an existing site, but it means a Playground boot
would mount it at `themes/colormag`.

Docblock hygiene is clean: zero incomplete docblocks, zero untagged tiers.

Re-derive any of this at any time:

```bash
cd <colormag checkout>
node <themegrill-qa>/plugins/themegrill-qa/scripts/suite-index.mjs --pretty
```

## Two open problems

**1. Ten of sixteen areas have no `@fresh` specs at all**

```
customization, demo-import, faq, footer, get-started,
how-to, rtl, upgrade, widgets, woocommerce
```

Nothing automated covers them. A green CI tick says nothing about any of them.
Under the no-AI-on-PR model the suite is the only safety net, so this list is the
real backlog — every `/themegrill-qa:verify-fix` that ends VERIFIED should
shorten it.

**2. The `@fresh` tier does not honour its own tag**

Measured, same specs, two environments:

| Environment | Result |
|---|---|
| Developer's Local site | 19 passed, 1 skipped |
| Clean Playground site | **11 passed, 9 failed** |

The failures cluster, and none of them is random:

- seven Customizer specs time out on `page.waitForFunction` after 20s waiting for
  `wp.customize.state("saved")` — Playground runs that React app under WASM PHP
  and it is slower than the wait allows
- the roles spec fails at `rest_cookie_invalid_nonce` creating its subscriber
- the mobile-menu spec cannot find its "Dropdown Parent" link, because the
  blueprint seeds a different menu than the Local site has
- the CMAG-741 spec exceeds its 120s timeout

Per [SUITE.md §2](SUITE.md), `@fresh` means "runs on a clean `boot-wp` site". Nine
of these were validated against a Local site with content, so the tag is a promise
they do not keep. Either the blueprint seeds what they need, the Customizer waits
tolerate WASM speeds, or they are `@demo` and the fresh tier is smaller than it
looks.

**Do not make the CI check required until this is resolved.** A required check
that is red on arrival is one nobody ever turns green.

## Local runs

`.themegrill-qa/.env.local` points the suite at the developer's own site.
Gitignored in both repos — confirmed at `colormag/.gitignore:43` and
`colormag-pro/.gitignore:44`.

```
TGQA_BASE_URL=http://test-colormag.local
CM_ADMIN_USER=admin          # CMP_* in colormag-pro
CM_ADMIN_PASS=password
```

```bash
node <themegrill-qa>/plugins/themegrill-qa/scripts/run-suite.mjs --tier fresh --json
```

For ColorMag Pro, add the key to the same file and pass `--pro`:

```
TGQA_LICENSE_COLORMAG_PRO=...
```

```bash
node <themegrill-qa>/plugins/themegrill-qa/scripts/run-suite.mjs --tier fresh --pro colormag-pro --json
```

ColorMag Pro must be the **active theme** on the site — nothing checks that for
you on an existing site, and the pro specs would otherwise run against free code.
The licence probe installs and removes itself; there is nothing to set up.

Verified on `test-colormag.local`: the probe reports
`FS_ThemeGrill::freemius()->can_use_premium_code()` returning **true**, which is
what lets a `@pro` run proceed.

Measured runtimes: ~47s for the full `@fresh` tier against the Local site, ~35s
scoped to two areas, ~291s against Playground.

## Not yet done

- `area_paths` in `suite.json`, so PR runs actually narrow. A proposed mapping is
  in `examples/colormag-area-paths.json` — it needs a maintainer's review before
  being applied. Until then every run is a full run, which is correct, just slower.
- The `write-spec` proof gate has never been exercised on a real fix. CMAG-741 is
  the obvious candidate: the fix is on
  `fix/cmag-741-related-posts-random-offset` and nothing guards it.
