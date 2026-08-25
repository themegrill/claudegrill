# Setup

Onboarding runbook for `themegrill-qa`. Follow it in order — each phase assumes
the one before it works, and each ends with a check you can actually verify.

Do not skip to Phase 3. The whole point of this order is that you find out
cheaply whether the idea works before you wire it into CI for seven products.

**Total time to Phase 2 complete: about half a day, most of it Step 2.3.**

---

## Before you start

Decisions to make now, because they are annoying to change later.

| Decision | Recommendation | Why |
|---|---|---|
| Repo name | `ThemeGrill/themegrill-qa` | Referenced from every product's caller workflow |
| Ref pinning | `@main` at first, tags later | Fast fixes now; deliberate upgrades once stable |
| First product | ColorMag or Zakra | A theme is simpler than URM, and you already run this loop on both by hand |
| Knowledge file location | in each product, `.themegrill-qa/knowledge.md` | Stops drift — see 2.3 |
| Model | Sonnet | Move to Opus only when you can point at a review Sonnet got wrong |

Prerequisites: Node 20+, Docker (only if you want the `wp-env` engine), the `gh`
CLI authenticated, Claude Code, and an Anthropic API key.

---

## Phase 0 — Create the shared repo · once, ~15 min

### 0.1 Push this repo

```bash
cd themegrill-qa
git init -b main
git add -A
git commit -m "Initial QA platform scaffold"
gh repo create ThemeGrill/themegrill-qa --private --source=. --push
```

### 0.2 Fix the placeholder org references

Three files name the repo. If you used a different org or name, update them:

```bash
grep -rn "ThemeGrill/themegrill-qa" .github/workflows/
```

### 0.3 Organisation secrets

Set these at the **organisation** level so all seven product repos inherit them,
rather than pasting them into each repo.

| Secret | Needed for | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | everything | from the Claude Console |
| `ATLASSIAN_ROVO_TOKEN` | Jira filing only | see 0.4 — add it later, not now |

```bash
gh secret set ANTHROPIC_API_KEY --org ThemeGrill --visibility all
```

### 0.4 Jira, deliberately deferred

The Atlassian MCP defaults to OAuth, which needs an interactive browser and
therefore cannot work in CI. The API-token path works but may need an Atlassian
admin to enable it for your org first.

Do not start this thread yet. Ticket filing is off by default and stays off until
Phase 5. Raise the admin request now if approvals are slow where you work, but
nothing before Phase 5 depends on it.

> **Done when:** the repo exists and `gh secret list --org ThemeGrill` shows the
> API key.

---

## Phase 1 — Local install · ~5 min, and mostly for one person

**Most developers install nothing.** The PR reviewer runs in GitHub Actions, so
the whole team gets QA on their pull requests without touching their machines. A
local install is only for `/verify-fix` — checking a fix before pushing — which
matters to whoever fixes bugs, not to everyone.

For this phase, install it for yourself with a clone, because you will be editing
the tooling as you go:

```bash
git clone git@github.com:ThemeGrill/themegrill-qa.git
cd themegrill-qa
node install.mjs
```

Then open a new terminal.

Once the tooling settles, roll it out as a plugin instead — an organisation owner
enables it once in managed settings and every developer has the commands with no
setup at all. [INSTALL.md](INSTALL.md) covers all three routes and the trade-offs.

> **Done when:** open Claude Code in any product repo, type `/`, and see
> `verify-fix` in the list.

---

## Phase 2 — First product, locally · ~half a day

This is the phase that tells you whether the whole idea is worth pursuing. No
CI, no cost risk beyond a few local runs.

### 2.1 Boot a site

In your ColorMag checkout:

```bash
node "$THEMEGRILL_QA_HOME/plugins/themegrill-qa/scripts/boot-wp.mjs" --engine playground
```

This is the **first thing to run and the most likely thing to break**, because it
was never executed end to end against a live network — the environment it was
built in blocks `wordpress.org` and `playground.wordpress.net`. Expect to fix
something in the blueprint here.

If it fails with an opaque JSON parse error, that is blocked egress, not bad
config; the script prints a hint saying so.

> **Done when:** the script prints a URL, you open it, and ColorMag is active
> with sample posts, a menu and categories.

### 2.2 Ingest the docs

```bash
node $THEMEGRILL_QA_HOME/plugins/themegrill-qa/scripts/ingest-docs.mjs \
  https://docs.themegrill.com/colormag/sitemap.xml --out .themegrill-qa
```

Check the sitemap URL first — `docs.themegrill.com` is a hub and some products
live on their own domains.

Then read `.themegrill-qa/docs-index.json` and sanity-check two things:

- **article counts per section** look right against the live site
- **nothing is listed under `thin`**. Thin usually means a JS-rendered page the
  parser could not read. Open one and check before trusting the counts.

> **Done when:** `.themegrill-qa/docs/*.md` exists and the "Stated outcomes"
> block in one section file reads like assertions you would actually test.

### 2.3 Knowledge file — the hour that decides output quality

```bash
claude
> /knowledge-init
```

This drafts `.themegrill-qa/knowledge.md` from source, docs and git history. It
will leave `TODO` markers on everything it could not derive.

**Now do the part no tool can do.** Sit with whoever knows ColorMag best and fill
in four things:

1. **Critical-flow ordering** — the draft proposes a list from the surfaces it
   found. Reorder it by what would hurt most if it broke.
2. **Expected behaviour** where the docs were silent.
3. **Known non-issues** — behaviour that looks wrong and is deliberate. Start it
   even if you can only think of two.
