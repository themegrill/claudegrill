---
name: regression-sweep
description: Exploratory regression pass over a released product version, filing verified bugs as GitHub issues
argument-hint: "<product-slug> [version] [--file-tickets]"
allowed-tools: Bash, Read, Grep, Glob, Skill, mcp__playwright__*
pass-arguments: true
---

# Scheduled regression sweep

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

You are doing an exploratory QA pass over a **released** version of a WordPress
product, looking for defects nobody has written a test for. This runs on a
schedule or manually after a release, unattended.

`$1` is the product slug. `$2` is an optional version (default: latest released).
Ticket filing is **off unless `--file-tickets` is present in `$ARGUMENTS`.**

## The default is a report, not tickets

Read this before doing anything else.

Without `--file-tickets` you produce a report artifact and file nothing. This is
the correct default and should stay the default until the team has read several
reports and agrees the findings are real. An AI QA agent that floods the issue
tracker with false positives in week one is dead on arrival — the team learns to ignore it,
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

## Step 1a — Run this shard's specs before exploring it

```bash
node "$QA/scripts/run-suite.mjs" --tier fresh --area "<this shard's area>" --base-url <the booted URL>
```

The specs for your area run in seconds and assert what somebody already proved
matters. Read the result before you drive anything:

- **Failures are your starting point**, not a distraction. A failing spec is a
  reproduction someone else already wrote down, with a file and a line.
- **Green specs mark ground you do not need to re-cover.** Explore around them,
  not over them.
- `fixme` entries name bugs already known and open. Do not re-report one.

If `suite` is `false`, or the area has no specs, carry on — that is precisely the
case this sweep exists for, and it is worth saying so in the report.

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

**Nothing becomes a finding until it passes all six.** This gate is the whole
value of the job; without it you are a random-noise generator.

1. **Reproduced twice**, from a clean site state, with the exact same steps.
2. **Steps written down** precisely enough that a human can follow them without
   you.
3. **Expected behaviour justified** — cite the product's own docs, settings
   description, or established WordPress convention. "I think it should do X" is
   not justification. If you cannot say *why* it is wrong, it is not a finding.
4. **Not a known non-issue** per the product knowledge file.
5. **Not already known** — check the findings ledger *first*, then GitHub.

   The ledger is `.themegrill-qa/findings/<product>-<year>.jsonl`, one JSON
   object per line. Compute the fingerprint — a short stable hash of
   `product + area + surface + normalised symptom` — and look it up:

   - **absent** → a new finding. Report it, and append a line.
   - **present, `status: fixed`** → a **regression**, which is more serious than
     a new bug. Say so explicitly, and name the spec that was supposed to be
     guarding it so someone can work out why it did not.
   - **present, `status: known` or `wontfix`** → say nothing at all. This is the
     machine-checkable half of the handbook's known-non-issues list.

   Then still check GitHub for open and recently closed issues, since a human
   may have filed something the ledger has not seen — and ThemeGrill has a
   second AI pipeline filing bug reports from support conversations, so the
   tracker sees findings this sweep never produced:

   ```bash
   node "$QA/scripts/file-issue.mjs" search --fingerprint <fp> --json
   node "$QA/scripts/file-issue.mjs" search --query "<symptom words>" --json
   ```

   The fingerprint search is exact — it matches the marker the filer writes into
   every issue body. The text search is the weak one, and it is the only thing
   that finds a human-filed issue, which is why both run. A closed "won't fix"
   is an answer, not an invitation.

   Append, never rewrite: several shards run in parallel, and one object per line
   means appends do not conflict.

6. **Not already guarded by a green spec.**

   ```bash
   node "$QA/scripts/suite-index.mjs" --pretty
   ```

   Look up the area and the behaviour in the `guards` map. If a spec guards this
   and that spec is **green**, then the deterministic check that exists precisely
   to catch this says it is not happening — and you saw it once, through a
   browser, with an agent's eyes. **Re-verify before reporting.** The overwhelmingly
   likely explanation is your own misreading: a stale page, a different site
   state, a control you drove differently than the spec does.

   Report it only if you can say *why the spec misses it* — a narrower viewport,
   a role the spec does not exercise, a path it does not walk. That sentence is
   the finding, and it is also the spec's next improvement.

   If a spec guards it and the spec is **failing**, you have independent
   confirmation rather than a contradiction. Say so; that is a strong finding.

Anything that fails the gate goes in a separate **"Suspicious, unverified"**
section of the report. That section is useful. Do not delete it — just never file
it as a ticket.

## Step 4 — Report, and file only if permitted

Always write the full report to `sweep-report.md` for upload as an artifact:

```markdown
# Regression sweep — <Product> <version>
Env: WP <ver> · PHP <ver> · <engine> · <date>
Flows exercised: <n>  ·  Verified findings: <n>  ·  Unverified: <n>
Suite: <n> passed, <n> failed (tier: <tier>) — or "no suite"
Areas already covered by specs (not swept): <list>

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
Issue: <owner/repo#N, or "not filed — report-only run">
Spec: <branch and path, or why none — e.g. "not mechanically observable">

## Suspicious, unverified
### S1 — <title>  (why it did not pass the gate)

## Coverage
Exercised: <list>
Not exercised: <list, with reason>
```

