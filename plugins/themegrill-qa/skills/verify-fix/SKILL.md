---
name: verify-fix
description: Verify the current fix on your existing site (or a disposable WordPress), running the product's suite first
argument-hint: "[optional: what to check, or a Jira key]"
allowed-tools: Bash, Read, Grep, Glob, Skill, mcp__playwright__*, mcp__atlassian__*
pass-arguments: true
---

# Verify the change in the working tree

## Where the scripts live — resolve this first

Commands below refer to `$QA`, this plugin's own directory. Resolve it once
before anything else:

```bash
QA="${CLAUDE_PLUGIN_ROOT:-${THEMEGRILL_QA_HOME:-..}/plugins/themegrill-qa}"
node "$QA/scripts/detect-product.mjs" >/dev/null && echo "QA=$QA"
```

`CLAUDE_PLUGIN_ROOT` is set automatically when this runs as an installed plugin,
which is the normal case; the fallback covers a plain `git clone` install. If the
shell is not bash — PowerShell on a Windows machine, say — use that shell's
equivalent rather than assuming this line works.

If neither variable resolves to a directory containing `scripts/`, stop and say
so. Guessing at a path produces a confusing failure several steps later.

You are verifying an *uncommitted or unreleased change* to a WordPress theme or
plugin. Assume you were given **no context**. Derive it. Do not ask the user
what product this is, what changed, or how to reproduce — find out.

`$ARGUMENTS` may be empty. If present it is either a hint about what to check
("check the mobile menu") or a Jira key (`CM-1234`). Use it to narrow focus, but
still run the derivation below.

## Step 1 — Work out what you are looking at

```bash
node "$QA/scripts/detect-product.mjs"
```

That gives you type (theme/plugin), slug, name, version, repo root, the branch,
any Jira key embedded in the branch name, and the path to the product knowledge
file. Then:

```bash
git diff --stat HEAD
git diff HEAD
git log --oneline -5
```

If the working tree is clean, diff against the upstream base instead
(`git diff origin/HEAD...HEAD`) — the change is committed but unmerged.

**Read the product knowledge file** if `detect-product.mjs` found one. It tells
you the product's critical flows, admin surfaces, known-fragile areas and
integration points. It exists so you do not have to rediscover the product.

## Step 2 — Work out what the change is supposed to do

Build a hypothesis before you touch a browser. Sources, in order of authority:

1. **A Jira key** — from `$ARGUMENTS` or the branch name. Fetch the issue via
   the Atlassian MCP. The reported reproduction steps and expected behaviour are
   your test case; use them verbatim rather than inventing your own.
2. **The diff itself** — which functions, templates, hooks, controls or asset
   files changed. Map them to user-visible surfaces.
3. **Commit messages and any changelog entry** in the diff.

Write out, explicitly, before proceeding:

- **Claim** — what this change is supposed to fix or add, in one sentence.
- **Reproduction** — the exact steps that exercised the bug before the fix.
- **Expected** — what should now happen.
- **Blast radius** — what else touches the changed code and could regress.

If you cannot form a claim, say so and stop. Guessing at intent produces
confident, useless verification.

## Step 3 — Get a site, preferring the one the fix is already on

**Use the developer's existing site first. Boot a fresh one only if you cannot.**

That ordering is deliberate. Someone fixing ColorMag already has the site the bug
lives on, with its content, its settings and its demo import. Booting is the
slow, network-dependent, still-unproven step, and a clean Playground site does
not resemble the site the bug was reported against.

Resolve in this order and **say which one you used**:

1. **A URL in `$ARGUMENTS`** — "check the mobile menu on http://test-colormag.local".
2. **`TGQA_BASE_URL`** already set in the environment.
3. **`.themegrill-qa/.env.local`** in the product repo — the normal case.
   `run-suite.mjs` reads this itself, so you do not have to parse it:

   ```
   TGQA_BASE_URL=http://test-colormag.local
   CM_ADMIN_USER=admin
   CM_ADMIN_PASS=password
   ```

   It is gitignored. **Never write credentials anywhere else, and never echo the
   password into your output.**
