# Setting a product up

**One command:** `/claudegrill:setup`. Run it once per theme or plugin.

This file is only about getting a product onto claudegrill. **Installing the
plugin itself is [INSTALL.md](INSTALL.md)** — an organisation owner does that
once, and this page assumes it is done.

Roughly half a day for the first product, ~2 hours for each one after it, most
of which is reviewing the knowledge file rather than running the command.

---

## The command

```
/claudegrill:setup
```

It finds every theme and plugin in the WordPress install you are standing in,
asks which one, and works through everything this page describes — asking only
for what it cannot derive.

**It is resumable and skips whatever is already done.** Running it on a
half-configured product finishes the rest; running it on a finished one says so
and stops. Nothing is overwritten without `--force`.

It ends by actually running the suite, because files existing is not the same as
a setup that works.

### What it asks you for

Three things, because nothing can derive them:

| | |
|---|---|
| **Docs URL** | optional — skipping costs the area list, not the setup |
| **Base URL + WP admin credentials** | the site you test against |
| **Licence key** | pro products only, and **required** there |

Anything you type goes into the session transcript. If you would rather it did
not, write `.themegrill-qa/.env.local` yourself and re-run — `setup` picks it up
and skips the question.

### What it deliberately will not do

Two things, both because a wrong answer is worse than none:

- **`area_paths`** — nobody can infer a product's area map, and a wrong one
  silently narrows CI. Until you add it, every run is a full run.
- **Signing off the knowledge file's critical-flows list** — it drafts one, but
  the draft needs a maintainer. `suite-index.mjs` derives `areas_uncovered` from
  that list, so a wrong list sends every future effort to the wrong place.

---

## Before you start


- **Node 20+**, `git`, `npx`. Nothing else. No Python, no WSL, no Docker unless
  you opt into the `wp-env` engine.
- A **Claude Code seat** for anyone who will run the local commands. CI needs no
  seat and no key.
- Per product: `pnpm install` and `pnpm exec playwright install chromium` in the
  checkout, once.

**Who runs what.** Developers only ever type `/claudegrill:…` commands — they
install nothing and need no copy of this repo. `/claudegrill:setup` covers
everything below without a checkout. The setup steps below that invoke
scripts directly are run **once per product by whoever does the onboarding**,
from a checkout of this repo:

```bash
git clone git@github.com:ThemeGrill/claudegrill.git && cd claudegrill
```

Commands written as `npm run …` assume that checkout is your working directory;
`-- ` passes flags through to the script.

---


## What it does, step by step

Each step below is what `/claudegrill:setup` performs, in order. Read it when you
want to do a step by hand, or to understand what the command wrote.

### 1. Declare the suite

Add `.themegrill-qa/suite.json` to the product repo. The schema, every field and
what is inferred when omitted, is [SUITE.md §1](SUITE.md).

If the product has no Playwright suite at all, that is a real decision to make
first — see *Optional extras* below.

### 2. Tier every spec

Every test needs `@fresh` or `@demo` **in its title**, because the title is what
`--grep` matches. `@fresh` runs on a clean site and gates PRs; `@demo` needs demo
content and never gates anything.

**An untagged test counts as `@demo`.** Check what you actually have:

```bash
cd <the product checkout>
node <claudegrill>/plugins/claudegrill/scripts/suite-index.mjs --pretty
```

Read `by_tier`, `hygiene.untagged_tier`, and `areas_uncovered`.

> **Tier honestly.** A spec tagged `@fresh` must genuinely pass on a clean
> `boot-wp` site. ColorMag's suite passes 19/20 against a developer's Local site
> and **11/20 against a real Playground site** — seven Customizer specs time out
> under WASM PHP, and the roles spec cannot create its user. Those carry a tag
> they do not honour. Find this out now, not from a red required check.

