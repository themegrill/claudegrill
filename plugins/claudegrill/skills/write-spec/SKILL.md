---
name: write-spec
description: Graduate a verified finding into the product's feature-centric suite — a new scenario in the feature's own spec, an update to the scenario that already guards it, or nothing — proved against both the broken and the fixed code
argument-hint: "[what to guard, or an issue number — empty drains the spec queue]"
allowed-tools: Bash, Read, Grep, Glob, Edit, Write, mcp__playwright__*
pass-arguments: true
---

# Graduate a finding into the suite

## Where the scripts live — resolve this first

Commands below refer to `$QA`, this plugin's own directory. Resolve it once
before anything else:

```bash
QA="${CLAUDE_PLUGIN_ROOT:-${THEMEGRILL_QA_HOME:-..}/plugins/claudegrill}"
node "$QA/scripts/detect-product.mjs" >/dev/null && echo "QA=$QA"
```

`CLAUDE_PLUGIN_ROOT` is set automatically when this runs as an installed plugin,
which is the normal case; the fallback covers a CI checkout, where the scripts are
copied into the runner rather than installed. If the
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

So a verified finding that does not become coverage is a finding you will pay to
rediscover. Your job is to stop that happening — **once**, correctly, with proof.

**But the unit of this suite is a feature, not a bug.** That is
`CONVENTIONS.md` rule 11 and it governs everything below. A tracker key is the
*reason* coverage was added; it is never the thing the coverage is named after,
filed under, or scoped to. Read rule 11 before you decide anything, because the
most likely wrong outcome of this skill is not a bad assertion — it is a correct
assertion in a brand-new file that duplicates what the feature's own spec was
already nearly asserting.

Read `SUITE.md` for the contract and `CONVENTIONS.md` for the house style. Both
are mandatory, not background reading.

## Your input

One of three, in this order:

1. **A finding handed over** by `verify-fix`, `pr-qa-review` or
   `regression-sweep`, with its verdict. This is the normal case.
2. **`$ARGUMENTS`** describing what to guard, or an issue number.
3. **Nothing** — then read the working tree diff plus the spec queue at
   `.themegrill-qa/spec-queue.jsonl`, take the **oldest `pending` record**, and
   work from that. Say which record you took.

Whichever it is, you do the feature lookup yourself. Do not assume a caller has
done it, and do not assume a caller wanting a spec means a caller wanting a new
file.

---

## Step 1 — Identify the feature

Read the index once. Everything in Steps 1 to 3 comes out of it:

```bash
node "$QA/scripts/suite-index.mjs" --pretty
```

Four fields carry the feature layer:

| Field | What it answers |
|---|---|
| `features` | keyed by spec file: its feature name, areas, guards, and **every scenario title in it** |
| `features_by_area` | which spec files already cover an area — the direction a finding arrives from |
| `areas_declared` / `areas_uncovered` | the product's own area vocabulary, and where it has nothing |
| `feature_hygiene` | specs named after a ticket, and specs holding a single scenario — the files to fold into rather than sit beside |

Then name the feature, from these sources in order of authority:

1. **The user-facing behaviour the finding is about** — what a customer would
   say broke. "The logo is squeezed when it is alone in the header column", not
   "`flex-basis` is applied unconditionally".
2. **The area**, from the changed files via the manifest's `area_paths`, and from
   the knowledge file's critical-flows list.
3. **The existing feature names in `features`** for that area.

**Do not invent a feature name while an existing one fits.** A feature that
already has a spec keeps the name that spec already has, even if you would have
named it better. Renaming is a separate, human, reviewed change —
`area_paths`, CI scoping and `@guards` history all reference these paths.

If you cannot confidently name the feature — the finding spans several, or it is
in an area the knowledge file does not declare — **stop and say so, naming the
candidates you considered.** Guessing produces a spec filed where nobody looking
for it will find it, which is the same cost as no spec plus a maintenance burden.

## Step 2 — Search for existing coverage, by behaviour

Two lookups, and you must do both. They fail differently.

**By key** — `guards` in the index. This finds a spec already filed against this
tracker key. It is the cheap check and the weak one: it only ever catches a
duplicate after the same behaviour has been filed under a second key, which is
exactly the case that produces two specs asserting one thing.

**By behaviour** — `features_by_area[<area>]`, then read the `scenarios` titles
of each spec file listed, then open the one or two that look closest and read
their assertions and their `@why`. The `@why` is written for precisely this
moment: it says what the spec deliberately does *not* assert.

