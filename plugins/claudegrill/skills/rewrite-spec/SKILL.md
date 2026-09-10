---
name: rewrite-spec
description: Migrate a product's existing tests/e2e specs from the old bug-centric shape into the feature-centric one — one feature at a time, losing nothing, proved by the equivalence gate
argument-hint: "[an area, a feature, or a spec path — empty asks which to start with]"
allowed-tools: Bash, Read, Grep, Glob, Edit, Write, AskUserQuestion
pass-arguments: true
---

# Migrate existing specs to the feature-centric shape

## Where the scripts live — resolve this first

```bash
QA="${CLAUDE_PLUGIN_ROOT:-${THEMEGRILL_QA_HOME:-..}/plugins/claudegrill}"
node "$QA/scripts/detect-product.mjs" >/dev/null && echo "QA=$QA"
```

`CLAUDE_PLUGIN_ROOT` is set automatically when this runs as an installed plugin,
which is the normal case; the fallback covers a CI checkout, where the scripts are
copied into the runner rather than installed. If the shell is not bash —
PowerShell on a Windows machine, say — use that shell's equivalent.

If neither variable resolves to a directory containing `scripts/`, stop and say
so. Guessing at a path produces a confusing failure several steps later.

---

## What this is for

`write-spec` writes new coverage into the **feature's** spec: a spec file is a
feature, a `test()` is a scenario, and a Jira key is metadata on a scenario
(`CONVENTIONS.md` rule 11). Specs written before that rule existed are shaped the
other way — one file per ticket, named after the bug, holding a single test.

This skill migrates them. ColorMag is the reference case: **18 spec files, 23
tests, 17 files holding a single scenario**, with names like
`header-logo-sizing-regression.spec.ts` and `css-custom-property-corruption.spec.ts`.
Those are perfectly good tests filed the wrong way up.

### What this skill is NOT

**It is not a rewrite of the tests.** You are moving and regrouping working
assertions, not improving them. The distinction is the whole safety model:

| Allowed | Forbidden |
|---|---|
| move a `test()` into the feature's spec file | change an assertion |
| rename a file after its feature | change a selector |
| rename a test so the title describes the behaviour | change a fixture, helper or import route |
| merge two scenarios that assert one behaviour, keeping both `@guards` keys | change a tier tag |
| complete a docblock — `@area`, `@tier`, `@guards`, `@why` | change `test.setTimeout`, waits or timeouts |
| delete a file after its scenarios have moved out of it | "fix" a failing or flaky spec |

A spec that was failing before the migration is still failing after it, and you
say so. **Do not repair it here.** A migration that also changes behaviour cannot
be reviewed: the diff stops being "these tests moved" and becomes a diff nobody
can read, and the one thing that makes this safe — that the assertions are
untouched — is gone.

**Never edit product source.** Not even to add an owned selector that would make a
migrated spec better. That is `write-fix`, on its own branch.

---

## Step 1 — See the shape, and pick ONE feature

```bash
node "$QA/scripts/suite-index.mjs" --pretty
```

Read, in this order:

- `feature_hygiene.issue_named_specs` — files named after a ticket. The backlog.
- `feature_hygiene.single_scenario_specs` — files holding one scenario. Candidates
  to fold into a feature, **not** defects: a feature can legitimately have one.
- `features_by_area` — which files an area already holds. This is where the
  grouping comes from.
- `features[<path>].scenarios` — the titles, tiers and guards you must preserve.

`$ARGUMENTS` may name an area, a feature or a spec path. If it is empty, propose
the candidates and **ask which to start with** — do not pick for the user. The
right first target is usually an area with several single-scenario bug-named files
that plainly describe one feature.

**One feature per invocation.** Not one area, not "the suite". Three reasons, and
the third is the one that bites:

1. The equivalence gate below is readable for one feature and unreadable for
   twenty.
2. A migration is a moved CI path — `area_paths` and `pr-scope.mjs --spec` both
   reference these filenames. A reviewer can check one feature's worth.
3. If the gate fails you have to find which of the moves lost something. With one
   feature that is a glance; with the whole suite it is a bisect.

State which feature you chose, which files it pulls from, and which it leaves
alone.

## Step 2 — Snapshot the baseline. Before you touch anything.

```bash
node "$QA/scripts/spec-equivalence.mjs" --snapshot .themegrill-qa/spec-baseline.json
```