4. **Upgrade paths** — which version transitions migrate settings, and what must
   survive.

This is the highest-leverage hour in the entire setup. Every later phase reads
this file. Commit it to the **product** repo, not here — so the PR that renames
an option fixes its description in the same commit.

> **Done when:** `.themegrill-qa/knowledge.md` is committed to the product repo
> and its critical-flows list is ordered by real blast radius.

### 2.4 Verify a fix you have already checked by hand

Pick a fix you personally validated recently. Check out its branch and:

```bash
claude
> /verify-fix
```

**Judge it against what you found manually.** This is the actual evaluation:

- Did it reproduce the bug on the old code before confirming the fix? (If it
  skipped that, the verdict is worth much less.)
- Did its blast-radius list match what you worried about?
- Was its "Not checked" section honest?

Run it on two or three more. If it disagrees with you, work out which of you is
right — that answer belongs in the knowledge file either way.

> **Done when:** you have run it on 3+ known fixes and trust its verdicts. If you
> do not, stop here and fix the knowledge file rather than proceeding to CI.

---

## Phase 3 — PR runner on one product · ~1 day, then watch a week

### 3.1 Add the caller

In the ColorMag repo, `.github/workflows/qa.yml`:

```yaml
name: QA
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
    paths-ignore: ['**.md', 'languages/**', '.github/**']
jobs:
  qa:
    uses: ThemeGrill/themegrill-qa/.github/workflows/pr-qa.yml@main
    with:
      product_slug: colormag
      product_type: theme
    secrets:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

### 3.2 Test on a deliberately broken PR

Open a PR that breaks something you know about — a fatal, a missing capability
check, a layout that collapses on mobile. Confirm it is caught.

Then open a trivial PR (a typo in a comment) and confirm the triage step **skips
it entirely**. If trivial PRs are burning browser runs, fix the path filters
before going further.

### 3.3 Watch for a week, then count

Track every comment as useful / noise / wrong. Two weeks of real PRs is enough
to know. If noise is above roughly a third, the fix is almost always the
knowledge file's known-non-issues list, not the prompt.

> **Done when:** a dozen real PRs have been reviewed and you would be annoyed if
> someone turned it off.

---

## Phase 4 — First full test · when ColorMag next ships

```bash
claude
> /full-test v4.0.2
```

It prints the shard count and estimated cost **before** dispatching. Check the
area list matches your doc sections, then let it run.

Set `areas_json` in the sweep caller from `docs-index.json`'s `suggested_areas`.
Areas × env combos = shards, and shards are what you pay for, so keep the list
honest.

Read the report. Expect the first one to be noisy — that is what the report-only
default is for.

> **Done when:** you have read two full-test reports and the findings are real.

---

## Phase 5 — Turn on Jira · only after Phase 4

Now do the Atlassian work from 0.4, add `ATLASSIAN_ROVO_TOKEN`, and run one
sweep with the `file_tickets` box ticked.

Check the tickets that land: they should be in your triage state, labelled
`automated-qa` and `needs-triage`, capped at five, none duplicating an existing
issue.

Scheduled runs can never file tickets — only a human pressing the button can.
Keep it that way.

> **Done when:** five or fewer good tickets landed in triage and your team did
> not resent receiving them.

---

## Phase 6 — Remaining products · ~2 hours each

Per product: caller workflows (5 min), docs ingest (10 min), `/knowledge-init`
plus the human hour, `areas_json` from the doc sections.

Themes are cheap — Zakra next. **Plugins cost more**: URM, Everest Forms and
Masteriyo need seeded state to be worth testing at all (forms, courses,
memberships, users in several roles), which means extending
`blueprints/plugin-test.json` per product. Budget a day each for those, mostly
blueprint work.

Onboard one at a time. Seven half-configured products is worse than two good ones.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `not valid JSON` on boot | blocked egress to `wordpress.org` | allowlist it, or `--engine wp-env` |
| Playground boots, product inactive | blueprint slug or entry-file mismatch | check `detect-product.mjs` output against the blueprint |
| `/verify-fix` can't find blueprints | `THEMEGRILL_QA_HOME` unset with a symlinked install | export it |
| Agent hunts for a control that isn't there | stale docs | that's a **doc drift finding** — file it, don't suppress it |
| Nine bot comments on one PR | comment marker not matching | check `<!-- themegrill-qa-bot -->` is preserved |
| SQL / mail / cron behaving oddly | Playground is SQLite, no cron, no mail | `--engine wp-env` for those diffs |
| Jira MCP hangs in CI | OAuth, not API token | `ATLASSIAN_API_TOKEN` via the Rovo scoped token |

---

## Checklists

**Day one**

- [ ] Repo pushed, org references updated
- [ ] `ANTHROPIC_API_KEY` set at org level
- [ ] Skills symlinked, `THEMEGRILL_QA_HOME` exported
- [ ] `boot-wp.mjs` produces a working site
- [ ] Docs ingested for the first product

**Before any CI**

- [ ] Knowledge file committed, four human sections filled in
- [ ] `/verify-fix` agreed with you on 3+ known fixes

**Before onboarding product two**

- [ ] Product one reviewed a dozen real PRs
- [ ] Trivial PRs are being skipped
- [ ] Noise rate acceptable
- [ ] One full-test report read

**Before enabling tickets**

- [ ] Two full-test reports read, findings real
- [ ] Rovo API-token auth working
- [ ] Triage state agreed with whoever owns the Jira project