```bash
# the feature's own specs, end to end — read them, do not skim the titles
node "$QA/scripts/suite-index.mjs" --pretty | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const i=JSON.parse(s), area=process.argv[1];
  for (const f of i.features_by_area[area] ?? []) {
    console.log(f);
    for (const sc of i.features[f].scenarios)
      console.log("   ", sc.tier, sc.guards.join(",")||"-", sc.title);
  }
});' header
```

Grep the spec directory for the behaviour's vocabulary too — the setting name,
the theme mod key, the selector, the control id. A spec can cover a behaviour
without using the word the finding uses for it.

Then classify the finding as exactly one of four:

| | State | Goes to |
|---|---|---|
| **1** | Already covered — a scenario asserts this behaviour and would have failed on the broken code | Step 3, REUSE |
| **2** | Partially covered — a scenario is about this behaviour but would have passed on the broken code | Step 3, EXTEND |
| **3** | Not covered — the feature exists, this behaviour has no scenario | Step 3, ADD |
| **4** | Not mechanically testable — subjective visual, timing-dependent, or only reproducible on demo content | Step 3, NONE |

State which of the four you concluded **and the evidence**: the scenario title
and the line you read, or the greps that came back empty. "I searched and found
nothing" without saying what you searched is not a finding, it is a shrug.

## Step 3 — Decide the action, then do exactly that one

| Action | When | What you do |
|---|---|---|
| **REUSE** | State 1 | Write no test. Add the issue key to that scenario's `@guards` if it is not there. Re-run the proof gate against the *existing* scenario to confirm it really does fail on the broken code. Report `no change`. |
| **EXTEND** | State 2 | Strengthen or extend the existing scenario **additively** — add the assertion the broken code violates, keep every assertion and every `@guards` key already there. Append your key to `@guards`. |
| **ADD** | State 3 | Add a new `test()` to the feature's existing spec file. One new scenario, named for the behaviour. |
| **NEW FILE** | State 3, **and** no spec file covers this feature at all | Create one spec file for the feature, named for the feature. |
| **NONE** | State 4 | Write nothing. Add a line to the knowledge file's Known-fragile section, or report the blueprint requirement. |

### The decision rules, stated so they are not re-litigated

1. **A new issue does not imply a new spec file.** It implies a question:
   is this behaviour covered?
2. **A verified bug does not imply a new test.** Step 2 decides that, not the
   verdict.
3. **A new scenario belongs in the feature's existing spec file whenever one
   exists.** `features_by_area` tells you whether one exists.
4. **Two bugs describing one user-visible behaviour get one strong scenario with
   both keys in `@guards`** — never two scenarios so each key has its own.
5. **A bug exposing a missing edge case of an existing scenario extends that
   scenario, or becomes a sibling scenario in the same file.** Not a new file.
6. **Only a genuinely separate product feature justifies a new spec file.** If
   you are about to create one, say in the report which existing specs you read
   and why none of them owns this behaviour.
7. **The title describes the behaviour; `@guards` carries the history.** Never
   `test('CMAG-1234')`, never `test('regression test')`, never
   `test('fix works')`. A reader who does not know the ticket must be able to
   tell what broke from the title alone.
8. **Never trade away a deterministic assertion to keep the grouping tidy.** If
   the honest assertion does not belong in this feature's spec, it gets its own
   file and you say why in the report. Rule 11 organises good specs; it does not
   license weak ones.

### The one guard rail on EXTEND

Editing a scenario that already passes is the most dangerous thing this skill
does, because **the code the existing scenario was proved against is usually long
merged** — you cannot re-prove what it originally guarded. ColorMag's
`header-logo-sizing-regression.spec.ts` records exactly that failure in its own
docblock: an edit changed what it asserted, and it then "reported ColorMag as
broken" when the theme was correct.

So:

- **Prefer ADD over EXTEND** whenever the new assertion can stand as its own
  scenario. A sibling scenario risks nothing.
- When you do EXTEND, **every existing assertion and every existing `@guards`
  key stays**, verbatim. You are adding, never rewriting.
- If the existing scenario has to be *weakened* for your case to fit, that is not
  an EXTEND. Leave it alone and ADD.
- Say `updated` in the report, list the keys the scenario now guards, and name
  what you added. A reviewer must be able to see you did not quietly change an
  old promise.

## Step 4 — Read the conventions, in full

`CONVENTIONS.md`. All eleven rules. The Customizer subsections in particular
exist because each one cost a live debugging session — stale changesets, teardown
reverts, and never waiting on `#save`'s disabled state.

