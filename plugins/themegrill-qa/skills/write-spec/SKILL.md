---
name: write-spec
description: Turn a verified finding into a @fresh regression spec on the current branch, proved against both the broken and the fixed code
argument-hint: "[what to guard, or a Jira key — empty drains the spec queue]"
allowed-tools: Bash, Read, Grep, Glob, Edit, Write, mcp__playwright__*, mcp__atlassian__*
pass-arguments: true
---

# Write a regression spec

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

---

## What this is for

This is the **graduation mechanism**, and it is the only part of this platform
that makes the next run cheaper than this one.

> An agent finding costs tokens on every run, forever.
> The same finding as a committed spec costs tokens once, then runs for
> approximately free on every PR for the life of the product.

So a verified finding that does not become a spec is a finding you will pay to
rediscover. Your job is to stop that happening — **once**, correctly, with proof.

Read `SUITE.md` for the contract and `CONVENTIONS.md` for the house style. Both
are mandatory, not background reading.

## Your input

One of three, in this order:

1. **A finding handed over** by `verify-fix`, `pr-qa-review` or
   `regression-sweep`, with its verdict. This is the normal case.
2. **`$ARGUMENTS`** describing what to guard, or a Jira key.
3. **Nothing** — then read the working tree diff plus the spec queue at
   `.themegrill-qa/spec-queue.jsonl`, take the **oldest `pending` record**, and
   work from that. Say which record you took.

---

## Step 1 — Check nobody has already written this

```bash
node "$QA/scripts/suite-index.mjs" --pretty
```

Look at the `guards` map for the Jira key, and at `by_area` and the spec titles
for the behaviour. **If an existing spec already guards this, stop and say so.**

Duplicate specs are worse than no spec: they double the maintenance and halve the
signal. Two specs asserting the same thing means every future change to that
behaviour produces two failures, and the second one teaches whoever is reading
that failures come in redundant pairs.

If a spec guards it but is `fixme`, that is not a duplicate — that is the spec
you are here to activate. Go to Step 5's REGRESSION row.

## Step 2 — Read the conventions, in full

`CONVENTIONS.md`. All ten rules. The Customizer subsections in particular exist
because each one cost a live debugging session — stale changesets, teardown
reverts, and never waiting on `#save`'s disabled state.

The ones this skill gets wrong most often:

- **Rule 1** — select on markup we own. Themes: semantic selectors first
  (`getByRole`, `getByLabel`, headings, landmarks). Plugins: `data-<prefix>-*`.
  Never `.wp-block-*`, `.woocommerce-*`, or a theme's class names.
- **Rule 3** — seed state, click only what is under test.
- **Rule 4** — tag every fixture and clean up, child tables before parent.
- **Rule 10** — tier every test, and match the product's existing harness.

## Step 3 — Match the existing suite, do not start a second one

Read **two or three existing specs** from the manifest's `spec_dir` before
writing a line. Copy their imports, fixtures, helpers and naming.

**Never introduce a second harness.** If the suite is TypeScript on pnpm, write
TypeScript on pnpm — not JavaScript, not a new config, not a different test
utility package because you prefer it. A product with two harnesses has neither:
the second one rots because only its author runs it.

If the product has no suite at all (`suite: false`), say so and stop. Bootstrapping
a suite is a human decision about tooling, not something to do as a side effect
of a bug fix.

## Step 4 — Write exactly one spec

`@fresh`-tagged, with the full docblock from `SUITE.md` §3:

```js
/**
 * @area    header
 * @tier    fresh
 * @guards  CMAG-1234
 * @source  verify-fix 2026-08-24
 * @why     Switching to the centered header layout dropped the tagline entirely.
 *          Guards the regression, not the layout's styling.
 */
test('centered header keeps the tagline @fresh @header', async ({ page }) => {
```

The tags go **in the title**, because the title is what `--grep` matches. The
docblock repeats them for the index. Both, every time.

`@why` says what regression this guards and, just as importantly, **what it
deliberately does not assert**. The person reading it next is deciding whether a
failure is a real bug or a stale test, and that line is what lets them tell.

### `@fresh` or nothing

Every spec you write runs on a clean `boot-wp` site seeded only by the blueprint.
If the finding only reproduces on a demo-imported site, then **the blueprint
requirement is itself the finding**: report that the platform cannot reproduce
this in CI and say what the blueprint would need to seed. Do not write a `@demo`
spec — it would never run in CI and would create the appearance of coverage
without any.

## Step 5 — Prove it

**This gate is the entire reason the spec is worth committing.** A spec nobody
proved is a guess with a green tick next to it.

| Check | Requirement |
|---|---|
| Against the **fixed** code | passes **3 runs out of 3** |
| Against the **broken** code (`git stash`, or check out the parent commit) | **fails**, and fails with an assertion about the actual bug — not a timeout, not a selector error |
| Runtime | under 30s, or justify it in `@why` |

