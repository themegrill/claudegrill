# claudegrill

> **Start here:** [SETUP.md](SETUP.md) is the ordered onboarding runbook.
> [INSTALL.md](INSTALL.md) is how the plugin reaches the team.
> [SUITE.md](SUITE.md) is the contract between this platform and a product's suite.
> [CONVENTIONS.md](CONVENTIONS.md) governs every spec written against this.
> [PRO.md](PRO.md) covers the pro tier — licences, secrets, the pro CI jobs.
> [SETUP-COLORMAG.md](SETUP-COLORMAG.md) is the pilot product's current state.
> [STORAGE.md](STORAGE.md) says where every artifact is kept.
> [CLAUDE.md](CLAUDE.md) orients Claude Code — invariants, build state, next tasks.

A Claude Code plugin, plus a CI check that needs no API key.

Getting a product onto it is one command: **`/claudegrill:setup`**.

The loop: a developer fixes a bug, verifies it locally with
`/claudegrill:verify-fix`, and a regression spec lands on their branch
alongside the fix. CI then runs that spec on every future PR, deterministically.

| # | Entry point | Trigger | Output |
|---|---|---|---|
| 0 | `/claudegrill:setup` | Once per product | Everything below, configured and proved |
| 1 | `/claudegrill:write-fix` | You, on a bug or a feature | The change, to house standards, PHPCS-clean, verified |
| 2 | `/claudegrill:verify-fix` | You, locally, on a fix | A verdict, and a spec on your branch |
| 3 | `/claudegrill:write-spec` | A verified finding, or the spec queue | A `@fresh` spec, proved against broken and fixed code |
| 4 | **QA suite** (CI) | Every PR, and nightly | A pass/fail check and one PR comment |
| 5 | **QA suite — pro** (CI) | Every PR on a pro repo | The same, plus `@pro` and `@unlicensed` |
| 6 | `/claudegrill:regression-sweep` | Manual, on a release | A report; Jira tickets only when asked |

`wp-coding-standards` is the odd one out: a reference, not an entry point.
`write-fix` loads it before writing a line, and it governs every PHP change in
every ThemeGrill product.

Skills are namespaced because they ship as a plugin: `/claudegrill:verify-fix`,
not `/verify-fix`.

One shared repo, seven products. Each product repo gets a ~15-line caller
workflow, a `.themegrill-qa/` directory and a knowledge file; everything else
lives here.

---

## CI

A free product repo gets one workflow; a pro repo gets one more.

| Check | Runs on | API key | Required? |
|---|---|---|---|
| **QA suite** (`suite.yml`) | every PR, drafts included | no | **yes** — make this the required check |
| **QA suite — pro** (`pro-suite.yml`) | every PR on a pro repo | no | once green twice |
| **QA review** (`pr-qa.yml`) | unused by default | yes | no, advisory |
| **QA command** (`pr-command.yml`) | a `@claudegrill` comment | yes | no |

The agent tiers are off. The team removed AI from the PR path deliberately: the
developer runs the scoped suite locally, commits the spec on their own branch,
and CI runs the full `@fresh` tier with no key. `pr-qa.yml` and `pr-command.yml`
stay in the repo, unused, for a product whose suite is still too thin to trust.

The pro workflow runs three modes, and the third is the one nothing else can do:

| Mode | What it proves |
|---|---|
| `pro` | the `@pro` specs, against a licensed site |
| `free-with-pro` | the **free** specs with pro installed — "installing pro broke a free feature" |
| `unlicensed` | the `@unlicensed` specs — pro mounted, no licence. The state every customer passes through |

---

## Layout

```
claudegrill/                     ← this repo is also the plugin marketplace
├── .claude-plugin/marketplace.json
├── plugins/claudegrill/         ← the installable plugin
│   ├── skills/                    the entry points, plus the house PHP standard
│   ├── scripts/                   Node helpers, zero dependencies
│   ├── templates/                 CI workflows `setup` writes into a product
│   ├── mu-plugins/                QA-only, mounted into the test site, never shipped
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
WordPress, mounting the theme, detecting the slug, seeding content, installing
the licence probe — all plain Node, all reproducible. The agent is asked only to
do what needs reasoning: what does this diff mean, what should I try, is this
output wrong.

**Work moves down into the suite, and never back up.** Something the agent
discovered becomes a spec; something a spec proved becomes a line in the
knowledge file. Nothing that is already a spec goes back to being explored —
that is what `suite-index.mjs`'s `areas_uncovered` is for.

**Nothing has authority it does not need.** The PR runner comments; it does not
approve or merge. The sweep writes a report and files tickets only when a human
passes `--file-tickets`.

**Product knowledge is a committed file, not a prompt.**
`.themegrill-qa/knowledge.md` in the product repo is where the agent learns what
the product does, which flows matter, what is fragile, and which apparent bugs
are known non-issues. Every false positive should become a line in that file.

---

## Known limits — read before trusting a green result

**Playground is not a real server.** PHP-WASM with SQLite: no MySQL-specific SQL,
no real cron, no outbound mail, no genuine GD/Imagick uploads.
`boot-wp.mjs --engine wp-env` exists for those cases and the skills switch when
the diff touches them — but check which engine a run actually used.

**A green check covers only the areas that have specs.** This is the biggest one,
and it is the trade the design makes rather than a bug. ColorMag has **10 of 16
areas with no `@fresh` specs at all**. Read the coverage block in the PR comment
alongside the tick, and treat `suite-index.mjs`'s `areas_uncovered` as the
backlog.

**A `@fresh` tag is a promise the spec has to keep.** A spec written against a
developer's Local site and tagged `@fresh` will fail on a clean CI site for
reasons that have nothing to do with the change. ColorMag currently passes 19/20
locally and 11/20 on Playground for exactly this reason. Verify the tag against a
clean site before trusting the tier.

**No visual baseline yet.** Nothing diffs screenshots against the previous
release automatically. Layout regressions are the dominant bug class for themes,
and neither clicking around nor a DOM assertion finds them — only comparison
does. This is the highest-value missing piece for ColorMag and Zakra.

**The agent can be wrong** — but it is no longer on the PR path, so a wrong
verdict costs one developer a few minutes rather than blocking a merge. It
reproduces twice and cites evidence, which filters most noise, but it will still
occasionally report a non-issue with conviction. That is what the "Known
non-issues" section of each knowledge file is for. Feed it back.

**What is and is not proven** is tracked in [CLAUDE.md](CLAUDE.md) under *Build
state*, kept current there rather than duplicated here.
