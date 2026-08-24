# themegrill-qa

> **Start here:** [SETUP.md](SETUP.md) is the ordered onboarding runbook.
> [CONVENTIONS.md](CONVENTIONS.md) governs every spec written against this.
> [STORAGE.md](STORAGE.md) says where every artifact is kept.
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
themegrill-qa/
├── .claude/skills/
│   ├── verify-fix/SKILL.md        # entry point 1
│   ├── pr-qa-review/SKILL.md      # entry point 2
│   └── regression-sweep/SKILL.md  # entry point 3
├── scripts/
│   ├── detect-product.sh          # works out what product it is looking at
│   └── boot-wp.sh                 # Playground or wp-env, product mounted live
├── blueprints/                    # seeded WordPress for theme / plugin testing
├── knowledge/                     # per-product context — the important part
└── .github/workflows/
    ├── pr-qa.yml                  # reusable
    ├── regression-sweep.yml       # reusable
    └── examples/                  # copy these into each product repo
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

### 1. Create this repo

Push these files to `ThemeGrill/themegrill-qa` (or rename — then update the
`repository:` lines in both reusable workflows and in the example callers).

```bash
chmod +x scripts/*.sh
```

### 2. Secrets

At the **organization** level, so all seven repos inherit them:

| Secret | Needed for | How to get it |
|---|---|---|
| `ANTHROPIC_API_KEY` | Everything | [Claude Console](https://platform.claude.com) |
| `ATLASSIAN_ROVO_TOKEN` | Ticket filing only | Atlassian API token with Rovo MCP scope — needs an org admin to enable API-token auth for the Rovo MCP server |

The Atlassian MCP defaults to OAuth, which needs an interactive browser and
therefore cannot work in CI. The API-token path is the one to use; it is a
separate feature your Atlassian admin may need to turn on.

### 3. Per product repo

Copy `.github/workflows/examples/caller-pr-qa.yml` to
`.github/workflows/qa.yml`, change `product_slug` and `product_type`, and do the
same for the sweep. Then write `knowledge/<slug>.md` from `_TEMPLATE.md`.

### 4. Locally, for `/verify-fix`

```bash
export ATLASSIAN_API_TOKEN=...        # optional, for reading Jira tickets
claude
> /verify-fix
```

No arguments needed. It reads the product from `style.css` or the plugin header,
the change from `git diff`, and the ticket from the branch name — so a branch
called `fix/CM-1234-mobile-menu-overlap` gives it everything it needs.

---

## Rollout order

Do these in order. Each one is useful alone, and each de-risks the next.

1. **`/verify-fix` on ColorMag, locally.** Zero CI, zero cost risk. Run it on a
   fix you have already verified by hand and see whether it agrees with you.
   This is the cheapest possible test of whether the whole idea works.
2. **Fill in `knowledge/colormag.md`.** Every TODO you resolve makes every later
   step better. Budget an hour with whoever knows the theme best.
3. **PR runner on ColorMag only,** with the model set to Sonnet. Watch a dozen
   PRs. Count how many comments were useful versus noise.
4. **Sweep on ColorMag, report-only.** Read three reports. If the findings are
   real, turn on `--file-tickets` manually for one run and see what lands.
5. **Zakra, then the plugins.** URM, Everest Forms and Masteriyo need richer
   blueprints (users, roles, seeded forms/courses) — extend
   `blueprints/plugin-test.json` per product rather than sharing one.

Do not start at step 3.

---

## Cost control

This is the thing that quietly kills pipelines like this, so it is built in:

- **Path filters and a triage step** — docs, translations and CI-only changes
  skip the browser entirely.
- **Draft PRs are skipped.**
- **`concurrency: cancel-in-progress`** — pushing three commits to a PR pays for
  one review, not three.
- **Sonnet by default.** Move a specific workflow to Opus only if you can point
  at reviews Sonnet got wrong.
- **Chromium only**, not all three browser engines.
- **Sweeps are matrixed but capped** at two WP/PHP combinations; add more
  deliberately.

Watch the first week's spend before widening to all seven products.

---

## Known limits — read before trusting a green result

**Playground is not a real server.** It runs PHP-WASM with SQLite. Anything that
depends on MySQL-specific SQL, real cron, outbound mail, or genuine file
uploads will behave differently or not at all. `boot-wp.sh --engine wp-env`
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

- `detect-product.sh` against a theme (`style.css` header), a plugin (PHP header),
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

**So the first thing to do is run `scripts/boot-wp.sh` on your own machine**,
where those hosts are reachable, and fix whatever the blueprint gets wrong. Ten
minutes of that will surface more than any amount of further review. Also note
that GitHub-hosted runners can reach both hosts fine, but a self-hosted runner
behind a proxy will hit exactly the failure above — the script prints a hint
when it detects that signature.
