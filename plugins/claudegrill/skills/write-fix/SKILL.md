---
name: write-fix
description: Write the fix or feature in a ThemeGrill plugin or theme to house coding standards, run the PHPCS gate, verify it, and prepare the commit, changelog entry and PR
argument-hint: "[what to fix — a Jira key, an issue number, or a description]"
allowed-tools: Bash, Read, Write, Edit, Grep, Glob, Skill, AskUserQuestion, mcp__playwright__*, mcp__atlassian__*
pass-arguments: true
---

# Write the fix

This is the one skill in this plugin that **changes product source**. Every
other one verifies and refuses to touch the code. Keep that distinction sharp:
the moment you are done writing, you hand the result to the skills that check
it, and you do not adjust the code to make a check pass.

## Step 0 — Load the standards. Not optional.

```
Skill: wp-coding-standards
```

Do this **before reading the bug and before opening a single source file.** It
governs naming, the reuse ladder, PHP 7.4 limits, the security rules, the PHPCS
gate, and how the commit, changelog entry and PR are written. Everything below
assumes you have it loaded; this skill only adds the workflow around it.

Resolve the scripts too, for the handoffs later:

```bash
QA="${CLAUDE_PLUGIN_ROOT:-${CLAUDEGRILL_HOME:-..}/plugins/claudegrill}"
node "$QA/scripts/detect-product.mjs"
```

That names the product, its type, its version, its branch, and any Jira key in
the branch name.

## Step 1 — Understand the defect before touching anything

`$ARGUMENTS` is a Jira key, an issue number, or a description. Sources, in order
of authority:

1. **A Jira key** — from `$ARGUMENTS` or the branch name. Fetch it through the
   Atlassian MCP. The reported steps and expected behaviour are the
   specification; use them verbatim rather than inventing your own.
2. **A GitHub issue** — `gh issue view <n>`.
3. **The description you were given**, and nothing more.

Write out, explicitly, before opening an editor:

- **Symptom** — what a user sees, in their words.
- **Reproduction** — the exact steps.
- **Expected** — what should happen instead.
- **Root cause** — the actual mechanism, with `file:line`. Not "the value is
  wrong" but "`prefix_get_total()` returns a string and the caller compares with
  `===`".

**If you cannot state the root cause with a file and a line, you are not ready
to write.** Trace the real flow first. A fix aimed at a symptom you have not
located is a guess, and a guess that happens to make the symptom disappear is
the most expensive kind of wrong.

Read the product's `.themegrill-qa/knowledge.md` if it has one — it records the
critical flows, the fragile areas, and the known non-issues.

## Step 2 — Which repository

If the product has a pro edition, decide **before** editing. The
*Which repository does the change go in* section of the standards is the rule;
apply it and state the answer.

The short version: the file lives inside a synced path, it is owned by the free
repo and you edit it there. It exists only in pro, you edit pro. Never both.

Say which repo you are writing to and why, in one line, before the first edit.

## Step 3 — Walk the reuse ladder

The standards' ladder is not advice you may skip because the fix looks small. In
particular, rung 3 — *does this project already have it* — is the one that gets
skipped and the one that produces the duplicate helper a reviewer sends back.

Before writing a new function, grep for it:

```bash
ls inc/*function* inc/*template* includes/*function* includes/*helper* src/Helpers 2>/dev/null
grep -rn "function <slug>_.*<thing>" inc/ includes/ src/
```

And before fixing a bug in a shared function, **grep every caller**:

```bash
grep -rn "prefix_the_broken_function" --include="*.php" .
```

One guard in the shared function beats a guard in each caller, and patching only
the reported path leaves the siblings broken. Say how many callers you found.

## Step 4 — Write it

Minimum code that works, to the standards. The rules that get broken most often,
in this order:

- **Security is not negotiable** — nonce, capability, sanitize on input, escape
  at the point of output. Every one, every entry point, even a "small" AJAX
  handler.
- **PHP 7.4.** No `match`, no `?->`, no `str_contains`, no promotion, no union
  types. These pass locally on a modern PHP and fatal on a customer's host.
- **`array()`, Yoda, `===`, aligned `=`.** `phpcbf` fixes the last one; the
  others it cannot.
- **Docblock on anything public**, one-line summary, `@since` with a real
  version. Hooks always.
- **`function_exists` wrapper** on a global helper, so a child theme can
  override it.
- **One line of comment, explaining why.** Never what.