The ones this skill gets wrong most often:

- **Rule 1** — select on markup we own. Themes: semantic selectors first
  (`getByRole`, `getByLabel`, headings, landmarks). Plugins: `data-<prefix>-*`.
  Never `.wp-block-*`, `.woocommerce-*`, or a theme's class names.
- **Rule 3** — seed state, click only what is under test.
- **Rule 4** — tag every fixture and clean up, child tables before parent.
- **Rule 10** — tier every test, and match the product's existing harness.
- **Rule 11** — the file is a feature; the key is metadata.

## Step 5 — Match the existing suite, do not start a second one

If you are adding to an existing spec file, you are already in its idiom — use
its fixtures, its helpers, its `beforeAll` seeding rather than introducing a
second set beside them. If a new file is justified, read **two or three existing
specs** from the manifest's `spec_dir` before writing a line and copy their
imports, fixtures, helpers and naming.

**Never introduce a second harness.** If the suite is TypeScript on pnpm, write
TypeScript on pnpm — not JavaScript, not a new config, not a different test
utility package because you prefer it. A product with two harnesses has neither:
the second one rots because only its author runs it.

If the product has no suite at all (`suite: false`), say so and stop. Bootstrapping
a suite is a human decision about tooling, not something to do as a side effect
of a bug fix.

## Step 6 — Write exactly one scenario

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
failure is a real bug or a stale test — and, now, whether their own finding is
already covered by it. That line is what lets them tell.

Where the file holds several scenarios, put yours inside the existing
`test.describe` for the feature and leave the surrounding structure alone. Order
scenarios so a reader meets the primary flow first and the regression last; the
regression is the footnote, not the headline.

**Do not turn the spec file into product documentation.** Feature purpose,
business rules, critical flows and known-fragile notes live in
`.themegrill-qa/knowledge.md`. The docblock says why this scenario exists and
what it does not cover — that is all of the prose a spec file earns.

### `@fresh` or nothing

Every scenario you write runs on a clean `boot-wp` site seeded only by the
blueprint. If the finding only reproduces on a demo-imported site, then **the
blueprint requirement is itself the finding**: report that the platform cannot
reproduce this in CI and say what the blueprint would need to seed. Do not write
a `@demo` spec — it would never run in CI and would create the appearance of
coverage without any.

## Step 7 — Prove it

**This gate is the entire reason the coverage is worth committing.** A spec
nobody proved is a guess with a green tick next to it.

| Check | Requirement |
|---|---|
| Against the **fixed** code | passes **3 runs out of 3** |
| Against the **broken** code (`git stash`, or check out the parent commit) | **fails**, and fails with an assertion about the actual bug — not a timeout, not a selector error |
| Runtime | under 30s, or justify it in `@why` |

This gate applies to **every action except NONE** — including REUSE, where you
wrote nothing. A scenario you are crediting with covering this finding has to be
shown to fail on the broken code, or the credit is unearned and the finding has
silently gone unguarded.

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

When you added a scenario to an existing file, grep on **your scenario's title**,
not the file. The file's other scenarios are already proved; re-running them here
buys nothing and a pre-existing failure in one of them would read as your
scenario failing.

On **EXTEND**, run the whole file against the fixed code instead — 3/3 — because
you edited a test other findings depend on. Any scenario in that file that was
green before your edit must still be green after it. If one is not, you changed
an old promise: revert and ADD instead.

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

**On EXTEND and ADD this trap is worse**, because the file is already tracked and
already committed: stashing it does not make it vanish, it reverts it to the
version without your scenario. Playwright then runs the old file, reports the old
scenarios passing, and you read a pass where your scenario never existed. Name
the source files and leave the spec file out of the pathspec, every time.

Confirm before you trust the result:

```bash
git stash list          # your stash, holding source only
git status              # your spec change still present, the fix gone
git diff -- <spec file> # your scenario still in the working tree
```

Read the broken-code failure message before accepting it. A spec that fails
because a selector did not resolve, or because the page timed out, has not
demonstrated anything about the bug — it would fail just as readily on a typo.
The failure must be the **assertion** failing, on the value the bug produces.

**A spec that passes on both versions is worthless — it does not test the fix.**
Delete it and report that the finding is not mechanically observable. That is a
legitimate and useful outcome. A fake spec is not: it is a permanent green tick
over an unguarded regression, which is worse than the gap it hides.

## Step 8 — Get back to the fixed code, and verify you did

