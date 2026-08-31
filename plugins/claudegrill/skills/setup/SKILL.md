---
name: setup
description: Set a theme or plugin up for claudegrill end to end — suite manifest, docs, knowledge file, credentials, licence, Playwright, CI workflow
argument-hint: "[optional: theme|plugin and a slug, e.g. 'theme colormag-pro']"
allowed-tools: Bash, Read, Write, Grep, Glob, Skill, AskUserQuestion
pass-arguments: true
---

# Set a product up for claudegrill

One command that takes a product from nothing to a working QA setup, asking only
for what cannot be derived.

**Everything here is resumable.** `setup-product.mjs status` reports which steps
are already done and you skip those, silently. Running this on a fully configured
product should do nothing but say so. Never redo a finished step "to be sure" —
a developer running it twice must not have their credentials rewritten or their
workflow clobbered.

## Where the scripts live — resolve this first

```bash
QA="${CLAUDE_PLUGIN_ROOT:-${THEMEGRILL_QA_HOME:-..}/plugins/claudegrill}"
[ -d "$QA/scripts" ] && echo "QA=$QA" || echo "cannot find the plugin scripts"
```

If that prints the failure, stop and say so. If the shell is not bash —
PowerShell on Windows — use that shell's equivalent.

## Step 1 — Which product

`$ARGUMENTS` may already name it (`theme colormag-pro`). If so, use it and do not
ask again.

Otherwise, find out what is actually on this machine rather than asking the
developer to type a path:

```bash
node "$QA/scripts/setup-product.mjs" list
```

That returns every theme and plugin in the WordPress install above the working
directory, each with `type`, `dir`, `pro`, `git` and `configured`. Then ask, with
**AskUserQuestion**, in two questions:

1. **Theme or plugin?**
2. **Which one?** — offer the discovered `dir` names of that type as the options,
   marking any already `configured`. Prefer products with `git: true`: a checkout
   that is not a git repo cannot receive a workflow or a spec commit, and you
   should say so if they pick one.

If `list` reports no WordPress installation, ask for the path to the WordPress
root and pass it as `--site`.

**Use the `dir` name, not the `slug`.** ColorMag Pro's `style.css` declares
`Text Domain: colormag`, so its slug collides with the free theme; the directory
name is what identifies a checkout.

## Step 2 — What is already done

```bash
node "$QA/scripts/setup-product.mjs" status --type <theme|plugin> --slug <dir>
```

Read `remaining`. That list, in order, is your plan. Tell the developer what you
are about to do and what you are skipping, in one short block, then work through
it. If `complete` is true, say so and stop — offer to re-run one step with
`--force` if they actually want that.

Each step below runs **only if it appears in `remaining`.**

## Step 3 — `.themegrill-qa/`

```bash
node "$QA/scripts/setup-product.mjs" init-dir --root <root>
```

Every later step writes into it. Use the absolute `root` from `status` for the
rest of this run, so nothing depends on the working directory.

## Step 4 — The suite manifest

```bash
node "$QA/scripts/setup-product.mjs" write-suite --root <root>
```

It describes the suite the product already has, resolving every field through the
same inference the runner uses rather than a second guess at it.

**If it fails with "no Playwright suite found"**, the product has no specs yet.
That is a real gap and not something this command can invent — say so plainly,
point at [SUITE.md](SUITE.md) and `examples/`, and **carry on with the remaining
steps**. Everything else still works, and the suite can be added later.

Whatever happens, tell them `area_paths` is not written and cannot be: nobody can
infer a product's area map, and a wrong one silently narrows CI. Without it every
run is a full run — correct, just slower.

## Step 5 — Docs, if there are any

Only if `docs.done` is false. Ask for the documentation URL, and say it is
optional — skipping costs the area list, not the setup.

ThemeGrill's own docs sites have a usable REST API, and it gives real categories
instead of guesses from URL segments:

```bash
cd <root> && node "$QA/scripts/ingest-docs.mjs" --rest https://docs.themegrill.com/<product>
```

For anything else, pass a sitemap URL instead of `--rest`. If the REST attempt
returns nothing useful, try the sitemap before giving up.

## Step 6 — The knowledge file

Only if `knowledge.done` is false. Invoke the **`knowledge-init`** skill against
this product. It drafts `.themegrill-qa/knowledge.md` from the source and the
docs you just ingested.

Then say the one thing that matters about it: **the critical-flows list is
load-bearing.** `suite-index.mjs` derives `areas_uncovered` from it, so a wrong
list sends every future effort to the wrong place. The draft needs a maintainer's
correction — it is not finished when this command ends.

## Step 7 — Credentials

Only if `env.done` is false. `status.env.needs` names exactly the variables this
product wants, taken from its own manifest.