4. **Fresh Playground**, only when none of the above yields a site:

   ```bash
   node "$QA/scripts/boot-wp.mjs" --engine playground
   ```

If you fall through to 4, say so explicitly and add a line to "Not checked":
a clean site has none of the developer's content, so anything content-dependent
was not really exercised.

Two consequences of running against a real site, and you own both:

- **Restore anything you change.** The suite's own fixtures do this already
  (`CONVENTIONS.md` — teardown, not the happy path). *You*, driving the browser
  by hand in Step 4, must do the same: revert every setting you publish.
- **Never run `--tier demo` against a site whose demo content you cannot restore.**

Switch to `--engine wp-env` — or ask for a wp-env site — when the diff touches
raw SQL or `$wpdb`, `wp_mail`, WP-Cron, multisite, or upload/image processing
that needs real GD/Imagick. Playground's SQLite runtime gets those wrong or
lacks them, and a green result there would be meaningless.

If the product has a pro companion and the diff touches licensed code, mount it
too: `--with <slug>-pro=../<slug>-pro`.

## Step 3.5 — Run only the specs your diff could have broken

**Do not run the whole suite here.** Run the specs covering the areas your diff
touches, and nothing else.

That is a deliberate division of labour, and it is why it is safe:

| Where | What runs | Cost |
|---|---|---|
| **Here, on the developer's machine** | only the affected areas | seconds, a few hundred tokens |
| **CI, on every PR** | the entire `@fresh` tier | runner minutes, **no tokens at all** |

The full regression net still exists — it just runs where it is free. Paying an
agent to sit through 20 specs when the diff touched the header is spending the
expensive budget on something the free tier does better.

### Work out which areas

```bash
node "$QA/scripts/suite-index.mjs" --pretty
```

`by_area` and `areas_declared` give you the vocabulary. Map the changed files to
areas using the knowledge file's critical-flows list — you already did this work
in Step 2 as "blast radius". Then:

```bash
node "$QA/scripts/run-suite.mjs" --tier fresh --area header,global --json
```

`--area` takes a comma-separated list and ORs them, so one invocation covers
every area the diff touches.

Three rules for choosing:

- **Be generous, not minimal.** Specs are seconds each. If you are unsure whether
  the customizer area is affected, include it. The failure mode you are avoiding
  is a missed regression, not a slow run.
- **If the branch names a Jira key, always include the specs that `@guards` it**,
  whatever area they are in — `suite-index.mjs`'s `guards` map has the file and
  line. A fix for CMAG-1234 that breaks the spec guarding CMAG-1234 is the single
  most important thing this step can catch.
- **If you genuinely cannot map the diff to any area** — a build-config change, a
  broad refactor, `functions.php` — run the whole `@fresh` tier and say why. It
  is ~47s on ColorMag. Guessing narrowly on a diff you do not understand is worse
  than running everything.

### Run it cheaply

**Always `--json`.** This is a cost instruction, not a formatting one.

The suite itself costs nothing — plain Node and Playwright, no model, no API
call, no tokens. The only thing that costs anything is *you reading its output*.
Without `--json` the runner prints a progress line per test, which you pay to
read and which tells you nothing a developer could not get from the log. With it
you get one line of ~300 characters and the runner's output goes to the file
named in `log`.

- **Do not remove `--json`**, and do not re-run without it "to see more".
- **Do not `cat` the log** unless a failure cannot be understood from
  `failures[].error`, which already carries the first 400 characters.
- **Do not quote the JSON back verbatim.** Read `ok`, the counts, `failures[]`.

No `--base-url` is needed — `run-suite.mjs` resolves the site by the same
precedence you used in Step 3. Add `--boot playground` only if you fell through
to booting.

Only `@fresh` runs. `@demo` specs need demo content and are excluded, so this is
not full coverage and your report must not imply it is.

### What to do with the result

- `suite: false` — no suite. Note it and carry on.
- **Failures: triage those first.** A failure on the site the fix is being made on
  is either a regression this diff caused or a broken spec, and either way it is
  cheaper evidence than anything you can find by exploring.
  **Cross-check against the base branch before blaming this diff** — `git stash`,
  re-run that spec with `--grep "<title>"`, `git stash pop`. A failure that also
  fails on base is pre-existing.