```bash
git stash list        # expect your stash gone
git status            # expect the fix present, plus your spec change
git diff --stat
```

Do this explicitly. A `git stash pop` that silently conflicted leaves the working
tree on the broken code, and every subsequent step then reports on the wrong
thing.

## Step 9 — Leave the change on the current branch, and stop

**Write into the branch the developer is already working on.** Do not create a
branch, do not switch branches, do not push, do not open a PR.

The spec and the fix it guards belong in the same commit history: a reviewer
seeing the fix should see the test for it in the same PR, and CI running that PR
should run that spec against that fix. Splitting them across two branches means
the spec lands separately, reviewed by someone with no context, and CI on the
original PR never runs it.

```bash
git branch --show-current    # confirm you are on the developer's branch
git status --short           # the fix, plus your spec change
```

**Do not commit.** The developer commits and pushes, alongside their fix. You
have just written a test for someone else's change on their branch — they get to
read it first.

If a queue record in `.themegrill-qa/spec-queue.jsonl` covers this branch, append
an updated record marking it `done`. Append, never rewrite. A REUSE outcome marks
the record `done` too — the finding is guarded, which is what the queue tracks.

---

## Verdict-to-action mapping

The calling skill's verdict decides *what kind* of coverage is owed. Step 2
decides *where it goes*. Both, in that order — do not improvise around either.

| Verdict from the calling skill | What is owed |
|---|---|
| **VERIFIED** (bug reproduced broken, gone when fixed) | Active `@fresh` coverage asserting the fixed behaviour: REUSE, EXTEND, ADD or NEW FILE per Step 3. This is the main case. |
| **REGRESSION** or **INCOMPLETE** | A `test.fixme()` scenario naming the open issue, so it flips green the day it is fixed — in the feature's existing spec file, same as any other scenario. Report the finding as well. |
| **CANNOT VERIFY** | Nothing. |
| A finding with **no mechanical assertion** (subjective visual, timing-dependent) | Nothing — add a line to the knowledge file's Known-fragile section instead. |

**Never write a permanently-red spec without `fixme`.** A permanently-red suite
trains the team to ignore red, and that costs more than the coverage is worth —
it costs every *other* spec's signal too. `fixme` is how you record "this is
broken and we know" without spending that.

A `fixme` scenario still has to be proved, just inverted: it must fail against
the current code for the right reason. Run it once with the `fixme` removed and
read the failure before committing it with the `fixme` back on.

A spec that guards this behaviour but is `fixme` is **not** a REUSE. It is the
scenario you are here to activate: remove the `fixme`, prove it, and report
`updated`.

---

## Report

```
Feature    <feature name>
Spec       <path>
Scenario   <test title>  — or "none"
Action     added | updated | reused | new file | none
Guards     <issue keys the scenario now carries>
Tier       fresh
Branch     <name>
Proof      fixed 3/3 pass · broken fails on <the assertion, quoted>
Runtime    <n>s
Queue      <record marked done, or "no queue record">
```

When nothing was written:

```
Feature    <feature name>
Spec       <the existing path>
Action     no change
Reason     <which row of the mapping table, or which scenario already covers it>
Proof      existing scenario "<title>" fails on the broken code — <the assertion>
```

**"No new test" is a successful outcome of this skill, not a failure.** Reused
coverage is the cheapest result available: the regression is guarded and the
suite did not grow. Say it plainly, with the evidence, and do not pad it into
sounding like a shortfall.

Always name the feature and the scenario. A report that names only a path leaves
the next reader to work out what it covers — and that reader is usually this
skill, on the next finding in the same area.

## Rules

- **Never edit product source.** Not to make your spec pass, not to add a test
  hook, not "just a data attribute". If the product needs an owned selector to be
  testable (`CONVENTIONS.md` rule 1), say so in the report and let a human add
  it — that is a change to shipped markup and belongs in a reviewed PR.
- **One finding at a time.** If you were handed three, work them one at a time;
  the second may well REUSE what the first added.
- **Never weaken an assertion to get green** — your own, or one that was already
  in the file.
- **Never create a second file for a behaviour the feature's spec covers.** That
  is the failure this skill was rewritten to stop.
- **Never rename or move an existing spec file as a side effect.** `area_paths`,
  CI scoping and `@guards` history reference those paths; renaming is a reviewed
  human change. Report it as a suggestion if the name is wrong.
- If the suite will not run at all, stop and report that. Do not write a spec you
  could not execute — an unexecuted spec is a guess.
