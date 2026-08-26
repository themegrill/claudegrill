# themegrill-qa

> **Start here:** [SETUP.md](SETUP.md) is the ordered onboarding runbook.
> [SUITE.md](SUITE.md) is the contract between this platform and a product's suite.
> [CONVENTIONS.md](CONVENTIONS.md) governs every spec written against this.
> [INSTALL.md](INSTALL.md) is how the plugin reaches the team.
> [COSTS.md](COSTS.md) — short version: the PR path costs nothing.
> [SETUP-COLORMAG.md](SETUP-COLORMAG.md) is the pilot product's current state.
> [STORAGE.md](STORAGE.md) says where every artifact is kept.
> [CLAUDE.md](CLAUDE.md) orients Claude Code — invariants, build state, next tasks.


A Claude Code plugin, plus a free CI check.

The loop: a developer fixes a bug, verifies it locally with
`/themegrill-qa:verify-fix`, and a regression spec lands on their branch with the
fix. CI then runs that spec on every future PR — deterministically, with **no API
key and no per-run cost**.

The agent is used once, by the person who already understands the change. After
that the check is free forever.

| # | Entry point | Trigger | Output |
|---|---|---|---|
| 1 | `/themegrill-qa:verify-fix` | You, locally, on a fix | A verdict, and a spec on your branch |
| 2 | `/themegrill-qa:write-spec` | A verified finding, or the spec queue | A `@fresh` regression spec, proved against broken and fixed code |
| 3 | **QA suite** (CI) | Every PR, and nightly | A pass/fail check and one PR comment. **No API key** |
| 4 | `/themegrill-qa:regression-sweep` | Manual, on a release | A report; Jira tickets only when asked |

Skills are namespaced because they ship as a plugin: `/themegrill-qa:verify-fix`,
not `/verify-fix`.

---

## Three CI checks, split by what they cost

A product repo gets three thin workflows. The split is the point: the free one is
the gate, the expensive one is advisory.

| Check | Costs | Runs on | Required? |
|---|---|---|---|
| **QA suite** (`suite.yml`) | runner minutes only — **no `ANTHROPIC_API_KEY`** | every PR, drafts included | **yes** — make this the required check |
| **QA review** (`pr-qa.yml`) | tokens | non-draft PRs with functional changes | no, advisory |
| **QA command** (`pr-command.yml`) | tokens, except `suite` | a `@themegrill-qa` comment | no |

The agent review stays advisory deliberately. A required check that is
occasionally wrong for reasons nobody can reconstruct is a check people learn to
bypass — and then it gates nothing anyway.

### `@themegrill-qa` — re-run QA from a PR comment

| Comment | Effect |
|---|---|
| `@themegrill-qa` | Full re-review — suite plus agent |
| `@themegrill-qa suite` | Suite only. **No API key used, no agent, free.** |
| `@themegrill-qa verify <text>` | Focused agent run on `<text>` only, small budget |
| `@themegrill-qa specs` | Write regression specs for this PR's verified findings and open a spec PR |
| `@themegrill-qa areas <a,b>` | Agent run restricted to those areas |
| `@themegrill-qa help` | Post the table above |

Only repository owners, members and collaborators can trigger a run. That gate is
not optional: without it, anyone who can comment on a public PR can spend the
Anthropic budget in a loop.

---

## The suite layer — why cost goes down over time

An agent finding costs tokens on **every run, forever**. The same finding as a
committed spec costs tokens **once**, then runs for approximately free on every
PR for the life of the product.

So the platform runs a product's own Playwright suite first and cheaply, spends
agent budget only on the areas the suite does not cover, and converts every
verified finding into a committed spec. **[SUITE.md](SUITE.md)** is the contract:
a product opts in with `.themegrill-qa/suite.json`, and everything degrades
gracefully when that file is absent.

```
node plugins/themegrill-qa/scripts/suite-index.mjs   # what the suite covers, and does not
node plugins/themegrill-qa/scripts/run-suite.mjs     # run it; one line of JSON out
node plugins/themegrill-qa/scripts/estimate-cost.mjs --projection 24
```

That last command prints the declining curve, which is the entire argument for
this design.

One shared repo, seven products. Each product repo gets a ~15-line caller
workflow and a knowledge file; everything else lives here.

---

## Layout

```
themegrill-qa/                     ← this repo is also the plugin marketplace
├── .claude-plugin/marketplace.json
├── plugins/themegrill-qa/         ← the installable plugin
│   ├── skills/                    the six commands
│   ├── scripts/                   Node helpers, zero dependencies
│   ├── hooks/                     the spec-guard Stop hook
│   └── blueprints/                seeded WordPress for theme / plugin testing
├── packages/core/                 shared spec helpers
├── knowledge/                     starter knowledge files and the template
├── examples/                      a spec in the house style
└── .github/workflows/             reusable workflows + per-product callers
```

---

## Why it is shaped this way

