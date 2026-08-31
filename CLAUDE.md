# claudegrill — orientation

Read this before changing anything in this repo.

## What this is

An AI-assisted QA platform for ThemeGrill's seven WordPress products (ColorMag,
Zakra, BlockArt, Magazine Blocks, User Registration & Membership, Everest Forms,
Masteriyo). It packages a QA loop — diff, boot WordPress, drive it with
Playwright, assess risk, report — into four entry points.

It is **one shared repo**. Product repos get a ~15-line caller workflow and a
knowledge file. Nothing is installed into them.

## Layout

```
.claude-plugin/
  marketplace.json       this repo IS the private plugin marketplace
plugins/claudegrill/   the installable plugin — everything the skills need
  .claude-plugin/plugin.json
  skills/                the judgement layer — one skill per entry point
    setup/               one-command onboarding for a product; resumable
    verify-fix/          local: verify the change in the working tree
    pr-qa-review/        CI: review a PR, post one comment
    full-test/           manual: whole-product sweep, fans out to CI
    regression-sweep/    the sweep body, invoked per shard
    knowledge-init/      draft a product's knowledge file
    write-spec/          verified finding -> committed regression spec
  scripts/               the deterministic layer — Node, zero dependencies
    setup-product.mjs    the deterministic half of `setup`: status + idempotent writes
    detect-product.mjs   identify the product from source -> JSON
    license.mjs          pro licences: status/activate/seed/check-all
    sync-secrets.mjs     per-repo secrets, because org secrets fail on Free
    scan-secrets.mjs     refuse to let a licence key become tracked content
    install-git-hook.mjs install the pre-commit half of that guard
    boot-wp.mjs          disposable WordPress, product mounted live
    run-suite.mjs        run the product's own Playwright suite -> JSON
    suite-index.mjs      what the suite covers, and what it does NOT
    report-suite.mjs     a run -> PR comment, step summary, self-contained HTML
    ingest-docs.mjs      docs site -> intent layer + area list (REST or sitemap)
    ingest-testsuite.mjs an existing Selenium/Robot suite -> specification
    estimate-cost.mjs    spend model, incl. the coverage projection
    lib/                 shared: qa-home, platform, spec-parse, suite-manifest,
                         affected, diagnose (the failure triage table)
      license/           registry (+ redaction), edd, freemius adapters
  licenses.json          the pro registry. Structure tracked, KEYS NEVER.
  templates/             CI workflow callers `setup-product.mjs` renders per product
  mu-plugins/            QA-only, mounted into the disposable site, never shipped
    tgqa-license.php     puts a licence where WordPress can see it
    tgqa-probe.php       reports what the booted site ACTUALLY believes
  hooks/
    hooks.json           Stop hook registration
    spec-guard.mjs       notices source changed with no spec; queues it
  blueprints/            seeded WordPress state for theme / plugin testing
packages/core/           shared spec helpers — the suite layer
knowledge/               templates and starter knowledge files
examples/                a spec in the house style, to copy into a product repo
.github/workflows/       reusable workflows + per-product caller examples
```

**[SUITE.md](SUITE.md) is the contract between this platform and a product's own
Playwright suite.** A product declares itself with `.themegrill-qa/suite.json`;
absent that file, everything degrades gracefully to the pre-suite behaviour.

Scripts and blueprints live **inside** the plugin because Claude Code copies a
plugin into its own cache, and a copied plugin cannot reach files outside its
directory. Anything a skill needs must travel with it.

**[PRO.md](PRO.md) covers the pro tier** — the four-product licensing inventory
(two Freemius, two EDD), per-repo secrets, and the safety rules
around unlimited lifetime keys. Read it before touching anything under
`scripts/lib/license/`.

**[CONVENTIONS.md](CONVENTIONS.md) governs every spec.** Read it before writing
one. Nine rules, drawn from a WordPress plugin suite that had already settled
them in practice, adapted for a catalogue that is part themes and part plugins.

## Invariants — do not break these

These are load-bearing. Changing one is a design decision, not a refactor.

1. **Scripts are deterministic; skills hold judgement.** Booting, mounting,
   detecting, seeding, ingesting: plain Node, free, reproducible. Only genuinely
   ambiguous work goes in a skill. When a skill's behaviour becomes predictable,
   move it into a script — that direction, never the reverse.

2. **`detect-product.mjs` emits JSON and nothing else.** Every consumer reads that
   contract. Add fields freely; never change or remove one.

