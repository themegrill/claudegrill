# themegrill-qa

> **Start here:** [SETUP.md](SETUP.md) is the ordered onboarding runbook.
> [CONVENTIONS.md](CONVENTIONS.md) governs every spec written against this.
> [STORAGE.md](STORAGE.md) says where every artifact is kept.
> [SETUP-COLORMAG.md](SETUP-COLORMAG.md) is the concrete first-product walkthrough.
> [INSTALL.md](INSTALL.md) says who needs a local install (fewer people than you think).
> [CLAUDE.md](CLAUDE.md) orients Claude Code — invariants, build state, next tasks.
> [COSTS.md](COSTS.md) is the spend model.


The QA loop you already run by hand in Claude Code — diff, boot WordPress,
validate with Playwright, assess risk, report — packaged into three entry points
so it runs without you.

| # | Entry point | Trigger | Output |
|---|---|---|---|
| 1 | `/verify-fix` | You, locally, in Claude Code | A verdict in your terminal |
| 2 | PR QA runner | Automatically on every PR | One comment on the PR |
| 3 | Regression sweep | Weekly cron, or manual after a release | A report artifact, and Jira tickets only when asked |

One shared repo, seven products. Each product repo gets a ~15-line caller
workflow and a knowledge file; everything else lives here.

---

## Layout

```
themegrill-qa/                     ← this repo is also the plugin marketplace
├── .claude-plugin/marketplace.json
├── plugins/themegrill-qa/         ← the installable plugin
│   ├── skills/                    the five commands
│   ├── scripts/                   Node helpers, zero dependencies
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

**No visual baseline yet.** The sweep captures screenshots and stores them for
90 days, but nothing diffs them against the previous release automatically. For
ColorMag and Zakra that is the highest-value missing piece — layout regressions
are the dominant bug class for themes and clicking around will not find them.
Adding a baseline comparison step is the first extension I would build.

**No pro/licensed testing.** Nothing here activates a licensed pro build. You
need a mock license server before any pro code path can be covered in CI, and
that gates a meaningful share of your actual customer-facing surface.

**The agent can be wrong.** It reproduces twice and cites evidence, which
filters most noise, but it will still occasionally report a non-issue with
conviction. That is what the "Known non-issues" section of each knowledge file
is for. Feed it back.

---

## What has and has not been tested

Honest accounting, so you know where to look first when something breaks.

**Verified working:**

- `detect-product.mjs` against a theme (`style.css` header), a plugin (PHP header),
  invocation from a subdirectory, Jira-key extraction from a branch name, pro
  companion detection, and a clean failure on a non-WordPress directory.
- All YAML parses; all JSON parses; both scripts pass `bash -n`.
- Playground CLI flags confirmed against `wp-playground start --help`.
- Playground correctly auto-detects a theme directory and mounts it at
  `/wordpress/wp-content/themes/<slug>`, and accepts the blueprint file.

**Not yet verified end to end:** a completed Playground boot. The environment
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
