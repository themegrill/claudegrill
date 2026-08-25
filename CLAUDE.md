# themegrill-qa — orientation

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
plugins/themegrill-qa/   the installable plugin — everything the skills need
  .claude-plugin/plugin.json
  skills/                the judgement layer — one skill per entry point
    verify-fix/          local: verify the change in the working tree
    pr-qa-review/        CI: review a PR, post one comment
    full-test/           manual: whole-product sweep, fans out to CI
    regression-sweep/    the sweep body, invoked per shard
    knowledge-init/      draft a product's knowledge file
  scripts/               the deterministic layer — Node, zero dependencies
    detect-product.mjs   identify the product from source -> JSON
    boot-wp.mjs          disposable WordPress, product mounted live
    ingest-docs.mjs      docs site -> intent layer + area list (REST or sitemap)
    ingest-testsuite.mjs an existing Selenium/Robot suite -> specification
    estimate-cost.mjs    spend model
  blueprints/            seeded WordPress state for theme / plugin testing
install.mjs              clone-install fallback; not needed for plugin installs
packages/core/           shared spec helpers — the suite layer
knowledge/               templates and starter knowledge files
examples/                a spec in the house style, to copy into a product repo
.github/workflows/       reusable workflows + per-product caller examples
```

Scripts and blueprints live **inside** the plugin because Claude Code copies a
plugin into its own cache, and a copied plugin cannot reach files outside its
directory. Anything a skill needs must travel with it.

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

5. **A finding requires reproduction twice plus cited evidence.** The five-part
   gate in `regression-sweep` is the reason this is trusted. Do not relax it, and
   do not let any agent report a defect it only saw once.

6. **Knowledge files live in the product repo** at `.themegrill-qa/knowledge.md`,
   so the PR that renames an option updates its description in the same commit.
   `detect-product.mjs` checks that path first.

7. **Never edit product source to make a check pass.** These skills verify; they
   do not fix.

8. **Specs select on markup we own, never on theme or third-party class names.**
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
- Cost control is a first-class feature — path filters, a triage step, draft-PR
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
- `install.mjs` — links five skills, sets the env var, smoke-tests the scripts
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
- All YAML and JSON parses; every `.mjs` passes `node --check`

**Not verified**

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
- Any live CI run. No workflow has executed.
- `ingest-docs.mjs` against the real docs sites.
- Jira filing end to end (needs Rovo API-token auth enabled).
- Every `TODO` in `knowledge/colormag.md` and `knowledge/zakra.md` — those are
  inferred, not confirmed, and a wrong line there produces confidently wrong QA.

## Next tasks, in order

1. **Make `boot-wp.mjs` work end to end** on a machine with network access. Fix
   whatever the blueprint gets wrong. Everything else is blocked behind this.
2. **Run `/verify-fix` on 3+ already-hand-verified ColorMag fixes** and compare
   verdicts. This is the cheapest test of whether the approach works.
3. **Resolve the knowledge-file TODOs** for ColorMag with a maintainer.
4. **First live PR run** on ColorMag only. Check that trivial PRs are skipped.
5. **Port the existing spec harness, do not invent one.**
   `wpmake22/post-purchase-hub` already has a working Playwright suite with
   settled conventions: wp-env, two projects (desktop 1440×900, mobile 375×812),
   per-theme visual snapshots, owned-selector rule, and a full unit /
   integration / e2e pyramid. Extract `tests/e2e/utils/` into `packages/core`
   and adopt its conventions rather than designing new ones. This is
   deterministic, costs no tokens, and is the fastest route to an accumulating
   suite. Transpose the matrix for themes — one theme × N plugins, not one
   plugin × N themes.
6. **Spec generation on top of that harness.** Verified findings arrive as a PR
   containing a spec written in the house style. Wire Playwright's Generator
   agent (`npx playwright init-agents --loop=claude`); do not write an
   orchestrator. Until this exists, cost per run never falls.
7. **Invert the default** once the suite is trusted: suite on every PR, agent on
   HIGH-risk diffs only. PR reviews are ~64% of spend, so this is where the
   savings are.
8. **Snapshot diff triage** — the agent's best-fitting job in the whole system.
   Six themes × two viewports × N specs is a large snapshot set, and
   `--update-snapshots` makes rubber-stamping a real regression as easy as
   accepting an intended restyle. Classifying those diffs has no good
   non-AI answer.

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