3. **The environment is reachable only through `boot-wp.mjs --engine`.** No skill
   or workflow may start WordPress by another route. New environments are new
   branches in that one file.

4. **Nothing has write authority it does not need.** The PR runner comments; it
   never approves, merges, commits or pushes. The sweep files tickets only when a
   human passes `--file-tickets`, capped at five, into a triage state. Scheduled
   runs can never file tickets.

5. **A finding requires reproduction twice plus cited evidence.** The six-part
   gate in `regression-sweep` is the reason this is trusted. Do not relax it, and
   do not let any agent report a defect it only saw once. The sixth part — *is a
   green spec already guarding this?* — exists because a deterministic check
   disagreeing with an agent's single observation is nearly always the agent.

6. **Knowledge files live in the product repo** at `.themegrill-qa/knowledge.md`,
   so the PR that renames an option updates its description in the same commit.
   `detect-product.mjs` checks that path first.

7. **Never edit product source to make a check pass.** These skills verify; they
   do not fix. `write-spec` is bound by this too — if a product needs an owned
   selector to be testable, that is a reviewed PR by a human, not a side effect.

8b. **`@pro` never passes without a verified licence.** A `@pro` run either has a
   licence that resolved to VALID — checked through the booted site's own probe,
   not assumed — or it fails with `licence not active`, exit 2. It does not skip
   quietly and it does not pass. A pro suite that silently exercised the free
   code path reports coverage that does not exist, which is the same lie as the
   green check that meant nothing. `@unlicensed` is the other end of that axis
   and needs its own site, booted without `--license`. See PRO.md and SUITE.md §2b.

8. **Every test carries a tier tag, and CI runs only `@fresh`.** A `@demo` spec
   needs the product's demo content imported and cannot run on a runner, so it
   must never gate a PR. **An untagged test counts as `@demo`** — the
   conservative reading, because assuming otherwise turns a green CI run into a
   lie. See `SUITE.md` §2.

9. **Specs select on markup we own, never on theme or third-party class names.**
   Borrowed from `wpmake22/post-purchase-hub`, which states the reason exactly: a
   spec reaching for a theme's class names passes on the theme it was written
   against and fails on every other one, which is the opposite of the point.
   - **Plugins:** own data attributes, `data-<prefix>-*` (post-purchase-hub uses
     `data-pph-*`). Add them to plugin-rendered markup as needed.
   - **Themes:** semantic selectors first — `getByRole`, `getByLabel`, headings,
     landmarks — because the markup *is* the product and much of what a theme
     renders is WooCommerce or block output we cannot annotate. Reserve owned
     data attributes for theme-specific chrome: header layouts, footer columns,
     customizer-driven regions.

## Releasing the plugin — and one warning you must not "fix"

`plugin.json` deliberately carries **no `version` field**, and it must stay that
way. Verified against the plugin reference: **a version in `plugin.json` wins
over the marketplace entry's**, and setting it pins the plugin so users only get
updates when that field is bumped. Release control belongs in
`.claude-plugin/marketplace.json`, where the org's managed settings point.

**And do not add a `hooks` field to `plugin.json`.** The standard
`hooks/hooks.json` is discovered automatically; referencing it from the manifest
as well registers it twice and fails the **entire plugin load** — the plugin
installs, reports `✘ failed to load` with "Duplicate hooks file detected", and
contributes no skills at all. Confirmed on CLI 2.1.246. `manifest.hooks` is only
for *additional* hook files. This cost a release: 0.2.0 shipped broken.

So `claude plugin validate ./plugins/claudegrill` will **always** print:

```
⚠ version: No version specified. Consider adding a version following semver
```

**That warning is expected and correct. Do not silence it by adding a version to
`plugin.json`** — doing so moves release control to a file nobody bumps, and the
symptom is developers silently running a months-old copy of the skills.

To ship an update: edit, commit, bump `version` in `.claude-plugin/marketplace.json`,
push. With `autoUpdate: true` in the org's `extraKnownMarketplaces`, developers
pick it up within the hour or at next launch. Forget the bump and nobody gets it.

Note also that plugin skills are **namespaced**: installed as a plugin the entry
points are `/claudegrill:verify-fix`, not `/verify-fix`. A clone-installed copy
in `~/.claude/skills` is unnamespaced *and wins over the plugin's copy*, so the
two must not coexist on one machine.

## Where work lives — the three-layer memory

This is the shape of the whole platform, and the reason the suite layer exists.