This is the record of what the suite covered *before* you started: every
`@guards` key, every scenario title, every tier, every covered area. Step 6
compares against it.

**Take it first.** Taken afterwards it records the damage as the baseline, and the
gate then passes whatever you did — the failure mode being that it passes
silently, which is indistinguishable from success.

Then establish whether the specs you are about to move currently pass:

```bash
node "$QA/scripts/run-suite.mjs" --tier fresh --area <the area> --json
```

Record the result. A spec that was red before the move must be equally red after
it, and one that was green must stay green. Without this line you cannot tell
your migration from a pre-existing failure — and you will be asked.

If the suite cannot run at all, **stop**. A migration you cannot execute is a
guess about code you have rearranged, which is worse than leaving it alone.

## Step 3 — Decide the target shape, and write it down first

For the chosen feature, name:

- **the file** it will live in — named for the feature, in the directory
  convention the suite already uses. Do not invent a new layout; if the product
  files specs as `specs/<group>/<behaviour>.spec.ts`, stay in that.
- **the scenarios** it will hold, with the title each will carry.
- **which existing files** are emptied and deleted.
- **which scenarios merge**, if any, and which keys the survivor carries.

Then check the plan against these rules before typing a line:

1. **The file is the feature. The title is the behaviour. The key is history.**
2. **Every `@guards` key survives.** Keys are the audit trail from a ticket to the
   thing that prevents it recurring; a dropped key is an unguarded regression that
   still reports green. This is the one rule the gate enforces absolutely.
3. **Two scenarios merge only if they assert the same user-visible behaviour.**
   Same area and same file is not the same behaviour. When in doubt, keep both —
   a redundant scenario costs seconds, a merged-away assertion costs a regression.
4. **Tier tags do not change.** A `@demo` spec stays `@demo` even when its new
   neighbours are `@fresh`. Promoting it is a claim that it runs on a clean site,
   which you have not tested and which §2 of `SUITE.md` says must be earned.
5. **An `@area` tag is authoritative over the directory.** Where they disagree
   today, keep the tag and let the file move; changing an area tag changes what CI
   scoping selects and is a separate, deliberate decision.
6. **A feature that genuinely holds one scenario stays one file.** Do not
   manufacture grouping. `feature_hygiene` lists candidates, not instructions.
7. **Keep the docblock, and complete it.** `@why` carries why the scenario exists
   and what it deliberately does not assert — it is what the next `write-spec`
   run reads to decide whether a finding is already covered. Preserve the original
   wording; add the missing fields, do not reword what is there.

If the plan would break any of these, say so and narrow it rather than bending the
rule.

## Step 4 — Move the code, mechanically

Work file by file:

1. Copy the `test()` **and its docblock**, verbatim, into the target file.
2. Bring the imports, fixtures and helpers it needs — the target's existing ones
   where they are identical, additional ones where they are not. **Never swap one
   fixture for another** because the target happens to use a different one: that
   is a behaviour change wearing a refactor's clothes.
3. Retitle only for behaviour, keeping every tag: `CMAG-650 regression @fresh
   @header` becomes `a lone logo keeps full header column width @fresh @header`.
   **The tags must survive the retitle** — they are what `--grep` selects on, and
   a dropped `@fresh` silently turns a CI spec into a `@demo` one.
4. Delete the emptied source file. Do not leave a file re-exporting or importing
   from its replacement.
5. Repeat until the feature is in one file.

Two traps, both specific to this catalogue:

- **Shared setup is not automatically shareable.** Two scenarios that each seeded
  their own posts now sit in one file; hoisting that into a single `beforeAll` is
  a change in what each test assumes and belongs in a separate commit, if at all.
  Leave the per-test setup alone on this pass.
- **Customizer specs restore state in a fixture teardown**
  (`CONVENTIONS.md`). If you move a scenario into a file whose fixture restores
  different state, you have changed what it cleans up. Check the fixture the
  target file uses before moving a Customizer scenario into it.

## Step 5 — Run the specs. Same result as Step 2.

```bash
node "$QA/scripts/run-suite.mjs" --tier fresh --area <the area> --json
```

Compare against the Step 2 record, test by test:

- Anything green before must be green now.
- Anything red before must be red now, **for the same reason** — read
  `failures[].error`, not just the count.
- A test that has disappeared from the run is the failure this skill is most
  likely to produce: a retitle that dropped a tag, so `--grep` no longer selects
  it. The count is the tell; check it.