- Read `failures[].guards` — a failing spec naming a Jira key tells you which
  regression has come back.
- `flaky > 0` — say so. A flaky suite erodes trust faster than a failing one.

State in the report **which areas you ran and which you skipped**, so the reader
knows what this verdict does and does not cover.

## Step 4 — Verify, adversarially

Drive the site with the Playwright MCP tools. Three passes, in this order:

**Pass 1 — Reproduce the bug on the old code.** This is the step people skip
and it is the one that makes the result trustworthy. Stash the change
(`git stash`), reload, and confirm the broken behaviour is actually there. If
the bug does *not* reproduce without the fix, then either the reproduction is
wrong or the fix addresses something else — report that and stop. Restore with
`git stash pop`.

**Pass 2 — Confirm the fix.** Re-run the same steps with the change applied.
The behaviour must match "Expected" from Step 2.

**Pass 3 — Probe the blast radius.** Now try to break it:

- the same flow at 375px, 768px and 1440px widths
- the adjacent settings/customizer controls, not just the one that changed
- the flow as a lower-privileged user, and as a logged-out visitor
- empty, maximum-length, unicode and HTML-injected input where fields changed
- back/forward navigation and double-submits where state changed
- for themes: the changed surface across archive, single, page, 404 and search

Throughout, collect evidence rather than impressions:

- record the reproduce-and-fix sequence with `browser_start_video` /
  `browser_stop_video` — a clip of the bug appearing and then not appearing is
  the most convincing artifact this whole process can produce
- screenshots at each meaningful state (before *and* after)
- browser console errors and warnings
- failed or 500-ing REST/AJAX requests
- PHP notices — check `/tmp/playground.log` and enable `WP_DEBUG` if the diff
  touches PHP

## Step 5 — Report

Be decisive. One of exactly four verdicts:

| Verdict | Meaning |
|---|---|
| **VERIFIED** | Bug reproduced without the fix, gone with it, no regressions found. |
| **INCOMPLETE** | The fix works for the reported case but the underlying problem persists in a related path. Name the path. |
| **REGRESSION** | The fix works but broke something else. Name it with evidence. |
| **CANNOT VERIFY** | The bug would not reproduce, the environment could not model it, or intent was unclear. Say which. |

Then:

```
Verdict: <one of the four>
Product: <name> <version> (<type>)
Change:  <files touched, one line>
Claim:   <what it was supposed to do>

Site       <url> — existing site | fresh Playground | wp-env
Suite      <n> passed, <n> failed, <n> skipped (tier: fresh only) — or "no suite"
Spec added <path>, branch <name> — or why not

Evidence
  Before fix: <what you observed, + screenshot path>
  After fix:  <what you observed, + screenshot path>
  Console:    <errors, or "clean">
  Network:    <failures, or "clean">

Blast radius checked
  <surface> — <result>
  ...

Not checked
  <anything you could not cover, and why>
```

That last section is mandatory. An honest list of gaps is more useful than an
implied claim of total coverage.

## Step 6 — Graduate the finding

A verdict that does not become a spec is a verdict you will pay to reach again.

- On **VERIFIED** — invoke the `write-spec` skill to add a `@fresh` regression
  spec guarding what you just confirmed.
- On **REGRESSION** or **INCOMPLETE** — write a `test.fixme()` spec naming the
  open key, so it flips green the day it is fixed.
- On **CANNOT VERIFY** — write nothing.

Report the branch name and the proof-gate result (3/3 against the fixed code,
fails against the broken code) in the verdict block. If `write-spec` declined to
write one, say which row of its mapping table applied.

If a record in `.themegrill-qa/spec-queue.jsonl` covers this branch, mark it
`done` by appending an updated record.

## Rules

- **Never edit source to make a test pass.** You are verifying, not fixing. If
  the fix is wrong, say the fix is wrong.
- **Never report a bug you have not reproduced twice.** One-shot anomalies in a
  browser-driving agent are usually the agent, not the product.
- Tear down the site when finished (kill the pid from `boot-wp.mjs`).
- If Playwright fails to drive the page three times in a row, stop and report
  the blocker. Do not keep retrying variations.