| Layer | Remembers | Where | Re-checked by |
|---|---|---|---|
| `knowledge.md` | how the product is *meant* to work | product repo | reading it |
| findings ledger `.jsonl` | every confirmed finding, fingerprinted | product repo | reading it |
| `tests/e2e/**` | the bug, frozen as a deterministic assertion | product repo | the runner |
| agent exploration | anything not yet in the three above | — | **an agent, every run** |

**Work moves downward through those layers, never upward.**

Something the agent discovered becomes a spec. Something a spec proved becomes a
line in the knowledge file. Nothing that is already a spec goes back to being
explored — that is what `suite-index.mjs`'s `areas_uncovered` is for, and why
every skill reads it before deriving missions.

A verified finding that does not become a spec is a finding that has to be
rediscovered on every run, by an agent, forever. That is the reason for every
decision in the suite layer.

## Conventions

- **Everything is Node, with no dependencies.** ThemeGrill develops on Windows
  laptops and MacBooks, so nothing may require WSL, Python, a package install, or
  Docker (except the optional `wp-env` engine). Only `node`, `git` and `npx`.
  A new script is `.mjs` in `scripts/`, standard library only. If you find
  yourself wanting a dependency, that is a signal to simplify the script.
- **Windows is a first-class target, not an afterthought.** Concretely: join
  paths with `path.join`, spawn with `shell: true` and `npx.cmd` on `win32`, kill
  process trees with `taskkill /T` rather than a bare PID, create directory links
  as junctions so no elevation is needed, and strip `\r` when parsing files.
- Path resolution: derive locations from `import.meta.url`, and honour
  `THEMEGRILL_QA_HOME` when set. Never assume the working directory.
- Workflows: reusable (`workflow_call`) here, thin callers in product repos.
- Runs are scoped, not exhaustive — path filters, a triage step, draft-PR
  skipping, `cancel-in-progress`, Sonnet by default, Chromium only.
- Comments explain *why*, not *what*. The what is readable from the code.

## Build state

**Verified working**

- `detect-product.mjs` — theme and plugin headers, invocation two directories
  down, Jira key from branch name, pro-companion detection, knowledge-file
  precedence, clean non-zero exit on a non-WordPress directory
- `ingest-docs.mjs --rest` — against a mock built from ColorMag's live API: 11
  categories, correct counts, parent/child labelling, and an article tagged with
  both a parent and a child category filed under the child
- `ingest-testsuite.mjs` — Robot sections/tags/documentation/assertions, Python
  test functions with multiline typed signatures and raw docstrings, area
  derivation, tag facet-vs-feature inventory
- `estimate-cost.mjs` — agrees with the previous implementation to the cent
- `boot-wp.mjs` — Playground auto-mount and blueprint loading confirmed; the
  readiness check correctly *rejects* the 502s Playground emits while failing,
  and prints the blocked-network hint