Do not reformat lines the fix does not touch. An unrelated cleanup inside a bug
fix makes the diff unreviewable and hides the actual change.

## Step 5 — The PHPCS gate

Mandatory, and it comes before anything else. The standards carry the full
procedure; the part people get wrong is the ruleset:

```bash
grep -A3 '"phpcs"' composer.json ; ls phpcs.xml phpcs.xml.dist 2>/dev/null
```

ThemeGrill products get their ruleset from `wpeverest/wpeverest-sniffs` through
a composer script and ship **no `phpcs.xml`**, so a bare `--standard=WordPress`
run checks something different from what CI checks. Use the project's script:

```bash
composer phpcbf -- $(git diff --name-only --diff-filter=ACMR HEAD -- '*.php')
composer phpcs  -- $(git diff --name-only --diff-filter=ACMR HEAD -- '*.php')
```

Report the outcome — clean with the file count and the ruleset used, or every
violation as `file:line — sniff — message`. Pre-existing violations on lines you
did not touch are named and left alone. If PHPCS is not installed, say so and
stop; do not call the code clean.

## Step 6 — Prove it actually fixes the bug

Writing code that compiles is not the deliverable. Hand it to the skill that
checks it:

```
Skill: verify-fix
```

`verify-fix` reproduces the bug against the stashed code, confirms it is gone
with the change applied, probes the blast radius, and runs the specs for the
areas your diff touches. It returns one of four verdicts.

**Do not edit the source to make its checks pass.** That inverts the whole
point. If it comes back:

- **VERIFIED** — go on to Step 7.
- **INCOMPLETE** — the underlying problem survives in a related path. Go back to
  Step 1 and re-derive the root cause; it was wrong.
- **REGRESSION** — the fix broke something else. Fix that properly, not by
  narrowing the assertion.
- **CANNOT VERIFY** — say why, and do not claim the fix works.

If the product has no suite and no reproducible path, say plainly that the fix
is unverified rather than implying otherwise.

## Step 7 — Freeze it as a spec

```
Skill: write-spec
```

A fix that does not become a spec is a bug you have arranged to fix twice. The
spec must fail against the broken code with an **assertion** failure, not a
timeout — that is the proof gate, and it is what makes the spec worth its
runtime.

Skip only when `write-spec` itself declines, and then say which row of its
mapping table applied.

## Step 8 — Commit, changelog, PR

The standards govern the format. The shape, in order:

1. **Changelog entry** — open the changelog file and copy the surrounding lines
   exactly. Labels and date format differ per product (ColorMag uses
   `Added` / `Tweak` / `Fix` with an ISO date; other products use
   `Fix` / `Enhance` / `Feature` / `Dev`). One sentence, 10 to 15 words, the
   user-visible symptom, no file or class names.
2. **Commit** — match `git log --oneline -20`. One subject line, no body. Never
   `--no-verify`.
3. **PR** — fill the repo's template completely if there is one. Neither
   ColorMag nor ColorMag Pro has one today, so usually: a short title, a
   detailed what-and-why, numbered test steps a reviewer can follow without
   reading the diff, the linked issue, and the one-line changelog entry.

Put the PHPCS result in the PR body before a reviewer asks. On a split free/pro
product, say which repo the PR targets and whether a sync PR follows — and if
the sync is not actually wired up, say that instead of implying one is coming.

**Commit and push only when the developer asks.** Prepare the message, show it,
and wait.

## Step 9 — Report

```
Product     <name> <version> (<type>)
Repo        <which one, and why>
Ticket      <key or issue, or none>

Root cause  <file:line — the mechanism>
Fix         <files touched, one line each>
Callers     <n found, n changed>

PHPCS       clean (<n> files, <ruleset>) — or the violations
Verify      <VERIFIED | INCOMPLETE | REGRESSION | CANNOT VERIFY>
Spec        <path>, proof gate <result> — or why none

Changelog   <the one-line entry>
Commit      <the subject line, not yet committed>

Not done
  <anything left, and why>
```

## Rules

- **The standards skill governs.** Where this file and it disagree, it wins.
- **Never weaken a check to make it pass** — not an assertion, not a sniff, not
  a capability check.
- **Never apply the same change to both repos** of a split product.
- **Never claim a fix is verified when it is not.** "It should work" is not a
  verdict.
- If the root cause turns out to be in a different product — the free theme
  rather than the pro one, a shared SDK rather than either — stop and say so.
  Fixing it in the wrong place is worse than not fixing it.