## Step 4b — Every verified finding becomes coverage

A ticket records a bug. A spec prevents it coming back. File the first, always
secure the second.

For each finding that cleared all six parts of the gate, invoke the `write-spec`
skill. Its proof gate applies unchanged — 3/3 against the fixed code, a real
assertion failure against the broken code — and a finding that cannot clear it is
reported as not mechanically observable rather than committed as a spec that
proves nothing.

**"Coverage" is not the same as "a new spec file."** `write-spec` identifies the
feature first and may legitimately answer `reused` (a scenario already guards this
behaviour, re-proved) or `updated` (the feature's existing scenario extended) —
see `CONVENTIONS.md` rule 11. On a sweep this is the *likely* answer, not the
exceptional one: a sweep revisits areas the suite already covers, so several
findings in one area often belong to one feature and sometimes to one scenario.
Two findings describing one user-visible behaviour get one scenario carrying both
keys, never one scenario each.

The sweep's output then carries **two** lists: the ticket list and a **coverage
list** — one branch per finding that needed a code change, and a line naming the
existing scenario for each one that did not.

**Maximum 5 spec PRs per sweep**, for the same reason as the ticket cap: a flood
of generated PRs is ignored, and an ignored PR queue defeats the point of
generating them. If you verified more than five, write specs for the five most
severe and list the rest in the report as unguarded. A `reused` outcome does not
count against the cap — it opens no PR.

**If and only if `--file-tickets` was passed**, file one **GitHub issue** per
verified finding. ThemeGrill tracks work in GitHub Issues; there is no Jira
path any more and no Atlassian tool in this skill's allow-list.

Issues go to the **product's own repository** by default — the bug, the fix, the
spec and the changelog entry then all live in one place, which is the same
reasoning that puts `knowledge.md` in the product repo. Confirm the target
before filing anything:

```bash
node "$QA/scripts/file-issue.mjs" repo
```

Write the body to a file rather than passing it as an argument, then file:

```bash
node "$QA/scripts/file-issue.mjs" create \
  --title "[<Product>] <specific symptom>" \
  --body-file /tmp/finding-1.md \
  --severity blocker|major|minor|trivial \
  --area <area> \
  --fingerprint <the ledger fingerprint> \
  --run-id "$GITHUB_RUN_ID" \
  --json --confirm
```

What the script does for you, so you do not have to remember it:

- **Refuses a duplicate.** `--fingerprint` writes a marker into the body and
  searches for it first; a second issue for a finding already filed exits 1 with
  `reason: "duplicate"` and the existing number. Comment on that one instead —
  `file-issue.mjs comment <n> --body-file F --confirm`.
- **Enforces the cap.** Every issue carries a `qa-run:<id>` label and `create`
  counts them before opening another, so **maximum 5 per sweep** is arithmetic
  rather than a promise. Past the cap it exits 1 with `reason: "cap_reached"`.
  When that happens, file the five most severe and list the rest in the report.
- **Creates the labels** it needs, because `gh issue create` fails outright on a
  label that does not exist — and it would fail at the end of a sweep that has
  already spent its whole budget.
- **Applies `automated-qa` and `needs-triage`**, plus `severity:*` and `area:*`.

What remains yours:

- The **title is the symptom, not your diagnosis**. "Header menu items overlap
  logo below 480px", not "flex-wrap bug".
- The **body carries the full reproduction, expected/actual, environment and
  evidence**, and a link to this sweep's workflow run.
- **Never assign, never set a milestone, never add it to a project board.**
  `needs-triage` is where it stops; a human decides scope and priority. This is
  the GitHub equivalent of "file into the triage state, never straight to a
  sprint", and it is invariant 4 — nothing here has write authority it does not
  need.

If `gh` is unauthenticated the script exits **2** and files nothing. That is a
broken harness, not a clean run: say so in the report rather than reporting zero
findings filed.

## Rules

- Severity is about user impact, not how interesting the bug is. Data loss and
  fatals are Blockers. A 2px misalignment is Trivial and probably should not be
  a ticket at all.
- Never file a duplicate. `--fingerprint` catches the ones this platform filed
  before; it cannot catch a human-worded issue about the same behaviour, so the
  text search still matters. When unsure, comment on the existing issue instead
  of opening a new one.
- Never file a feature request as a bug.
- If you find a security issue — privilege escalation, unauthenticated write,
  stored XSS — **do not open an issue and do not include working payloads in the
  report.** This matters more on GitHub than it did on Jira: most of these
  product repos are public, so a filed issue is a public disclosure with a
  reproduction attached. Write `SECURITY FINDING — see workflow log` in the report and
  stop the sweep. A human handles disclosure.
- Report your own reliability honestly: if Playwright was flaky and you are
  unsure whether a failure was the product or the harness, say so.