- `boot-wp.mjs` against a real ColorMag checkout on Windows: mounted correctly,
  `theme-test.json` ran to completion, and the resulting site served the real
  page (confirmed via a cookie-aware request — `<title>QA Test Site …</title>`,
  the blueprint's own `setSiteOptions` value). Two real bugs found and fixed in
  the process — both were Windows/portability bugs, not test-environment
  artifacts:
  - `spawn(npx.cmd, {shell:true})` doesn't auto-quote array args for `.cmd`
    files, so any mount path containing a space (`Local Sites`, `Program
    Files`, …) broke `--path=`. Fixed with a `shellQuote()` helper.
  - `theme-test.json` hardcoded `sidebar-1` (a `_s`-starter-theme convention).
    ColorMag registers `colormag_right_sidebar` etc. and the widget-seed step
    failed outright. Fixed to discover the first registered sidebar at runtime.
- `run-suite.mjs` against a **real Playwright 1.62.1 suite** — a fixture theme
  with a manifest, a two-line config, and specs across two tiers and three
  areas. Confirmed: tier filtering (`fresh` 4, `demo` 2, `all` 6 on that
  fixture), area filtering, the untagged-means-demo rule, all three exit codes
  (0 pass / 1 tests failed / 2 harness broken — install failure, missing runner
  binary, timeout, malformed manifest, no base URL), the one-JSON-line stdout
  contract, and repo-relative attachment paths
- **Playwright's grep semantics, checked rather than assumed** (1.62.1): two
  `--grep` flags do *not* and-together, the second wins — so tier+area uses one
  pattern with two lookaheads, confirmed to intersect correctly.
  `--grep-invert` composes with `--grep`, which is what makes the demo tier
  expressible
- `suite-index.mjs` against the same fixture, including a deliberately mangled
  spec file: it degrades rather than crashing, and its test count agrees
  **exactly** with `playwright test --list` (9 in 3 files)
- `spec-guard.mjs` across six cases: clean tree, source-only, source+spec,
  a second run on the same branch, a non-WordPress git repo, a directory that
  is not a repo, and a missing stdin payload. Silent in every case but
  source-only
- `estimate-cost.mjs` still reproduces its three previous baselines byte for
  byte with no new flags passed
- **`run-suite.mjs` and `suite-index.mjs` against ColorMag's REAL suite**, not the
  fixture. `suite-index.mjs`: 18 spec files, 23 tests, 19 fresh / 4 demo, the
  real Jira guards map (CMAG-734, MZB-742, CMAG-733, …), and clean hygiene —
  zero incomplete docblocks, zero untagged tiers. `run-suite.mjs --tier fresh`:
  19 passed, 1 skipped, exit 0, ~47s against a Local site. The manifest's own
  `command` (a pnpm + `--config=tests/e2e/playwright.config.ts` invocation) and
  the JSON report parse both survived contact, including a config with a setup
  project and a named `colormag` project
- **Area filtering against that real suite**: `--area header` 6, `--area
  header,global` 11 (the OR, not the intersection), full fresh 20
- **The `.env.local` precedence**: base URL resolved from
  `.themegrill-qa/.env.local` with no `--base-url` passed, and the file
  confirmed gitignored in ColorMag
- **`--json` quiet mode**: one line of stdout, **zero bytes of stderr**, the
  runner's own output diverted to a log file. Before the fix it was ~2.5KB of
  Playwright progress going straight into the calling agent's context — `--json`
  was parsed and then never used
- **One live CI run**: `wp-core-watch.yml` executed and pushed
  `f6dea3d chore: WordPress 7.1 swept` as `themegrill-qa-bot`. This is the first
  workflow in this repo to run at all
- `claude plugin validate` passes on both the plugin and the marketplace
- All YAML and JSON parses; every `.mjs` passes `node --check`

- **`boot-wp.mjs` end to end, on macOS, with the JSON handoff.** Three bugs were
  found and fixed getting here, and the second is the one that had blocked this
  for the whole project:
  - **Mount used the directory basename, not the slug.** `--path` auto-mounts at
    `themes/<basename>`; the blueprint activates `<slug>`. They agree only when
    the checkout directory is named after the product. CI checks out to
    `product/`, so a real `suite.yml` run died on blueprint step #2 with "Theme
    not found". Fixed with `--no-auto-mount` plus an explicit slug-built
    `--mount`, confirmed by booting the real theme from a directory named
    `product` and watching it land at `themes/colormag`.
  - **`waitForServer` could never have succeeded, on any platform.** Playground's
    `--login` makes `/` answer 302 with cookies and `Location: /` — a redirect to
    itself that only terminates once the client sends the cookies back. A bare
    `fetch(url, {redirect:"follow"})` keeps no cookies, so it bounced until
    Node's redirect limit threw and the `catch` swallowed it as "not listening".
    Diagnosed against a live site: cookieless `curl` looped, `curl -L -c jar -b
    jar` returned 200 and 71KB of correct markup from the same server at the same
    moment. **The earlier Windows report was this bug, not a platform issue and
    not the SQLite `lockWholeFile` warnings it was provisionally blamed on.**
    `waitForServer` now carries a cookie jar and follows redirects by hand:
    ready in 664ms against a site the old code polled for 600s and never saw.
  - **The blueprint was not idempotent.** `wp term create` errors with "A term
    with the name provided already exists" on any re-boot of a cached site —
    the common path, since Playground keeps the site directory between boots.
    Replaced with a `term_exists` guard; a second boot now runs clean.

- **A green check meant nothing until now.** A live `suite.yml` run on ColorMag
  PR #297 reported "QA suite — passed, 0 passed · 0 failed · 0s" and a green tick,
  on a product with 20 `@fresh` specs. `ok` was computed as `failed === 0`, which
  is trivially true when nothing ran. **Zero tests is now exit 2**, reported as a
  broken harness. Any required check built on the old behaviour was decorative.

- **Diff-scoped CI**, via `area_paths` in the manifest and `run-suite.mjs
  --since`. Verified against ColorMag's real branch: a source-only CMAG-741 diff
  narrows to `content, header, activation, rtl`; a harness change forces the full
  tier with that stated as the reason; a docs-only diff runs nothing; an unmapped
  source file forces the full tier. The safety rule is that silence costs runner
  time, never coverage.

- **The failure report — `report-suite.mjs`, `lib/diagnose.mjs`, and the evidence
  `run-suite.mjs` used to throw away.** Before this, the PR comment printed a
  path and a title while the JSON it read already carried the error, the
  attachments and the retry count; and `--reporter=json` on the CLI silently
  replaced the product's reporters, so `product/playwright-report/**` — a path
  `suite.yml` had been uploading since it was written — never existed.

  Verified against **ColorMag's real suite on a Local site**, not a fixture:
  - `--reporter=json,html` and `--trace=retain-on-failure` are accepted by
    ColorMag's real config (a pnpm invocation with a setup project and a named
    project). `--tier fresh --area header`: 6 passed, exit 0, and an HTML report
    written where none was written before. **stderr stayed at exactly 0 bytes**,
    so the `--json` cost contract survives.
  - A **real failure with real evidence**, forced by pointing ColorMag's header
    specs at a different local site — no product source touched. Two screenshots
    and a 1.1 MB trace captured, both screenshots inlined into the report, and the
    rendered page shows WordPress rejecting the login, which is the actual cause.
  - All six verdict branches × three formats — pass, fail, `ran_nothing`, no
    manifest, `scope.mode: "none"`, harness-broken — 18 combinations, no throw. A
    *missing* `suite.json` still reports "could not run" rather than crashing.
  - The comment byte budget: a synthetic 40-failure run renders at 58 543 bytes,
    under GitHub's 65 536 ceiling, truncating the failure list while keeping the
    coverage note and the footer.
  - The HTML in **both themes, with zero console errors and zero external
    requests** — checked by intercepting every request, not by reading the source.

  Two things were checked rather than assumed, and one of them corrected the
  design:
  - Playwright supplies `error.location` and `error.snippet` for **assertion**
    failures and **omits both for a bare test timeout**, which has no assertion
    site. Confirmed on 1.62.1 against both shapes. The report falls back to the
    spec's opening line, which is all the old comment ever had.
  - The Expected/Received wording **varies by matcher** — `Expected:` for
    `toBeVisible`, `Expected length:` for `toHaveLength`. The first
    implementation pinned to `Expected:` and silently dropped the diff for every
    other matcher; it now matches a run of consecutive Expected/Received lines.

