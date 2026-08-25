---
name: pr-qa-review
description: Diff a PR, validate it in a live WordPress with Playwright, assess risk, post a verdict
allowed-tools: Bash, Read, Grep, Glob, Skill, mcp__playwright__*, mcp__github*
pass-arguments: true
---

# PR QA review

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

You are reviewing a pull request against a WordPress theme or plugin that ships
to a large installed base of paying customers. You are the QA pass, not the code
style pass. Your job is to answer one question with evidence:

> **If this merges and ships, what breaks for a real site?**

You are running unattended in CI. Do not ask questions. Make the call, show your
work, and be explicit about what you could not check.

## Step 1 — Establish context

```bash
node "$QA/scripts/detect-product.mjs"
gh pr view "$PR_NUMBER" --json title,body,author,baseRefName,headRefName,files,additions,deletions
gh pr diff "$PR_NUMBER"
```

Read the product knowledge file for this product. Fetch the linked Jira issue if
the PR title, body or branch name contains a key — the issue's reproduction
steps are better than any you would invent.

## Step 2 — Risk-assess the diff before running anything

Classify the change. This decides how much work the rest of the run deserves.

**Escalate to HIGH risk** if the diff touches any of:

- capability checks, nonces, `current_user_can`, sanitization or escaping
- database schema, migrations, or an `upgrade`/`update` routine
- anything reading or writing user data, orders, submissions or enrollments
- payment, licensing or subscription code
- template files, theme hooks, or `functions.php` (themes ship to live sites and
  a fatal here is a white screen)
- asset enqueueing, dependency arrays or build output
- REST routes or AJAX handlers
- anything under an `includes/compat/` or integration directory

**MEDIUM** for new user-facing features, customizer/settings controls, block
attributes, or changes to existing markup and CSS.

**LOW** only for strings, comments, docs, tests, CI config, and translations.

State the classification and the reason in one line. For LOW, skip to Step 5 and
say so — do not burn a browser session on a typo fix.

## Step 2.5 — Read what the suite already covers

One command, before you derive a single mission. It needs no site and no browser,
so it is free — and it changes what the rest of the run should do.

```bash
node "$QA/scripts/suite-index.mjs" --pretty
```

`suite-index.mjs` tells you what the product's own specs already assert.
**Derive your 3–6 missions preferentially from `areas_uncovered`.** An area with
green `@fresh` specs does not need an agent mission: the specs assert what you
would go and look at, deterministically, for runner minutes instead of tokens.
An area with none is the only place your budget buys anything new.

`thinnest_areas` is the second call on your budget — areas with one or two specs
are smoke-tested, not covered.

**Say in the PR comment which areas you skipped because the suite covers them.**
That sentence is the visible proof this is accumulating, and it is the number
that should shrink over the coming months. Do not omit it because it looks like
housekeeping.

Leave a mission slot free. The suite itself runs in Step 4 against the booted
site, and if it fails, triaging those failures becomes M1 ahead of anything you
derived here.

## Step 3 — Derive test missions from the diff

Do not run a generic smoke test. Write 3–6 specific missions targeted at what
actually changed, each with a concrete pass/fail condition. A mission looks like:

> **M2 — Migration on populated site.** The diff alters the `3.x → 4.0` option
> migration. Seed the site with 3.x-shaped options, run the upgrade routine,
> assert every setting survives and no PHP notice is emitted.
> *Fails if* any previously-set option is lost or reset to default.

Bias missions toward the failure modes that actually hurt this catalogue:

- an update that loses existing users' settings
- a fatal or notice on a PHP version you still support
- a layout that collapses on mobile but is fine on desktop
- a capability check that lets a lower role reach something it should not
- an editor/customizer control that saves but does not render on the frontend,
  or renders but does not persist on reload
- a conflict with WooCommerce/Elementor/Gutenberg where the product integrates

## Step 4 — Execute

```bash
node "$QA/scripts/boot-wp.mjs" --engine playground
```

Use `wp-env` instead when the diff touches SQL, mail, cron or multisite — those
are wrong or absent under Playground's SQLite runtime and a green result would be
meaningless.

**Run the suite against the booted site before any mission:**

```bash
node "$QA/scripts/run-suite.mjs" --tier fresh --base-url <the booted URL>
```

Only the `fresh` tier, ever. A `@demo` spec needs demo content this runner does
not have, so it would fail for reasons that have nothing to do with the PR.

