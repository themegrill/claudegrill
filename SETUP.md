# Setup

The ordered runbook. Roughly a day for the first product, ~2 hours for each one
after it.

Read [SUITE.md](SUITE.md) first if you want to know *why* it is shaped this way.
This document is just the steps.

---

## What you are setting up

1. **A CI check on every PR** that runs the product's own Playwright specs, with
   no API key and no agent.
2. **A local command** — `/themegrill-qa:verify-fix` — that verifies a fix and
   turns it into a committed spec, so the CI tier grows.
3. **The pro jobs**, for the four products that have a pro edition.
4. **Optional agent tiers**, off by default, for a product whose suite is still
   too thin to trust.

The loop: developer fixes a bug → verifies it locally → a spec lands on their
branch with the fix → CI runs that spec on every PR from then on.

## Before you start

- **Node 20+**, `git`, `npx`. Nothing else. No Python, no WSL, no Docker unless
  you opt into the `wp-env` engine.
- A **Claude Code seat** for anyone who will run the local commands. CI needs no
  seat and no key.
- Per product: `pnpm install` and `pnpm exec playwright install chromium` in the
  checkout, once.

**Who runs what.** Developers only ever type `/themegrill-qa:…` commands — they
install nothing and need no copy of this repo. The setup steps below that invoke
scripts directly are run **once per product by whoever does the onboarding**,
from a checkout of this repo:

```bash
git clone git@github.com:ThemeGrill/themegrill-qa.git && cd themegrill-qa
```

Commands written as `npm run …` assume that checkout is your working directory;
`-- ` passes flags through to the script.

---

## Phase 0 — Public or private · already decided

**This repo is public.** Nothing in Phase 0 needs doing. It matters only because
three things depend on it and all three are now free: CI needs no
`QA_REPO_TOKEN`, the reusable workflows resolve with no Access setting, and
developers need no individual git access for the plugin to load.

If it is ever made private again, set both: **Settings → Actions → General →
Access** → *"Accessible from repositories in the organization"*, and an org
secret `QA_REPO_TOKEN` with `contents: read`.

## Phase 1 — Deploy the plugin to the org · 15 min, once

The full detail is in [INSTALL.md](INSTALL.md). The short version:

1. Bump `version` in `.claude-plugin/marketplace.json` and push. **This is the
   only thing that triggers an update** — `plugin.json` deliberately has no
   version, so the marketplace entry is what counts.
2. Validate: `claude plugin validate .` and `claude plugin validate
   ./plugins/themegrill-qa`. One warning about a missing version is **expected
   and correct** — do not silence it.
3. An org owner adds this in **claude.ai → Admin Settings → Claude Code →
   Managed settings**:

```json
{
  "extraKnownMarketplaces": {
    "themegrill": {
      "source": { "source": "github", "repo": "ThemeGrill/themegrill-qa" },
      "autoUpdate": true
    }
  },
  "enabledPlugins": { "themegrill-qa@themegrill": true }
}
```

4. Developers restart Claude Code. Verify on one machine with `/status` — the
   **Setting sources** line must read `Enterprise managed settings (remote)`.

**Tell the team the commands are namespaced:** `/themegrill-qa:verify-fix`, not
`/verify-fix`. This is the most likely day-one support question.

## Phase 2 — First product · ~half a day

### 2.1 Declare the suite

Add `.themegrill-qa/suite.json` to the product repo. The schema, every field and
what is inferred when omitted, is [SUITE.md §1](SUITE.md).

If the product has no Playwright suite at all, that is a real decision to make
first — see Phase 6.

### 2.2 Tier every spec

Every test needs `@fresh` or `@demo` **in its title**, because the title is what
`--grep` matches. `@fresh` runs on a clean site and gates PRs; `@demo` needs demo
content and never gates anything.

**An untagged test counts as `@demo`.** Check what you actually have:

```bash
cd <the product checkout>
node <themegrill-qa>/plugins/themegrill-qa/scripts/suite-index.mjs --pretty
```

Read `by_tier`, `hygiene.untagged_tier`, and `areas_uncovered`.

