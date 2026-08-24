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
.claude/skills/          the judgement layer — one skill per entry point
  verify-fix/            local: verify the change in the working tree
  pr-qa-review/          CI: review a PR, post one comment
  full-test/             manual: whole-product sweep, fans out to CI
  regression-sweep/      the sweep body, invoked per shard
  knowledge-init/        draft a product's knowledge file
scripts/                 the deterministic layer — shell and stdlib Python
  detect-product.sh      identify the product from source → JSON
  boot-wp.sh             disposable WordPress, product mounted live
  ingest-docs.py         docs site → intent layer + area list
  estimate-cost.py       spend model
blueprints/              seeded WordPress state for theme / plugin testing
knowledge/               templates and starter knowledge files
.github/workflows/       reusable workflows + per-product caller examples
```

## Invariants — do not break these

These are load-bearing. Changing one is a design decision, not a refactor.

1. **Scripts are deterministic; skills hold judgement.** Booting, mounting,
   detecting, seeding, ingesting: shell or Python, free, reproducible. Only
   genuinely ambiguous work goes in a skill. When a skill's behaviour becomes
   predictable, move it into a script — that direction, never the reverse.

2. **`detect-product.sh` emits JSON and nothing else.** Every consumer reads that
   contract. Add fields freely; never change or remove one.

3. **The environment is reachable only through `boot-wp.sh --engine`.** No skill
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
   `detect-product.sh` checks that path first.

7. **Never edit product source to make a check pass.** These skills verify; they
   do not fix.

## Conventions

- Bash: `set -euo pipefail`, absolute paths, `python3` for JSON. No jq dependency.
- Python: standard library only. These run in CI containers.
- Path resolution: resolve through symlinks and honour `THEMEGRILL_QA_HOME`
  (user-level installs symlink the skills).
- Workflows: reusable (`workflow_call`) here, thin callers in product repos.
- Cost control is a first-class feature — path filters, a triage step, draft-PR
  skipping, `cancel-in-progress`, Sonnet by default, Chromium only.
- Comments explain *why*, not *what*. The what is readable from the code.

## Build state

**Verified working**

- `detect-product.sh` — theme and plugin headers, subdirectory invocation, Jira
  key from branch name, pro-companion detection, knowledge-file precedence,
  clean failure on a non-WordPress directory
- `ingest-docs.py` — tested against a synthetic docs site matching the real URL
  shape; section grouping, landing-page detection, outcome extraction, area list
- Playground auto-mount and blueprint loading (flags checked against
  `wp-playground start --help`)
- All YAML and JSON parses; shell passes `bash -n`; Python compiles

**Not verified**

- **A completed Playground boot.** The build environment blocked
  `wordpress.org` and `playground.wordpress.net`, so the run reached mounting and
  blueprint parsing and then failed fetching WordPress. Blueprint steps, the
  readiness poll and the JSON handoff are untested. **Fix this first.**
- Any live CI run. No workflow has executed.
- `ingest-docs.py` against the real docs sites.
- Jira filing end to end (needs Rovo API-token auth enabled).
- Every `TODO` in `knowledge/colormag.md` and `knowledge/zakra.md` — those are
  inferred, not confirmed, and a wrong line there produces confidently wrong QA.

## Next tasks, in order

1. **Make `boot-wp.sh` work end to end** on a machine with network access. Fix
   whatever the blueprint gets wrong. Everything else is blocked behind this.
2. **Run `/verify-fix` on 3+ already-hand-verified ColorMag fixes** and compare
   verdicts. This is the cheapest test of whether the approach works.
3. **Resolve the knowledge-file TODOs** for ColorMag with a maintainer.
4. **First live PR run** on ColorMag only. Check that trivial PRs are skipped.
5. **Spec generation — the one that changes the economics.** Add `tests/` per
   product and have verified findings arrive as a PR containing a Playwright spec
   that reproduces the bug. Wire Playwright's Generator agent
   (`npx playwright init-agents --loop=claude`); do not write an orchestrator.
   Until this exists, cost per run never falls and nothing accumulates.
6. **Invert the default** once the suite is trusted: suite on every PR, agent on
   HIGH-risk diffs only. PR reviews are ~64% of spend, so this is where the
   savings are.
7. **`packages/core` page objects** wrapping `@wordpress/e2e-test-utils-playwright`
   — do this at three products, not seven.
8. **Visual baselines** keyed by product/version/template/viewport. The dominant
   bug class for the four visual products, and nothing else catches it.

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
