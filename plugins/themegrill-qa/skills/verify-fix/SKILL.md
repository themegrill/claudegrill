---
name: verify-fix
description: Boot a disposable WordPress and verify the current fix or feature with Playwright
argument-hint: "[optional: what to check, or a Jira key]"
allowed-tools: Bash, Read, Grep, Glob, mcp__playwright__*, mcp__atlassian__*
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

## Step 3 — Boot a site

```bash
node "$QA/scripts/boot-wp.mjs" --engine playground
```

Use `playground` by default: it boots in seconds and mounts the working tree
live, so you are testing the actual edited code.

Switch to `--engine wp-env` when the diff touches any of:

- raw SQL or `$wpdb` queries (Playground runs SQLite, not MySQL)
- `wp_mail` / notification sending
- WP-Cron scheduling
- multisite
- file upload / image processing paths that depend on real GD/Imagick

Say which engine you chose and why.

If the product has a pro companion and the diff touches licensed code, mount it
too: `--with <slug>-pro=../<slug>-pro`.

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

## Rules

- **Never edit source to make a test pass.** You are verifying, not fixing. If
  the fix is wrong, say the fix is wrong.
- **Never report a bug you have not reproduced twice.** One-shot anomalies in a
  browser-driving agent are usually the agent, not the product.
- Tear down the site when finished (kill the pid from `boot-wp.mjs`).
- If Playwright fails to drive the page three times in a row, stop and report
  the blocker. Do not keep retrying variations.