**The deterministic parts are scripts; the judgement parts are skills.** Booting
WordPress, mounting the theme, detecting the slug, seeding content — all shell,
all reproducible, all free. The agent is only asked to do the things that
actually need reasoning: what does this diff mean, what should I try, is this
output wrong.

**Nothing has authority.** The PR runner comments; it does not approve or merge.
The sweep writes a report; it files tickets only when a human passes
`--file-tickets`. This is deliberate. An automated QA system earns write access
by being right for a few weeks first.

**Product knowledge is a committed file, not a prompt.** `knowledge/<slug>.md`
is where the agent learns what your product does, which flows matter, what is
fragile, and — critically — which apparent bugs are known non-issues. Every
false positive it reports should become a line in that file. That feedback loop
is the only thing that makes this get better over time instead of staying at
day-one accuracy forever.

---

## Setup

Three documents, depending on what you need:

- **[INSTALL.md](INSTALL.md)** — who needs a local install, and the three routes.
  Short answer: most developers need nothing; CI covers them.
- **[SETUP.md](SETUP.md)** — the ordered onboarding runbook for the platform.
- **[SETUP-COLORMAG.md](SETUP-COLORMAG.md)** — the concrete first-product
  walkthrough, with ColorMag's real values filled in.

Costs are modelled in **[COSTS.md](COSTS.md)**; run `npm run cost` to re-derive
them with your own assumptions.

---

## Known limits — read before trusting a green result

**Playground is not a real server.** It runs PHP-WASM with SQLite. Anything that
depends on MySQL-specific SQL, real cron, outbound mail, or genuine file
uploads will behave differently or not at all. `boot-wp.mjs --engine wp-env`
exists for exactly these cases and the skills are instructed to switch when the
diff touches them — but if you are relying on this for something in that list,
check which engine the run actually used.

**No visual baseline yet.** Nothing diffs screenshots against the previous
release automatically. Layout regressions are the dominant bug class for themes
and neither clicking around nor a DOM assertion finds them — only comparison
does. This is the highest-value missing piece for ColorMag and Zakra.

**No pro/licensed testing.** Nothing here activates a licensed pro build. You
need a mock license server before any pro code path can be covered in CI, and
that gates a meaningful share of your actual customer-facing surface.

**A green check covers only the areas that have specs.** This is the biggest one,
and it is not a bug — it is the trade the design makes. ColorMag has **10 of 16
areas with no `@fresh` specs at all**. Nothing automated visits them. Read the
coverage block in the PR comment alongside the tick, and treat
`suite-index.mjs`'s `areas_uncovered` as the backlog.

**A `@fresh` tag is a promise the spec has to keep.** A spec written against a
developer's Local site and tagged `@fresh` will fail on a clean CI site for
reasons that have nothing to do with the change. ColorMag currently passes 19/20
locally and 11/20 on Playground for exactly this reason. Verify the tag against a
clean site before trusting the tier.

**The agent can be wrong** — but it is no longer on the PR path, so a wrong
verdict costs one developer a few minutes rather than blocking a merge. It
reproduces twice and cites evidence, which filters most noise, but it will still
occasionally report a non-issue with conviction. That is what the "Known
non-issues" section of each knowledge file is for. Feed it back.

---

## What has and has not been tested

Honest accounting, so you know where to look first when something breaks.

**Verified working:**

- `detect-product.mjs` against a theme (`style.css` header), a plugin (PHP header),
  invocation from a subdirectory, Jira-key extraction from a branch name, pro
  companion detection, and a clean failure on a non-WordPress directory.
- All YAML parses; all JSON parses; every `.mjs` passes `node --check`.
- `run-suite.mjs` and `suite-index.mjs` against a real Playwright 1.62.1 fixture:
  tier and area filtering, all three exit codes, graceful degradation with no
  manifest and with a mangled spec, and a test count agreeing exactly with
  `playwright test --list`.
- `spec-guard.mjs` across six cases — silent in all but the one that matters.
- `estimate-cost.mjs` still reproduces its previous output to the cent.
- Playground CLI flags confirmed against `wp-playground start --help`.
- Playground correctly auto-detects a theme directory and mounts it at
  `/wordpress/wp-content/themes/<slug>`, and accepts the blueprint file.

**Not yet verified end to end:** a completed Playground boot; any CI run at all,
including the two new workflows; `run-suite.mjs` against a real product rather
than the fixture; and the `spec-guard` hook firing as an actual registered plugin
hook rather than being invoked by hand.

On the Playground boot: The environment
this was built in blocks egress to `wordpress.org` and
`playground.wordpress.net`, so the run got as far as mounting and blueprint
parsing and then failed fetching WordPress itself. Everything before the network
fetch is confirmed; the blueprint steps, the readiness poll, and the JSON handoff
are not.

**So the first thing to do is run `scripts/boot-wp.mjs` on your own machine**,
where those hosts are reachable, and fix whatever the blueprint gets wrong. Ten
minutes of that will surface more than any amount of further review. Also note
that GitHub-hosted runners can reach both hosts fine, but a self-hosted runner
behind a proxy will hit exactly the failure above — the script prints a hint
when it detects that signature.