### 3. Point it at a site

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
node <claudegrill>/plugins/claudegrill/scripts/run-suite.mjs --tier fresh --json
```

Exit 0 with a real `total` is success. Exit 2 means the harness is broken — which
includes *zero tests ran*, because a run that executed nothing is not a pass.

### 4. The knowledge file — the hour that decides output quality

`.themegrill-qa/knowledge.md` in the product repo. Use
[knowledge/_TEMPLATE.md](knowledge/_TEMPLATE.md), or draft one with
`/claudegrill:knowledge-init` and have a maintainer correct it.

The **critical-flows list is load-bearing**: `suite-index.mjs` derives
`areas_uncovered` from it, so a wrong list sends every future effort to the wrong
place. `ingest-docs.mjs` can seed the area list from the product's docs site.

### 5. Run it against fixes you already checked by hand

```
/claudegrill:verify-fix
```

Pick three fixes whose outcome you already know and compare verdicts. This is the
cheapest test of whether any of this works. It also exercises the `write-spec`
handoff — confirm the generated spec genuinely **fails against the stashed code
with an assertion failure**, not a timeout. If that gate does not hold, every
spec this platform generates is decorative.

## CI


Copy [`.github/workflows/examples/caller-suite.yml`](.github/workflows/examples/caller-suite.yml)
into the product as `.github/workflows/qa-suite.yml` and set the slug — or let
`/claudegrill:setup` write it. One job, on pull requests, scoped to the areas the
diff touches. This is the required check.

**Nothing runs on a schedule.** QA happens at two points and only two: a local
`/claudegrill:verify-fix` while the fix is being written, and the e2e suite on
the PR.

The consequence to know: with no scheduled run, a spec in an area no PR ever
touches will not execute. If that matters more than PR runtime, set
`scope: full` and every PR runs the whole `@fresh` tier.

Optionally add `area_paths` to `suite.json` so PR runs actually narrow — see
[SUITE.md](SUITE.md) and `examples/colormag-area-paths.json`. Without it every
run is a full run, which is correct, just slower.

**Make it required only once it has been green twice on real PRs.** A required
check that is red on arrival is one nobody ever turns green.

## The pro edition, if the product has one


Only for ColorMag Pro, Zakra Pro, User Registration Pro and Everest Forms Pro.
`/claudegrill:setup` does steps 1, 2 and 4 of this when it detects a pro
product — it recognises them from `licenses.json` — and step 3 is the one part it
cannot do, because only a repo admin can set a secret. Full reasoning in
[PRO.md](PRO.md).

1. **Locally**, add the licence key to the same gitignored `.env.local`:

   ```
   TGQA_LICENSE_COLORMAG_PRO=...
   ```

   Nothing else. `run-suite.mjs --pro` installs its own probe into the site's
   `mu-plugins/`, verifies the licence through the product's own gate, and
   removes the probe afterwards. Then:

   ```bash
   node <claudegrill>/plugins/claudegrill/scripts/run-suite.mjs --tier fresh --pro <slug>-pro --json
   ```

   A `@pro` run either verifies the licence or refuses with `licence not active`
   and exit 2. It never skips quietly and never passes on an assumed licence.

2. **In CI**, copy
   [`.github/workflows/examples/caller-pro-suite.yml`](.github/workflows/examples/caller-pro-suite.yml)
   into the **pro** repo as `.github/workflows/qa-pro.yml`, set `product_slug`,
   `pro_slug` and `product_repo` (the free repo).

3. **Add one secret** to that pro repo — `TGQA_LICENSE_<PRODUCT>`:

   ```sh
   node plugins/claudegrill/scripts/sync-secrets.mjs --audit
   node plugins/claudegrill/scripts/sync-secrets.mjs --confirm
   ```

   That is the only secret. No GitHub App, and nothing in the free repo.

4. **Install the pre-commit key guard** in any repo that holds a key:

   ```sh
   node plugins/claudegrill/scripts/install-git-hook.mjs
   ```

Keep `run_free_with_pro: true`. It is the only job that catches "installing pro
broke a free feature", which is invisible to the free repo's own CI.

## Grow the coverage — the actual work


The suite is the only automated safety net. An area with no specs is an area
where a regression ships unnoticed.

```bash
node <claudegrill>/plugins/claudegrill/scripts/suite-index.mjs --pretty
```

`areas_uncovered` is the backlog. The CI job prints the same list in its summary
and PR comment, so developers see it without running anything. Every
`/claudegrill:verify-fix` that ends VERIFIED should add one spec and shorten
it.

## Optional extras, in order of value


- **The agent tiers.** `pr-qa.yml` and `pr-command.yml` are in this repo, unused.
  They need an `ANTHROPIC_API_KEY`. Worth it only for a product whose suite is
  still too thin to trust.
- **Regression sweeps** for release candidates. `--file-tickets` is off by
  default and should stay off until the team has read several reports.
- **Jira filing.** Needs Rovo API-token auth. Defer until sweeps are trusted.

## Remaining products


Repeat this whole page per product. Nothing in [INSTALL.md](INSTALL.md)
repeats — the plugin is deployed once for the organisation.

---

## Troubleshooting


| Symptom | Cause |
|---|---|
| `/verify-fix` not found | Plugin skills are namespaced — use `/claudegrill:verify-fix` |
| Both `/verify-fix` and `/claudegrill:verify-fix` exist | An old symlinked copy in `~/.claude/skills` **wins** over the plugin. Delete it |
| Detected the wrong product | Detection resolves the **git repo root** of your cwd. Several products in one repo means the first header found wins — give each product its own checkout |
| `not a WordPress theme or plugin` | You are above the product. `cd` into the product checkout itself |
| Suite exits 2, "no base URL" | No `.env.local`, no `--base-url`, no `--boot` |
| `licence not active`, exit 2 | The product's own pro gate returned false, or the probe could not be installed. Is the pro product active on the site? |
| Probe not installed on a remote site | Deliberate — it only writes to `localhost`, `127.0.0.1`, `*.local` and `*.test`. Pass `--probe-url` for anything else |
| CI: "workflow was not found" | Reusable-workflow access — see [INSTALL.md](INSTALL.md) |
| Playground boot fails on activation | Fixed — it used to mount by directory name instead of slug |
| Specs pass locally, fail in CI | Almost always mis-tiered `@fresh`. See step 2 above |

## Checklist


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
