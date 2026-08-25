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
    write-spec/          verified finding -> committed regression spec
  scripts/               the deterministic layer — Node, zero dependencies
    detect-product.mjs   identify the product from source -> JSON
    boot-wp.mjs          disposable WordPress, product mounted live
    run-suite.mjs        run the product's own Playwright suite -> JSON
    suite-index.mjs      what the suite covers, and what it does NOT
    ingest-docs.mjs      docs site -> intent layer + area list (REST or sitemap)
    ingest-testsuite.mjs an existing Selenium/Robot suite -> specification
    estimate-cost.mjs    spend model, incl. the coverage projection
    lib/                 shared: qa-home, platform, spec-parse, suite-manifest
  hooks/
    hooks.json           Stop hook registration
    spec-guard.mjs       notices source changed with no spec; queues it
  blueprints/            seeded WordPress state for theme / plugin testing
install.mjs              clone-install fallback; not needed for plugin installs
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

## Where work lives — the three-layer memory

This is the shape of the whole platform, and the reason the suite layer exists.

| Layer | Remembers | Where | Cost per run |
|---|---|---|---|
| `knowledge.md` | how the product is *meant* to work | product repo | free (read) |
| findings ledger `.jsonl` | every confirmed finding, fingerprinted | product repo | free (read) |
| `tests/e2e/**` | the bug, frozen as a deterministic assertion | product repo | runner minutes |
| agent exploration | anything not yet in the three above | — | **tokens, every run** |

**Work moves downward through those layers, never upward.**

Something the agent discovered becomes a spec. Something a spec proved becomes a
line in the knowledge file. Nothing that is already a spec goes back to being
explored — that is what `suite-index.mjs`'s `areas_uncovered` is for, and why
every skill reads it before deriving missions.

Stated as economics, because it is the reason for every decision in the suite
layer: an agent finding costs tokens on **every run, forever**; the same finding
as a committed spec costs tokens **once**, then runs for approximately free on
every PR for the life of the product. A verified finding that does not become a
spec is a finding you have arranged to pay for again.

`node plugins/themegrill-qa/scripts/estimate-cost.mjs --projection 24` prints
that curve.

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
- **Any live CI run. No workflow in this repo has ever executed.** That now
  includes the two new ones, `suite.yml` and `pr-command.yml`, plus the suite
  steps folded into `pr-qa.yml`. Their YAML parses and the shell inside them is
  written carefully; neither is evidence that they run.
- **`run-suite.mjs` against a real product.** It has been proved against a
  fixture, never against ColorMag — so the manifest inference, the `--install`
  path on a pnpm lockfile, and `--boot` handing off from `boot-wp.mjs` are all
  untested against the real thing. `--boot` in particular is blocked behind
  task 1 below.
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

1. **Make `boot-wp.mjs` work end to end** on a machine with network access. Fix
   whatever the blueprint gets wrong. **Everything else is still blocked behind
   this** — including `run-suite.mjs --boot`, `suite.yml`, and every CI path,
   all of which reach the environment only through that one script.
2. **Point `run-suite.mjs` at ColorMag's real suite.** It is proved against a
   fixture, never against a product. Write ColorMag's `.themegrill-qa/suite.json`,
   tier its existing specs, and check that the manifest inference, `--install` on
   a pnpm lockfile, and the JSON report parse all survive contact. Cheap, and it
   is what the whole suite layer rests on.
3. **Run `/verify-fix` on 3+ already-hand-verified ColorMag fixes** and compare
   verdicts. Still the cheapest test of whether the approach works — and now it
   also exercises Step 3.5 and the `write-spec` handoff.
4. **Prove the `write-spec` gate once, by hand.** Take one known ColorMag fix,
   let the skill write the spec, and confirm it genuinely fails against the
   stashed code with an assertion failure rather than a timeout. If that gate
   does not hold, every spec this platform generates is decorative.
5. **Resolve the knowledge-file TODOs** for ColorMag with a maintainer. These
   now matter more than they did: `suite-index.mjs` derives `areas_uncovered`
   from the knowledge file's critical-flows list, so a wrong area list sends the
   agent's whole budget to the wrong place.
6. **First live CI run** on ColorMag only — `suite.yml` first, since it needs no
   API key and can fail for free. Then `pr-qa.yml`, checking that trivial PRs
   are skipped. Then one `@themegrill-qa help` comment to confirm the gating.
7. **Port the existing spec harness, do not invent one.**
   `wpmake22/post-purchase-hub` already has a working Playwright suite with
   settled conventions: wp-env, two projects (desktop 1440×900, mobile 375×812),
   per-theme visual snapshots, owned-selector rule, and a full unit /
   integration / e2e pyramid. Extract `tests/e2e/utils/` into `packages/core`
   and adopt its conventions rather than designing new ones. This is
   deterministic, costs no tokens, and is the fastest route to an accumulating
   suite. Transpose the matrix for themes — one theme × N plugins, not one
   plugin × N themes.
8. **Invert the default** once the suite is trusted: suite on every PR, agent on
   HIGH-risk diffs only. PR reviews are ~64% of spend, so this is where the
   savings are. The pieces now exist — `suite.yml` is the free tier and
   `pr-qa.yml` is gated — so this is a change to the callers, not new code.
9. **Snapshot diff triage** — the agent's best-fitting job in the whole system.
   Six themes × two viewports × N specs is a large snapshot set, and
   `--update-snapshots` makes rubber-stamping a real regression as easy as
   accepting an intended restyle. Classifying those diffs has no good
   non-AI answer.

**Done, previously task 6:** spec generation. `write-spec` writes the spec,
`suite-index.mjs` says where it is needed, and `spec-guard` notices when one is
missing. What remains is proving the gate against a real fix — task 4 — because
the mechanism existing and the mechanism working are different claims.

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
