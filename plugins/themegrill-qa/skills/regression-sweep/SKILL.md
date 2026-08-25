---
name: regression-sweep
description: Exploratory regression pass over a released product version, filing verified bugs to Jira
argument-hint: "<product-slug> [version] [--file-tickets]"
allowed-tools: Bash, Read, Grep, Glob, mcp__playwright__*, mcp__atlassian__*
pass-arguments: true
---

# Scheduled regression sweep

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

You are doing an exploratory QA pass over a **released** version of a WordPress
product, looking for defects nobody has written a test for. This runs on a
schedule or manually after a release, unattended.

`$1` is the product slug. `$2` is an optional version (default: latest released).
Ticket filing is **off unless `--file-tickets` is present in `$ARGUMENTS`.**

## The default is a report, not tickets

Read this before doing anything else.

Without `--file-tickets` you produce a report artifact and file nothing. This is
the correct default and should stay the default until the team has read several
reports and agrees the findings are real. An AI QA agent that floods Jira with
false positives in week one is dead on arrival — the team learns to ignore it,
and no later improvement in accuracy brings that trust back. Earn the ticket
permission; do not assume it.

## Step 1 — Set up

```bash
node "$QA/scripts/detect-product.mjs"
```

Read the product knowledge file. It defines the critical flows, the admin
surfaces, the integration points and — importantly — the **known-fragile areas**
and **known non-issues**. Respect the non-issues list: re-reporting a known
intentional behaviour is the most common false positive.

Boot the site on the released version, not the working tree:

```bash
node "$QA/scripts/boot-wp.mjs" --engine playground --wp "${WP_VERSION:-latest}" --php "${PHP_VERSION:-8.3}"
```

Sweeps are the right place to vary the matrix. If the workflow passed a
WP/PHP combination, use it and name it in the report — "works on PHP 8.3, fatals
on 8.1" is exactly the kind of finding this job exists to catch.

## Step 1b — If ingested docs are present, they are your specification

Check for `.themegrill-qa/docs/<your-area>.md`. If it exists, read it before exploring.
It carries the product's own documentation for your area, including a **Stated
outcomes** block — sentences where the docs promise a specific result.

Use it two ways:

1. **As assertions.** Each stated outcome is a claim you can check directly, in
   the product owner's own words, which removes most of the guesswork about
   whether what you are looking at is correct.
2. **As a coverage checklist.** The docs enumerate the flows and controls a
   customer is told exist. Working through them is a far better use of a sweep
   than wandering the admin UI hoping to find something.

Also record **doc drift**: where the docs describe a control, label or outcome
the product does not deliver. That is a finding whichever way round it is — a
stale doc customers are reading, or a feature that regressed. Report it as
`DOC DRIFT: <doc url> says X, product does Y` and let a human decide which side
is wrong. Do not guess, and do not silently follow whichever one seems more
plausible.

Docs cover the happy path only. They tell you what should work; the attack
patterns below are still how you find what breaks.

## Step 2 — Explore with missions, not vibes

Do not wander. Work through the product knowledge file's critical flows and,
for each, run the flow correctly once and then attack it. Attack patterns worth
running every sweep:

- **State**: save, reload, save again, navigate away mid-edit, use two tabs,
  double-submit, hit back after submit
- **Boundaries**: empty, whitespace-only, 10k characters, unicode, emoji, RTL
  text, `<script>`, SQL-ish strings, negative and zero numbers
- **Roles**: run every admin flow as editor, author, subscriber and logged out.
  Anything reachable that should not be is a finding
- **Viewports**: 375 / 768 / 1440 for every user-facing surface
- **Fresh vs upgraded**: a brand-new activation behaves differently from one
  upgraded from the previous version with existing settings and content
- **Deactivate/reactivate** and, for themes, **switch away and back** — settings
  loss here is a classic and users notice immediately
- **Integrations** named in the knowledge file: activate WooCommerce/Elementor
  and re-run the surfaces that touch them