```bash
# 1. fixed code, three times — must pass 3/3
for i in 1 2 3; do
  node "$QA/scripts/run-suite.mjs" --tier fresh --grep "<your test title>" --json \
    || echo "RUN $i FAILED"
done

# 2. broken code — stash ONLY the source files, never the spec
git stash push -- <the source files the fix touched>
node "$QA/scripts/run-suite.mjs" --tier fresh --grep "<your test title>" --json  # must exit 1
git stash pop
```

**Use the pathspec. Do not rely on a bare `git stash` here.** Checked against
real git rather than assumed:

| What you do | Bare `git stash` | Result |
|---|---|---|
| Spec left untracked | does not stash untracked files | spec survives — happens to work |
| Spec `git add`-ed first | stashes staged files too | **spec disappears** |
| `git stash push -- <source files>` | touches only those paths | spec survives, always |

So a bare stash works only as long as nobody stages the spec first, and staging
it is a completely natural thing to do. When it does go wrong the failure is
silent and misleading: the spec is gone, Playwright reports "no tests found", and
you would read that as the spec failing against the broken code. It did not
fail — it did not run, and a spec that never ran has proved nothing.

Name the source files and leave the spec out of it.

Confirm before you trust the result:

```bash
git stash list          # your stash, holding source only
git status              # the spec still present, the fix gone
```

Read the broken-code failure message before accepting it. A spec that fails
because a selector did not resolve, or because the page timed out, has not
demonstrated anything about the bug — it would fail just as readily on a typo.
The failure must be the **assertion** failing, on the value the bug produces.

**A spec that passes on both versions is worthless — it does not test the fix.**
Delete it and report that the finding is not mechanically observable. That is a
legitimate and useful outcome. A fake spec is not: it is a permanent green tick
over an unguarded regression, which is worse than the gap it hides.

## Step 6 — Get back to the fixed code, and verify you did

```bash
git stash list        # expect your stash gone
git status            # expect the fix present, plus your new spec
git diff --stat
```

Do this explicitly. A `git stash pop` that silently conflicted leaves the working
tree on the broken code, and every subsequent step then reports on the wrong
thing.

## Step 7 — Leave the spec on the current branch, and stop

**Write the spec into the branch the developer is already working on.** Do not
create a branch, do not switch branches, do not push, do not open a PR.

The spec and the fix it guards belong in the same commit history: a reviewer
seeing the fix should see the test for it in the same PR, and CI running that PR
should run that spec against that fix. Splitting them across two branches means
the spec lands separately, reviewed by someone with no context, and CI on the
original PR never runs it.

```bash
git branch --show-current    # confirm you are on the developer's branch
git status --short           # the fix, plus your new spec
```

**Do not commit.** The developer commits and pushes, alongside their fix. You
have just written a test for someone else's change on their branch — they get to
read it first.

Report the path and let them take it from there:

```
Spec written: tests/e2e/specs/header/centered-header-tagline.spec.ts
On branch:    fix/CMAG-1234-header
Commit it with your fix — CI runs the full @fresh tier on the PR.
```

If a queue record in `.themegrill-qa/spec-queue.jsonl` covers this branch, append
an updated record marking it `done`. Append, never rewrite.

---

## Verdict-to-spec mapping

The calling skill's verdict decides what gets written. This table is the whole
decision — do not improvise around it.

| Verdict from the calling skill | What to write |
|---|---|
| **VERIFIED** (bug reproduced broken, gone when fixed) | An active `@fresh` spec asserting the fixed behaviour. This is the main case. |
| **REGRESSION** or **INCOMPLETE** | A `test.fixme()` spec naming the open Jira key, so it flips green the day it is fixed. Report the finding as well. |
| **CANNOT VERIFY** | Nothing. Write no spec. |
| A finding with **no mechanical assertion** (subjective visual, timing-dependent) | Nothing — add a line to the knowledge file's Known-fragile section instead. |

**Never write a permanently-red spec without `fixme`.** A permanently-red suite
trains the team to ignore red, and that costs more than the coverage is worth —
it costs every *other* spec's signal too. `fixme` is how you record "this is
broken and we know" without spending that.

A `fixme` spec still has to be proved, just inverted: it must fail against the
current code for the right reason. Run it once with the `fixme` removed and read
the failure before committing it with the `fixme` back on.

---

## Report

```
Spec       <path>  — or "none written"
Guards     <KEY / behaviour>
Tier       fresh
Branch     <name>
Proof      fixed 3/3 pass · broken fails on <the assertion, quoted>
Runtime    <n>s
Queue      <record marked done, or "no queue record">
```

If you wrote nothing, say which row of the mapping table applied and why. "No
spec, and here is the reason" is a complete and successful outcome of this skill.

## Rules

- **Never edit product source.** Not to make your spec pass, not to add a test
  hook, not "just a data attribute". If the product needs an owned selector to be
  testable (`CONVENTIONS.md` rule 1), say so in the report and let a human add
  it — that is a change to shipped markup and belongs in a reviewed PR.
- **One spec per finding.** If you found three things, you were handed three
  findings; write them one at a time.
- **Never weaken an assertion to get green.** If the assertion has to be loosened
  to pass, the spec is testing something other than the bug.
- If the suite will not run at all, stop and report that. Do not write a spec you
  could not execute — an unexecuted spec is a guess.