If something broke, **revert and narrow.** Do not repair forward. The diff is
supposed to be provably behaviour-neutral, and a fix applied on top of a broken
move is exactly the thing nobody can review afterwards.

## Step 6 — The equivalence gate

```bash
node "$QA/scripts/spec-equivalence.mjs" --check .themegrill-qa/spec-baseline.json
```

It fails on any **loss**, and loss is not the same as change:

| Checked | Why it is an error |
|---|---|
| a `@guards` key absent from the whole suite | a guarded regression is now unguarded, and the suite is green either way |
| a scenario present before, absent after | the assertion went somewhere, or nowhere |
| a scenario that left the `@fresh` tier | it no longer gates a PR |
| a scenario that became `fixme` / `skip` | present, no longer asserting |
| an area that lost all runnable `@fresh` coverage | the cost lever moved without anyone deciding to |

A **deliberate merge** passes only by naming what went:

```bash
node "$QA/scripts/spec-equivalence.mjs" --check .themegrill-qa/spec-baseline.json \
  --merged "logo width survives a layout switch @fresh @header"
```

That flag is the audit trail. Use it only for a scenario you folded into another
on purpose, and put the same sentence in the commit message. **Never use it to get
past a failure you do not understand** — a key or a scenario going missing when you
did not mean it to is the gate doing its job, and the answer is to put it back.

The gate cannot check the one thing it would most like to: a migrated scenario
**cannot be re-proved against the code it originally guarded**, because that fix
is long merged. That is precisely why the assertions are untouchable here. The
gate proves nothing was lost; only the untouched assertion proves the scenario
still means what it meant.

## Step 7 — Commit the move on its own

```bash
git status --short
git diff --stat
```

A migration commit contains **only** the migration. Not a fix, not a new
scenario, not a snapshot update — `CONVENTIONS.md` is explicit that a snapshot
update in a behaviour commit destroys the only evidence of what changed, and the
same logic applies here with more force: a move mixed with a change is a move
nobody can verify.

Leave it on the current branch, uncommitted, and report. The developer commits.
If they want a suggested message:

```
Refactor - Group <feature> specs by feature rather than by ticket

Moves N scenarios from <old files> into <new file>. No assertion, selector,
fixture or tier changed. Equivalence gate: M guarded keys preserved, N
scenarios preserved<, K merged: "...">.
```

Say in the report that the moved paths are **CI-visible**: `area_paths` in
`.themegrill-qa/suite.json` matches source paths rather than spec paths so it is
usually unaffected, but `pr-scope.mjs --spec` narrowing and any `--grep` or
`--spec` invocation somebody has saved locally both reference the old names. Check
`area_paths` and say whether it needed a change.

---

## Report

```
Feature     <feature>
Target      <path>  (new | existing)
Moved       <n> scenario(s) from:
              <old path>  -> <scenario title>
              <old path>  -> <scenario title>
Deleted     <files now empty>
Merged      <title folded away> into <surviving title>  — or "none"
Retitled    <old title>  ->  <new title>
Guards      <keys before> -> <keys after>   (must be equal)
Suite       before <n> passed / <n> failed · after <n> passed / <n> failed
Gate        EQUIVALENT — or what it reported
Unchanged   assertions, selectors, fixtures, tiers
Remaining   <n> issue-named spec(s) left in this area, for a later pass
```

`Guards` and `Suite` are the two lines a reviewer reads. If either moved, explain
it in the same breath or the migration is not reviewable.

If you migrated nothing, say why — "these three files each cover a distinct
feature and are already correctly shaped" is a complete and useful answer, and it
is the right answer more often than the backlog's length suggests.

## Rules

- **One feature per invocation.** Report what remains; do not keep going.
- **Never change an assertion, a selector, a fixture, a timeout or a tier.**
- **Never edit product source.**
- **Never drop a `@guards` key**, even one whose ticket is closed, and even when
  merging. The key is how a reviewer gets from a ticket to the test that holds
  its fix.
- **Never promote a `@demo` spec to `@fresh`** as part of a move. That is a claim
  about a clean site, and it needs a run on one.
- **Never repair a failing spec here.** Report it; it is `write-spec`'s or the
  developer's problem, on its own diff.
- **Never take the baseline after editing.** Step 2 comes first, always.
- If the suite will not run, stop. An unexecuted migration is a guess.