- **The whole pro licence path, end to end on macOS against real Playground
  boots.** Four things were checked rather than assumed and three of them
  corrected the design:
  - **`WP_ENVIRONMENT_TYPE = "local"` verified from inside the booted site**, not
    inferred from the blueprint step having been written. `tgqa-probe.php`
    reports `wp_get_environment_type()` back over HTTP and `boot-wp.mjs` warns if
    it is anything else.
  - **Playground answers requests while later blueprint steps are still
    applying.** The first probe of a `--with-pro colormag-pro` boot returned
    `active_theme: "colormag"` — the FREE theme — and a probe seconds later,
    against the same running site, correctly said `colormag-pro`. Reporting the
    first answer would have been a value that looks like an observation and is
    actually a race. The blueprint's last step now writes a per-boot token to
    `tgqa_boot_complete` and the probe waits for it; `settled: false` is reported
    explicitly rather than hidden.
  - **`plugins_loaded` is too early for a theme-delivered pro product.** ColorMag
    Pro is a standalone THEME, and a theme's `functions.php` runs on
    `setup_theme`, after `plugins_loaded`. The seeder hooked only there produced
    `pro gate unavailable: FS_ThemeGrill not loaded` with the pro theme correctly
    active. It now tries `plugins_loaded`, `after_setup_theme` and `init` in turn,
    and only the last is allowed to conclude "not attempted".
  - **EDD's `check_license` omits `error` entirely** — confirmed against the real
    wpeverest.com store. The adapter keyed its verdict off `error`, so a `check`
    of a bad key came back "unknown", routing a genuinely invalid licence to the
    harness owner as a suspected store outage. `license` is authoritative now.

  Confirmed working with a deliberately invalid key: seeder staged, mu-plugins
  copied, Freemius reached through `FS_ThemeGrill::freemius()`, `opt_in` attempted
  and correctly rejected, state `invalid`, `pro gate: FALSE`, and
  `run-suite.mjs --pro` refusing with `licence not active — pro features not
  under test (state: invalid; pro gate: FALSE)`, exit 2. Every branch of that
  chain except the `valid` outcome itself.

