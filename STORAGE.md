# Where everything is stored

Short answer: **all of it is in git, in the product's own repository.** No
database, no vector store, no external service, no hosting to pay for or back up.

That is a deliberate choice, not a shortcut. Everything the system learns is
reviewable in a pull request, diffable so you can see what changed and when,
versioned alongside the code it describes, and readable by an agent without any
integration work. A database would need hosting, credentials in CI, and backups,
and would give us nothing we do not already get from git.

---

## The five things that get stored

People say "the knowledge base" to mean at least three different things, which is
where the confusion comes from. They are separate artifacts with separate
lifecycles.

| # | What | Path | Committed? | Written by |
|---|---|---|---|---|
| 1 | Product handbook | `.themegrill-qa/knowledge.md` | yes | `/knowledge-init` then a human |
| 2 | Ingested docs | `.themegrill-qa/docs/*.md` + `docs-index.json` | yes | `ingest-docs.mjs` |
| 3 | Docs fetch cache | `.themegrill-qa/.docs-cache/` | **no** — gitignored | `ingest-docs.mjs` |
| 4 | Specs and snapshots | `tests/e2e/**` | yes | agent, via PR |
| 5 | Findings ledger | `.themegrill-qa/findings/` | yes | agent, via PR |

All five live in the **product** repository — ColorMag's handbook is in the
ColorMag repo. The shared `themegrill-qa` repo holds only the machinery: the
skills, the scripts, the workflows, the shared helpers. It holds no product
knowledge at all once a product is onboarded.

---

## 1. The product handbook

`.themegrill-qa/knowledge.md`

Prose and tables: what the product is, its critical flows in priority order,
where settings live, the roles table, integration points, upgrade paths, the
areas that historically break, and the known non-issues.

**Why it lives with the product's code:** when a developer renames a setting,
they update the sentence describing it in the same commit, and a reviewer sees
both changes together. A handbook in a different repository goes stale silently,
and a stale handbook produces confidently wrong QA — worse than no handbook.

This file is small, hand-maintained, and permanent. It is the asset.

## 2. The ingested documentation

`.themegrill-qa/docs/<section>.md`, `.themegrill-qa/docs-index.json`

Generated from the public docs site by `ingest-docs.mjs`. Contains each doc
section's text plus a **Stated outcomes** block — the sentences where the docs
promise a specific result, which are the assertions the agent checks against.

**Committed, deliberately**, for three reasons. CI does not need network access
to the docs site at test time. Runs are reproducible — a test result can be
traced to the exact doc text that defined "correct". And the diff is itself a
signal: when the docs change for an area, that area's behaviour probably changed
too, and reviewing that diff is worthwhile.

Regenerate when a product ships. A version's docs are part of its release.

## 3. The fetch cache

`.themegrill-qa/.docs-cache/` — gitignored. Local scratch so re-running the
ingest is free and a partial run can resume. Delete it freely.

## 4. Specs and visual snapshots

`tests/e2e/*.spec.js` and `tests/e2e/*.spec.js-snapshots/`

The permanent automatic checks. Playwright's own conventions, in the product
repo, so a spec and the code it guards move together and a revert takes both.

Snapshots are committed too — they are the visual baseline. Two standing rules:
never update snapshots in the same commit as a behaviour change, because the diff
is the only evidence of what changed; and review snapshot diffs rather than
accepting them, because `--update-snapshots` makes rubber-stamping a regression
exactly as easy as accepting an intended restyle.

## 5. The findings ledger

`.themegrill-qa/findings/<product>-<year>.jsonl`

One line per confirmed finding, ever. This is what lets the system answer "have
we seen this before" without a database, and it is what stops the sweep filing
the same ticket every month.

```json
{"fingerprint":"a3f19c2e","first_seen":"2026-08-24","area":"customizer",
 "surface":"header layout control","symptom":"selected layout not applied on archive templates",
 "severity":"major","jira":"CM-1481","spec":"tests/e2e/customizer.spec.js:88",
 "status":"fixed","versions_affected":["4.0.1"]}
```

The **fingerprint** is a short stable hash of `product + area + surface +
normalised symptom`. Before reporting anything, the agent computes the
fingerprint and checks the ledger. Three outcomes:

- **Not present** → new finding, report it, append a line.
- **Present, status `fixed`** → a regression. Report it as such, which is more
  serious than a new bug, and note that a spec was supposed to be guarding it.
- **Present, status `wontfix` or `known`** → say nothing. This is the same job as
  the handbook's known-non-issues list, kept machine-checkable.

`jsonl` — one JSON object per line — because appending never causes a merge
conflict, which matters when several sweeps run in parallel shards.

---

## What the suite layer added

Three more files, all in the **product repo**:

| File | Committed? | Why |
|---|---|---|
| `.themegrill-qa/suite.json` | yes | The manifest. A product opts in by adding it; absent, everything degrades to the pre-suite behaviour |
| `.themegrill-qa/spec-queue.jsonl` | **yes** | Source changed with no spec yet. Committed on purpose — the queue being visible in the repo is what makes it get drained |
| `.themegrill-qa/.env.local` | **never** | Base URL and admin credentials for the developer's own site. Gitignored. Add the ignore rule *before* writing the file |

The specs themselves live where they always did, in `tests/e2e/**`, and are the
only layer that turns a finding into something that runs for free forever.

## What is *not* stored, and why

**No vector database.** Retrieval here is not fuzzy. A diff gives file paths; a
sweep shard gives an area name; both map to a doc section or a handbook heading
by exact match. Structured lookup by path and section is more precise than
embedding similarity for those queries, and needs no infrastructure. The place
semantic search would genuinely help is matching a customer's support ticket to a
product area — and that is a different team's work.

**No run-history database.** Full transcripts, screenshots and recordings are
attached to each CI run as artifacts — 14 days for code reviews, 90 days for
pre-release sweeps. Long enough to investigate a result, and nothing worth
keeping forever is only in there: what matters gets distilled into the ledger,
the handbook or a spec.

**No dashboard, and no metrics store.** GitHub and Jira already hold the state
the team looks at.

---

## The context-size question

The natural worry is that a large product's knowledge will not fit in one agent
run — User Registration's docs alone are 19 sections and about 200 articles.

Sharding solves this, not retrieval. A sweep runs one shard per area, and a shard
reads only its own area's doc section plus the handbook, which is a page. A code
review reads only the sections the diff touches. Nothing ever needs the whole
corpus at once, which is why the flat-file approach holds at this size.

If a single area ever outgrows a run, split the area before reaching for a
retrieval system.

---

## Retention summary

| Artifact | Lives for | Where |
|---|---|---|
| Handbook, docs, specs, snapshots, ledger | forever | git |
| Screenshots, recordings, transcripts (code review) | 14 days | CI artifacts |
| Screenshots, recordings, reports (pre-release sweep) | 90 days | CI artifacts |
| Docs fetch cache | until deleted | local only |
| Tickets | your Jira retention | Jira |

Ninety days on sweep artifacts is chosen so a release can be compared against the
one before it. Everything with lasting value ends up in git.

---

## Status

The storage locations above are decided and correct. **The automation that fills
items 4 and 5 is not built yet** — it is task 6 in `CLAUDE.md`. Today a confirmed
finding becomes a spec because a human writes one, or asks Claude Code to. The
paths, formats and rules exist so that when the loop is automated it writes to
the right places, and so that anything done by hand in the meantime is not thrown
away.