> **Tier honestly.** A spec tagged `@fresh` must genuinely pass on a clean
> `boot-wp` site. ColorMag's suite passes 19/20 against a developer's Local site
> and **11/20 against a real Playground site** — seven Customizer specs time out
> under WASM PHP, and the roles spec cannot create its user. Those carry a tag
> they do not honour. Find this out now, not from a red required check.

### 2.3 Point it at a site

Create `.themegrill-qa/.env.local` in the product repo — gitignored, never
committed:

```
TGQA_BASE_URL=http://test-colormag.local
CM_ADMIN_USER=admin
CM_ADMIN_PASS=password
```

The admin variable names come from the product's own `suite.json`
(`env.admin_user`, `env.admin_pass`); `TGQA_ADMIN_USER` / `TGQA_ADMIN_PASS` work
everywhere as a fallback. Add `.env.local` to the product's `.gitignore`
**before** writing it.

Then confirm the whole chain works:

```bash
cd <the product checkout>
node <themegrill-qa>/plugins/themegrill-qa/scripts/run-suite.mjs --tier fresh --json
```

Exit 0 with a real `total` is success. Exit 2 means the harness is broken — which
includes *zero tests ran*, because a run that executed nothing is not a pass.

### 2.4 The knowledge file — the hour that decides output quality

`.themegrill-qa/knowledge.md` in the product repo. Use
[knowledge/_TEMPLATE.md](knowledge/_TEMPLATE.md), or draft one with
`/themegrill-qa:knowledge-init` and have a maintainer correct it.

The **critical-flows list is load-bearing**: `suite-index.mjs` derives
`areas_uncovered` from it, so a wrong list sends every future effort to the wrong
place. `ingest-docs.mjs` can seed the area list from the product's docs site.

### 2.5 Run it against fixes you already checked by hand

```
/themegrill-qa:verify-fix
```

Pick three fixes whose outcome you already know and compare verdicts. This is the
cheapest test of whether any of this works. It also exercises the `write-spec`
handoff — confirm the generated spec genuinely **fails against the stashed code
with an assertion failure**, not a timeout. If that gate does not hold, every
spec this platform generates is decorative.

## Phase 3 — CI · ~1 hour

Copy [`.github/workflows/examples/caller-suite.yml`](.github/workflows/examples/caller-suite.yml)
into the product as `.github/workflows/qa-suite.yml` and set the slug. It has two
jobs and both matter:

- **`pr`** — scoped to the areas the diff touches. This is the required check.
- **`nightly`** — the whole `@fresh` tier on a schedule. Advisory.

**Do not drop the nightly job.** Once PR runs are scoped, nothing else runs the
full suite, and a spec whose area stops being touched silently stops executing.

Optionally add `area_paths` to `suite.json` so PR runs actually narrow — see
[SUITE.md](SUITE.md) and `examples/colormag-area-paths.json`. Without it every
run is a full run, which is correct, just slower.

**Make it required only once it has been green twice on real PRs.** A required
check that is red on arrival is one nobody ever turns green.

## Phase 4 — The pro edition, if the product has one · ~30 min

Only for ColorMag Pro, Zakra Pro, User Registration Pro and Everest Forms Pro.
Full reasoning in [PRO.md](PRO.md); these are the steps.

1. **Locally**, add the licence key to the same gitignored `.env.local`:

   ```
   TGQA_LICENSE_COLORMAG_PRO=...
   ```

   Nothing else. `run-suite.mjs --pro` installs its own probe into the site's
   `mu-plugins/`, verifies the licence through the product's own gate, and
   removes the probe afterwards. Then:

   ```bash
   node <themegrill-qa>/plugins/themegrill-qa/scripts/run-suite.mjs --tier fresh --pro <slug>-pro --json
   ```

   A `@pro` run either verifies the licence or refuses with `licence not active`
   and exit 2. It never skips quietly and never passes on an assumed licence.

2. **In CI**, copy
   [`.github/workflows/examples/caller-pro-suite.yml`](.github/workflows/examples/caller-pro-suite.yml)
   into the **pro** repo as `.github/workflows/qa-pro.yml`, set `product_slug`,
   `pro_slug` and `product_repo` (the free repo).