- **`scan-secrets.mjs` across all three of its checks**, in a throwaway repo: a
  literal key from the environment found in a tracked file and reported REDACTED,
  a structural `sk_…` match, a licence-shaped assignment, and a placeholder
  (`your-key-here`) correctly ignored. `sync-secrets.mjs` fails clearly on an
  unauthenticated `gh`.

- **A real cross-product defect, found by the mechanism this tier exists for.**
  ColorMag free's `header-logo-sizing-regression` spec (the CMAG-650 guard)
  **passes with free ColorMag alone and fails with ColorMag Pro active** —
  reproduced on two independent boots with a passing free-only control.
  Mechanism, cited: `colormag/assets/sass/base/elements/_header_builder.scss:138`
  applies `flex-basis: 30%` only under `&.cm-header-col--has-multiple`, with a
  comment naming the CMAG-650 regression;
  `colormag-pro/assets/sass/base/elements/_header_builder.scss:115` applies it
  **unconditionally**. ColorMag Pro carries the pre-fix version of the rule, so
  the lone-logo squeeze is still live there. This is exactly the "installing pro
  breaks a free feature" class, and nothing but the `free-with-pro` job could
  have found it.

- **The product's own pro gate returning TRUE on a real licensed site**, which
  every other part of the pro tier assumes and none had observed. Against
  `test-colormag.local` with ColorMag Pro active and its licence activated by
  hand in wp-admin, the probe answered `pro: {checked: true, active: true,
  expression: "FS_ThemeGrill::freemius()->can_use_premium_code()"}`.

  It also corrected the gate. That same response carried `license: null` —
  `tgqa_license_state` is written only by the seeder, so a site licensed by hand
  has none, and the old rule (`state !== "valid"` → refuse) would have rejected
  the one site a developer verifying a pro fix actually has. The product's own
  gate now outranks that bookkeeping, which is a stronger check rather than a
  weaker one: it asks the product instead of trusting a file we wrote.

- **`run-suite.mjs` installing the probe itself** on a local site it did not
  boot, deriving `wp-content/mu-plugins` from the product root and `pro_check`
  from the registry. Verified on the real site: auto-install, gate pass
  (`pro_gate: true` with `state: "not attempted"`), removal of every file it
  wrote on both the success and the `cannotRun` path, `TGQA_KEEP_PROBE` holding
  them, a remote base URL refused rather than written to, and an unresolvable
  gate (`--pro zakra-pro`) still refusing with `FS_ZakraTheme not loaded`.

**Not verified**

- **`license.mjs check-all` against the stores with real keys.** The product-side
  half of the `valid` branch is now proved (see the probe result under Verified),
  but the store-side half — EDD and Freemius answering `valid` for a real key —
  still has not run.
- **Anything about Everest Forms Pro.** Its repo is not on any machine used here;
  the registry row is deliberately incomplete and `license.mjs` refuses to act on
  it. See PRO.md §1.
- **Zakra Pro and User Registration Pro mounted and booted.** Only ColorMag Pro
  was exercised end to end. Zakra Pro is the interesting one: a companion PLUGIN
  to a free THEME, so the free theme must stay active alongside it — a mounting
  shape nothing has tested.
- **Every pro CI path.** `pro-suite.yml` parses and every command in it has been
  run by hand, but no run has happened. It no longer needs a GitHub App (see
  PRO.md §4.3), and with claudegrill public the cross-repo checkout blocker is
  gone too, so the only thing left is to let it run.
- **`sync-secrets.mjs --confirm` against real repos**, and `--audit` against
  them. Only the unauthenticated-`gh` failure path has been exercised.
- **The `@unlicensed` job.** The spec is written and the workflow mode exists;
  no run has booted pro without `--license` and executed it.