For themes specifically, capture screenshots of every template type (home,
archive, single, page, search, 404) at all three viewports and compare against
the previous release's screenshots if a baseline exists in the artifact store.
Layout regressions are the dominant bug class for ColorMag and Zakra and no
amount of clicking will find them — only comparison will.

## Step 3 — The verification gate

**Nothing becomes a finding until it passes all five.** This gate is the whole
value of the job; without it you are a random-noise generator.

1. **Reproduced twice**, from a clean site state, with the exact same steps.
2. **Steps written down** precisely enough that a human can follow them without
   you.
3. **Expected behaviour justified** — cite the product's own docs, settings
   description, or established WordPress convention. "I think it should do X" is
   not justification. If you cannot say *why* it is wrong, it is not a finding.
4. **Not a known non-issue** per the product knowledge file.
5. **Not already known** — check the findings ledger *first*, then Jira.

   The ledger is `.themegrill-qa/findings/<product>-<year>.jsonl`, one JSON
   object per line. Compute the fingerprint — a short stable hash of
   `product + area + surface + normalised symptom` — and look it up:

   - **absent** → a new finding. Report it, and append a line.
   - **present, `status: fixed`** → a **regression**, which is more serious than
     a new bug. Say so explicitly, and name the spec that was supposed to be
     guarding it so someone can work out why it did not.
   - **present, `status: known` or `wontfix`** → say nothing at all. This is the
     machine-checkable half of the handbook's known-non-issues list.

   Then still check Jira for open and recently closed issues, since a human may
   have filed something the ledger has not seen. A closed "won't fix" is an
   answer, not an invitation.

   Append, never rewrite: several shards run in parallel, and one object per line
   means appends do not conflict.

Anything that fails the gate goes in a separate **"Suspicious, unverified"**
section of the report. That section is useful. Do not delete it — just never file
it as a ticket.

## Step 4 — Report, and file only if permitted

Always write the full report to `sweep-report.md` for upload as an artifact:

```markdown
# Regression sweep — <Product> <version>
Env: WP <ver> · PHP <ver> · <engine> · <date>
Flows exercised: <n>  ·  Verified findings: <n>  ·  Unverified: <n>

## Verified findings
### F1 — <one-line title>
Severity: Blocker | Major | Minor | Trivial
Surface: <admin page / template / block>
Steps:
  1. ...
Expected: ...
Actual: ...
Why this is wrong: <citation>
Evidence: <screenshots, console, network>
Jira: <key, or "not filed — report-only run">

## Suspicious, unverified
### S1 — <title>  (why it did not pass the gate)

## Coverage
Exercised: <list>
Not exercised: <list, with reason>
```

**If and only if `--file-tickets` was passed**, create a Jira issue per verified
finding via the Atlassian MCP:

- Summary: `[<Product>] <specific symptom>` — describe the symptom, not your
  diagnosis. "Header menu items overlap logo below 480px", not "flex-wrap bug".
- Include the full reproduction, expected/actual, environment, and evidence.
- Label `automated-qa` and `needs-triage`, and set priority from severity.
- **File into the triage state your project uses, never straight to a sprint or
  backlog-ready.** A human triages.
- Link to the sweep's workflow run.
- Cap it: **maximum 5 tickets per sweep.** If you verified more than five, file
  the five most severe and list the rest in the report. A 30-ticket dump gets the
  whole pipeline switched off.

## Rules

- Severity is about user impact, not how interesting the bug is. Data loss and
  fatals are Blockers. A 2px misalignment is Trivial and probably should not be
  a ticket at all.
- Never file a duplicate. When unsure whether something is a duplicate, comment
  on the existing issue instead of opening a new one.
- Never file a feature request as a bug.
- If you find a security issue — privilege escalation, unauthenticated write,
  stored XSS — **do not open a public ticket and do not include working payloads
  in the report.** Write `SECURITY FINDING — see workflow log` in the report and
  stop the sweep. A human handles disclosure.
- Report your own reliability honestly: if Playwright was flaky and you are
  unsure whether a failure was the product or the harness, say so.