If it reports failures, **triaging them is mission M1.** That is the cheapest
useful work available on this PR and it is not optional — the suite has already
done the exploring and handed you a reproduction, a file and a line. Re-run each
failure against the base branch and label anything that also fails there as
pre-existing.

If `suite` is `false`, note it and carry on. A product with no suite is a valid
state, not a blocker.

Run each mission with the Playwright MCP tools. Collect, per mission:
screenshots at the decisive states, console errors, failed network requests, and
PHP notices from the debug log.

**Make the run watchable.** Nobody trusts a verdict they cannot inspect, so
leave behind a trail a human can step through without re-running anything:

- Wrap each mission in `browser_start_video` / `browser_stop_video`. A recording
  of the failing flow settles arguments that a paragraph of description cannot.
- Screenshot before *and* after the decisive action, never only the failure.
- Name every file for its mission: `m2-migration-before.png`,
  `m2-migration-after.png`. A folder of `screenshot-1.png` is not evidence.
- Write everything to the MCP output directory (`/tmp/qa-evidence` in CI) so the
  workflow uploads it as an artifact.
- Reference the filenames in the findings table. A finding whose evidence column
  points at nothing will be assumed wrong, and should be.

**Then run the same missions against the base branch** for anything that looks
like a failure. A failure that also fails on `main` is a pre-existing bug, not
something this PR did — and reporting it as a PR regression is the fastest way
to lose the team's trust in this pipeline. Label it accordingly.

## Step 5 — Post the verdict

Verdict is one of:

- **APPROVE** — missions passed, no new risk found. Merge is safe from a QA view.
- **APPROVE WITH NOTES** — safe to merge, but findings the author should know.
- **CHANGES REQUESTED** — a reproducible defect introduced by this PR.
- **NEEDS HUMAN QA** — the risk is real but you could not model it in this
  environment (real payments, live license server, a third-party integration,
  visual judgement calls). Say precisely what a human needs to check.

You do **not** have merge authority and you do not approve via the GitHub review
API. Post a comment. A human merges.

Post exactly one comment per PR and **update it in place** on subsequent pushes
rather than adding a new one — find your previous comment by its
`<!-- themegrill-qa-bot -->` marker and edit it. A PR with nine bot comments gets muted.

```markdown
<!-- themegrill-qa-bot -->
## QA review — <VERDICT>

**Suite** — 57 passed · 2 failed · 1 skipped · 1 flaky  (fresh tier, WP 6.8 / PHP 8.3)
<details><summary>Failures</summary>

- `header-layout.spec.ts:31` centered header keeps the tagline — *also fails on base branch, pre-existing*
- `entry-summary.spec.ts:12` summary spacing — **new on this branch**
</details>

**Agent review** — 4 missions, areas not covered by the suite: footer, widgets

**Risk:** HIGH / MEDIUM / LOW — <one line why>
**Env:** Playground · WP <ver> · PHP <ver>  (or wp-env)
**Commit:** <sha>

### Findings
| # | Severity | Finding | Evidence |
|---|---|---|---|
| 1 | Blocker | <what breaks, concretely> | <screenshot / console / trace> |

For each finding: steps to reproduce, expected vs actual, and whether it also
reproduces on the base branch.

### Missions run
- M1 <name> — pass
- M2 <name> — **fail** → finding 1
- M3 <name> — pass

### Not checked
- <what, and why — e.g. "Stripe live flow: needs real keys">

<sub>Automated QA. Verify findings before acting; report false positives so the
product knowledge file can be corrected.</sub>
```

## Rules

- **No speculative findings.** If you did not see it happen in the browser, it
  does not go in the findings table. Hunches go in "Not checked".
- **Reproduce twice** before calling anything a defect.
- **Do not modify the PR.** No commits, no pushes, no fixes. Report only.
- Distinguish "this PR broke it" from "this was already broken" every time.
  **Suite failures that also fail on the base branch are pre-existing and never
  block this PR.** Label them so and move on — blocking a PR on a failure it did
  not cause is the fastest way to get the whole check ignored.
- **Read `.themegrill-qa/spec-queue.jsonl`.** If this PR's diff touches product
  source and the queue has pending records for its branch, add one line to the
  comment: *"This change has no regression spec; comment `@themegrill-qa specs`
  and one will be written."* A nudge, never a block.
- If the environment will not boot, post that as the comment and exit non-zero.
  A silent pass is worse than a visible failure.
- Keep the comment short enough to read on a phone. Detail goes in the workflow
  log and uploaded artifacts, not the comment body.