- **Reliable Playground readiness detection on Windows.** The site above
  genuinely works, but `waitForServer()`'s own polling never once got a
  qualifying response across 600 one-second attempts (600s budget), seeing
  `502` on its very last check — while a manual cookie-aware request against
  the same running site, around the same time, got a clean `200`. Playground
  reports "Ready! … (6 workers)"; the log also carries repeated
  `lockWholeFile: unlock failed` warnings against the SQLite database files,
  which is the likely link — worker-level inconsistency, not overall
  slowness. `@wp-playground/cli --help` exposes no worker-count flag to
  reduce that contention, so there's no client-side knob to pull from
  `boot-wp.mjs`. Raising the timeout (180s → 600s, both confirmed too short at
  least once) does not fix this — it's not a matter of waiting longer.
  Next step if this keeps blocking real use: reproduce against
  `@wp-playground/cli` directly (no wrapper) to confirm it's upstream, and
  either file it there or fall back to `--engine wp-env` by default on
  Windows.
- **The report's CI wiring.** `suite.yml` now generates `qa-report.html`, uploads
  it, and passes `steps.upload.outputs.artifact-url` into the comment — which is
  why the upload step moved *above* the comment step. Every command in those
  steps has been run by hand against a mocked-up CI workspace, and the workflow
  parses; but the artifact URL is a value only a real run produces, so **the
  link in the comment is unproven** until the checkout blocker below is lifted.
  If `artifact-url` ever arrives empty the comment degrades to naming the run
  instead, which is handled but also untested.

- **Every CI path except `wp-core-watch.yml`.** That one has now run for real.
  `suite.yml`, `pr-qa.yml` and `pr-command.yml` have not, and there is a known
  blocker in front of them: **`claudegrill` is a private repo and
  `secrets.GITHUB_TOKEN` cannot check it out from another repository.** Every
  reusable workflow's "Check out shared QA tooling" step fails with a 404 that
  reads as if the repo does not exist. They now take an optional
  `QA_REPO_TOKEN`; that it works is untested. Two org-level settings also have to
  be right — the token itself, and claudegrill's Settings > Actions > Access
  allowing organisation repos to call its reusable workflows. Making the repo
  public removes all of it, and also removes the per-developer git-access
  requirement for the plugin install.
- **ColorMag's `@fresh` tier does not actually pass on a clean Playground site.**
  This is the finding that matters most right now. Against the developer's Local
  site: 19 passed, 1 skipped. Against a freshly booted Playground site with the
  same specs: **11 passed, 9 failed**. The failures are not random — they cluster:
  - seven Customizer specs time out on `page.waitForFunction` after 20s, waiting
    on `wp.customize.state("saved")`. Playground runs the Customizer's React app
    under WASM PHP and it is slower than the wait allows
  - the roles spec fails at `rest_cookie_invalid_nonce` creating its subscriber
  - the mobile-menu spec cannot find its "Dropdown Parent" link, because the
    blueprint seeds a different menu than the Local site has
  - the CMAG-741 spec exceeds its 120s test timeout

  So those specs are tagged `@fresh` but were validated against a Local site with
  content. Under `SUITE.md` §2 that tag is a promise they do not keep, and CI
  would be red on all nine. Either the blueprint has to seed what they need, the
  Customizer waits have to tolerate WASM speeds, or those specs are `@demo` and
  the fresh tier is much smaller than it looks. **Do not turn on the required
  check until this is resolved** — a required check that is red on arrival is one
  nobody ever turns green.

- **`run-suite.mjs --boot` and `--install`.** The script is now proved against
  ColorMag's real suite, but only against an already-running Local site. `--boot`
  handing off from `boot-wp.mjs` is still untested and blocked behind task 1;
  `--install` has never run against ColorMag's pnpm lockfile, because
  `node_modules` was already present. Manifest *inference* also remains
  untested — ColorMag declares every field, so no branch of it was exercised.
- **`spec-guard.mjs` wired as an actual plugin hook.** The script is verified by
  invoking it directly with a Stop-shaped payload; that Claude Code loads
  `hooks/hooks.json` and fires it on `Stop` is not. Two things to know when
  testing it: `Stop` fires at the end of **every turn**, not once per session,
  which is why the dedup-by-branch matters; and on exit 0 a hook's **stderr goes
  to the debug log, not to the user**, so the one-line nudge is visible under
  `claude --debug` and the mechanism that actually reaches a human is the
  committed queue file plus the PR-comment nudge.
- **The `write-spec` proof gate end to end.** No spec has been generated,
  stashed against broken code, and committed by it yet.
- `ingest-docs.mjs` against the real docs sites.
- Jira filing end to end (needs Rovo API-token auth enabled).
- Every `TODO` in `knowledge/colormag.md` and `knowledge/zakra.md` — those are
  inferred, not confirmed, and a wrong line there produces confidently wrong QA.