3. **Add one secret** to that pro repo — `TGQA_LICENSE_<PRODUCT>`:

   ```sh
   node plugins/themegrill-qa/scripts/sync-secrets.mjs --audit
   node plugins/themegrill-qa/scripts/sync-secrets.mjs --confirm
   ```

   That is the only secret. No GitHub App, and nothing in the free repo.

4. **Install the pre-commit key guard** in any repo that holds a key:

   ```sh
   node plugins/themegrill-qa/scripts/install-git-hook.mjs
   ```

Keep `run_free_with_pro: true`. It is the only job that catches "installing pro
broke a free feature", which is invisible to the free repo's own CI.

## Phase 5 — Grow the coverage · ongoing, and this is the actual work

The suite is the only automated safety net. An area with no specs is an area
where a regression ships unnoticed.

```bash
node <themegrill-qa>/plugins/themegrill-qa/scripts/suite-index.mjs --pretty
```

`areas_uncovered` is the backlog. The CI job prints the same list in its summary
and PR comment, so developers see it without running anything. Every
`/themegrill-qa:verify-fix` that ends VERIFIED should add one spec and shorten
it.

## Phase 6 — Optional extras, in order of value

- **The agent tiers.** `pr-qa.yml` and `pr-command.yml` are in this repo, unused.
  They need an `ANTHROPIC_API_KEY`. Worth it only for a product whose suite is
  still too thin to trust.
- **Regression sweeps** for release candidates. `--file-tickets` is off by
  default and should stay off until the team has read several reports.
- **Jira filing.** Needs Rovo API-token auth. Defer until sweeps are trusted.

## Phase 7 — Remaining products · ~2 hours each

Repeat Phase 2, 3 and 4. Nothing from Phase 0 or 1 repeats.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `/verify-fix` not found | Plugin skills are namespaced — use `/themegrill-qa:verify-fix` |
| Both `/verify-fix` and `/themegrill-qa:verify-fix` exist | An old symlinked copy in `~/.claude/skills` **wins** over the plugin. Delete it |
| Detected the wrong product | Detection resolves the **git repo root** of your cwd. Several products in one repo means the first header found wins — give each product its own checkout |
| `not a WordPress theme or plugin` | You are above the product. `cd` into the product checkout itself |
| Suite exits 2, "no base URL" | No `.env.local`, no `--base-url`, no `--boot` |
| `licence not active`, exit 2 | The product's own pro gate returned false, or the probe could not be installed. Is the pro product active on the site? |
| Probe not installed on a remote site | Deliberate — it only writes to `localhost`, `127.0.0.1`, `*.local` and `*.test`. Pass `--probe-url` for anything else |
| CI: "workflow was not found" | Reusable-workflow access. See Phase 0 |
| Playground boot fails on activation | Fixed — it used to mount by directory name instead of slug |
| Specs pass locally, fail in CI | Almost always mis-tiered `@fresh`. See Phase 2.2 |

## Checklist

**Once, for the org**
- [ ] Marketplace version bumped, plugin validated
- [ ] Managed settings deployed; `/status` verified on one machine
- [ ] Team told about the `/themegrill-qa:` prefix

**Per product**
- [ ] `.themegrill-qa/suite.json`, with `area_paths` if you want scoping
- [ ] Every spec tiered, and `@fresh` verified against a *clean* site
- [ ] `.env.local` written and gitignored
- [ ] `knowledge.md` with a critical-flows list a maintainer agrees with
- [ ] `run-suite.mjs --tier fresh` exits 0 locally
- [ ] `qa-suite.yml` added, both jobs, green twice before making it required

**Per pro product, additionally**
- [ ] `TGQA_LICENSE_<PRODUCT>` in `.env.local`, and `--pro` verifies locally
- [ ] `qa-pro.yml` added with `product_repo` set to the free repo
- [ ] `TGQA_LICENSE_<PRODUCT>` set as a secret in the pro repo
- [ ] Pre-commit key guard installed
