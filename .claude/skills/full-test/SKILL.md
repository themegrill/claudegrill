---
name: full-test
description: Run a whole-product regression pass on demand, fanned out across CI
argument-hint: "[version or tag] [--tickets] [--local]"
allowed-tools: Bash, Read, Grep, Glob, mcp__playwright__*
pass-arguments: true
---

# Full product test, on demand

Whole-product coverage, triggered by a human when a product actually ships —
rather than on a cron that spends money on weeks when nothing changed.

By default this **triggers the CI workflow and reports back**, because the work
fans out across parallel shards there. Running all areas sequentially in one
local session is slower, costs the same or more, and exhausts context. Only use
`--local` for a single product you are actively debugging.

`$1` is an optional version, tag or branch (default: the current checkout).
`--tickets` files verified findings to Jira. `--local` runs here instead of CI.

## Step 1 — Identify and confirm scope

```bash
scripts/detect-product.sh
```

Read the product's knowledge file and pull out its **critical flows** — that list
is the area list, and each area becomes one CI shard. Print the areas you are
about to sweep and the shard count before spending anything, because the area
count is the direct multiplier on cost:

```
Product:  colormag 4.0.1 (theme)
Version:  v4.0.1
Areas:    9  →  18 shards across 2 env combos
Est cost: ~$47 worst case
Tickets:  disabled
```

If the knowledge file has no critical-flows list, stop and say so. Sweeping a
product with no defined areas produces a shallow pass over everything, which is
the failure mode this whole structure exists to avoid.

## Step 2 — Dispatch to CI

```bash
gh workflow run sweep.yml \
  --repo "<org>/<product>" \
  -f version="<tag>" \
  -f depth=full \
  -f file_tickets=<true|false>
```

Then follow it:

```bash gh run watch "$(gh run list --workflow=sweep.yml --limit=1 --json databaseId -q '.[0].databaseId')" ```

While it runs, say nothing further. When it finishes, fetch the combined report
and summarise:

```bash
gh run download <run-id> --name "sweep-report-<slug>"
```

Report: verdict per area, the ranked findings, coverage gaps, and which shards
failed to report at all — a shard that died before writing is a hole in coverage,
not a pass, and must be called out as such.

## Step 3 — If `--local`

Boot once and work the areas in sequence, but keep discipline:

```bash
scripts/boot-wp.sh --engine playground
```

- Announce the area list and work through it in order, one at a time.
- Write findings into `sweep-report.md` **as you go**, not at the end. A local
  run that gets interrupted at area seven should still have six areas of results
  on disk.
- Reset site state between areas (`--reset`) so a mess made in one area does not
  produce phantom findings in the next.
- Track your own budget. Stop and report honestly at roughly 40 tool calls per
  area rather than pursuing one interesting thread to exhaustion — the point of
  a full test is even coverage, not depth in one spot.

## Step 4 — Verification gate applies unchanged

Everything from the `regression-sweep` skill's gate applies here: reproduced
twice, steps written down, expected behaviour justified by citation, not a known
non-issue, not already in Jira. Maximum five tickets for the whole run, filed to
triage, only with `--tickets`.

## Rules

- **Never dispatch without printing the estimated cost first.** A command that
  can spend $50 should say so before it does.
- Do not fan out more than the workflow's `max_shards` cap. If the area list
  exceeds it, say which areas are being dropped rather than silently truncating.
- A full test is for releases and release candidates. If someone runs this on
  every commit, point them at `/verify-fix` instead.