## Next tasks, in order

1. **Unblock CI: `QA_REPO_TOKEN`, or make this repo public.** Nothing in the CI
   tier can run until the reusable workflows can check this repo out. The
   cheapest fix is making `claudegrill` public — there is nothing secret in it,
   ColorMag is already public, and it also removes the per-developer git-access
   requirement for the plugin install. Otherwise: an org secret plus
   Settings > Actions > Access on this repo.
2. **Make `boot-wp.mjs` work end to end** on a machine with network access. Fix
   whatever the blueprint gets wrong. Everything that needs a *disposable* site
   is still behind this — `run-suite.mjs --boot`, and `suite.yml` on a runner.
   Local development no longer is: `.env.local` points the suite at the
   developer's own site, which is how ColorMag was proved.
3. **First real `suite.yml` run** on an existing ColorMag PR. It needs no API
   key and can fail for free, so it is the right first CI target. Push the
   caller change that adds `QA_REPO_TOKEN` and that push is the trigger.
4. **Prove the `write-spec` gate once, by hand.** CMAG-741 is the obvious
   candidate: the fix is on `fix/cmag-741-related-posts-random-offset` and
   nothing guards it. Confirm the spec fails against the stashed code with an
   *assertion* failure rather than a timeout. If that gate does not hold, every
   spec this platform generates is decorative.
5. **Run `/verify-fix` on 3+ already-hand-verified ColorMag fixes** and compare
   verdicts. Still the cheapest test of whether the approach works, and it now
   exercises the diff-scoped Step 3.5 and the `write-spec` handoff.
6. **Resolve the knowledge-file TODOs** for ColorMag with a maintainer. These
   matter more than they did: `suite-index.mjs` derives `areas_uncovered` from
   the knowledge file's critical-flows list, and it currently reports **10 of 16
   areas with no `@fresh` coverage at all** — customization, demo-import, faq,
   footer, get-started, how-to, rtl, upgrade, widgets, woocommerce. A wrong area
   list sends the whole budget to the wrong place.
7. **Fill those ten uncovered areas.** Under the no-AI-on-PR model the suite is
   the only automated safety net, so an area with no specs is an area where a
   regression ships unnoticed. This is now the main body of work, and it is the
   thing the cost projection assumes is happening.
8. **Port the existing spec harness, do not invent one.**
   `wpmake22/post-purchase-hub` already has a working Playwright suite with
   settled conventions: wp-env, two projects (desktop 1440×900, mobile 375×812),
   per-theme visual snapshots, owned-selector rule, and a full unit /
   integration / e2e pyramid. Extract `tests/e2e/utils/` into `packages/core`
   and adopt its conventions rather than designing new ones. Transpose the
   matrix for themes — one theme × N plugins, not one plugin × N themes.
9. **Snapshot diff triage** — the agent's best-fitting job in the whole system,
   and one of the few left under the no-AI-on-PR model. Six themes × two
   viewports × N specs is a large snapshot set, and `--update-snapshots` makes
   rubber-stamping a real regression as easy as accepting an intended restyle.
   Classifying those diffs has no good non-AI answer.

**Done:** spec generation (`write-spec`, `suite-index.mjs`, `spec-guard`), and
pointing `run-suite.mjs` at ColorMag's real suite — previously tasks 6 and 2.
What remains of the first is proving its gate against a real fix (task 4):
the mechanism existing and the mechanism working are different claims.

**Deliberately dropped:** inverting the PR default so the agent reviews only
HIGH-risk diffs. The team decided to remove AI from the PR path entirely — the
developer runs the scoped suite locally, commits the spec on their own branch,
and CI runs the full `@fresh` tier with no API key. `pr-qa.yml` and
`pr-command.yml` stay in the repo, unused, for a product whose suite is still
too thin to trust.

Deliberately **not** on the list: a dashboard (GitHub and Jira already are one),
a vector database, a custom agent framework, merge authority, or a healer allowed
to change assertions.

## Two things worth knowing

**Playground is not a real server.** PHP-WASM with SQLite: no MySQL-specific SQL,
no real cron, no outbound mail. The skills switch to `wp-env` when a diff touches
those, but check which engine a run actually used before trusting a green result.

**Doc drift is an output, not a bug.** If the docs promise a control the product
lacks, either the docs are stale (customers are reading them) or the feature
regressed. Report it as `DOC DRIFT: <url> says X, product does Y` and let a human
decide which side is wrong.