Ask for the base URL of the site they test on, and the WordPress admin username
and password for it.

**Before asking for the password, say this once:** anything typed here goes into
this session's transcript. If they would rather not, they can write
`.themegrill-qa/.env.local` themselves and you will pick it up on the next
`status`.

Then — and this part is not negotiable — **pass the values through the
environment, never as arguments.** Arguments are visible in the process list to
every other process on the machine:

```bash
TGQA_SETUP_BASE_URL="…" TGQA_SETUP_ADMIN_USER="…" TGQA_SETUP_ADMIN_PASS="…" \
  node "$QA/scripts/setup-product.mjs" write-env --root <root>
```

The script gitignores the file **before** writing anything into it, and refuses
to continue if the rule does not take. Its output names the keys it set and never
their values — do not echo the file back, and do not repeat the password in your
summary.

## Step 8 — The licence, on a pro product only

Only if `status.steps.license` exists and is not done. On a pro product this is
**required, not optional**: a `@pro` run either verifies a real licence or fails
with `licence not active`. There is no third outcome, so a pro setup without a
key is a setup that cannot test the pro code.

Ask for the key — a dedicated QA key, never the company key — and write it the
same way:

```bash
TGQA_SETUP_LICENSE="…" node "$QA/scripts/setup-product.mjs" write-env --root <root>
```

Tell them what they do **not** have to do: there is no probe to install. `--pro`
puts one into the site's `mu-plugins/`, reads the product's own gate, and removes
it again.

Then install the pre-commit guard, so a key can never become tracked content:

```bash
cd <root> && node "$QA/scripts/install-git-hook.mjs"
```

## Step 9 — Playwright

Only if `playwright.done` is false. Use the package manager from
`status.playwright.package_manager`:

```bash
cd <root> && pnpm install && pnpm exec playwright install chromium
```

Chromium only — the suites target it, and the other browsers are a slow download
nobody uses. If there is no `package.json`, say so and skip; the product has no
JS toolchain yet.

## Step 10 — The CI workflow

```bash
node "$QA/scripts/setup-product.mjs" write-workflow --root <root>
```

It picks `qa-suite.yml` for a free product and `qa-pro.yml` for a pro one, and
fills in the slugs — including, for a pro product, the free repo it must check
out alongside.

**A pro workflow needs one repository secret**, `TGQA_LICENSE_<PRODUCT>`, and only
a repo admin can set it. Name it explicitly in your summary as an action for a
human. Nothing else is required: no GitHub App, and nothing in the free repo.

## Step 11 — Prove it works

Do not report success on files existing. Run the suite:

```bash
cd <root> && node "$QA/scripts/run-suite.mjs" --tier fresh --json
```

and on a pro product, additionally:

```bash
cd <root> && node "$QA/scripts/run-suite.mjs" --tier fresh --pro <dir> --json
```

`--json` is a cost instruction, not a formatting one: without it the runner
prints a line per test straight into your context. Read `ok`, the counts and
`failures[]`; do not quote the JSON back.

Interpret honestly:

- **exit 0 with a real `total`** — working.
- **exit 2, `ran_nothing`** — the tier filter matched no tests. Usually every
  spec is untagged, which counts as `@demo`. Say which.
- **exit 2, `no base URL`** — Step 7 did not take.
- **exit 2, `licence not active`** — the key is wrong, or the pro product is not
  the active theme/plugin on that site. Say which you think it is.
- **failures** — the suite runs; the specs disagree with the site. That is a
  result, not a setup failure. Report the count and move on.

## Step 12 — Report

Short, and honest about what a human still owns:

```
Product   <name> <version> (<type>, <dir>)
Site      <base url>

Done
  <step> — <what was written>
  ...
Skipped (already present)
  <step>, <step>
Suite     <n> passed, <n> failed  — or why it could not run

Still needs a human
  - area_paths in suite.json, or every CI run is a full run
  - knowledge.md critical-flows list reviewed by a maintainer
  - TGQA_LICENSE_<PRODUCT> set as a repo secret        (pro only)
  - make the CI check required once it is green twice
```

**Never claim a step succeeded that you did not observe succeeding.** A setup
command that reports green on a broken setup is worse than one that fails.

## Rules

- **Never write a secret into anything but `.env.local`**, and never echo one
  back — not into your summary, not into a code block, not "to confirm".
- **Never overwrite without `--force`,** and never pass `--force` unless the
  developer asked for that specific step to be redone.
- **Never edit product source.** This command configures; it does not fix.
- If a step fails, say so, do the remaining independent steps anyway, and list
  what was left undone. A half-finished setup that is honest about which half is
  far more useful than one that stops at the first error.
