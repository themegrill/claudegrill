# Setting up ColorMag

The concrete version of `SETUP.md`, with ColorMag's real values filled in.
Work through it in order. Roughly half a day, most of it step 5.

---

## 0. Which shell — read this first

**Use WSL2, not Windows directly.** The scripts here are bash, and three of the
things they rely on behave differently or not at all under Git Bash:
`readlink -f` for resolving symlinked installs, backgrounding the Playground
server, and `mktemp` semantics. You would get confusing partial failures rather
than clean ones.

```powershell
# PowerShell, as administrator, once
wsl --install -d Ubuntu
```

Then do everything below inside Ubuntu. Docker Desktop integrates with WSL2 if
you later want the `wp-env` engine, symlinks work natively, and Claude Code runs
there fine.

**If you would rather not install WSL:** the Playground CLI itself is Node and
cross-platform, so you can drive it directly on Windows and skip `boot-wp.sh`:

```powershell
npx @wp-playground/cli@latest start --path=C:\path\to\colormag --php=8.3 --port=9400 --login
```

You lose the blueprint seeding and the JSON handoff, so `/verify-fix` will not
work end to end. Fine for a first look; not the setup to build on.

---

## 1. Prerequisites

```bash
node -v      # need 20+
git --version
claude --version
```

Docker is only needed for `--engine wp-env`, which you will not need on day one.

---

## 2. Clone and install the skills

```bash
git clone git@github.com:ThemeGrill/themegrill-qa.git ~/src/themegrill-qa
cd ~/src/themegrill-qa && chmod +x scripts/*.sh

mkdir -p ~/.claude/skills
for s in verify-fix pr-qa-review regression-sweep full-test knowledge-init; do
  ln -s ~/src/themegrill-qa/.claude/skills/$s ~/.claude/skills/$s
done

echo 'export THEMEGRILL_QA_HOME="$HOME/src/themegrill-qa"' >> ~/.bashrc
source ~/.bashrc
```

**Check:** open Claude Code in any directory, type `/`, and `verify-fix` should
be listed.

---

## 3. Boot ColorMag — the step most likely to break

```bash
cd ~/src/colormag          # your ColorMag checkout
$THEMEGRILL_QA_HOME/scripts/boot-wp.sh --engine playground
```

This has never been run against a live network — the environment it was built in
blocked `wordpress.org` and `playground.wordpress.net`. Expect to fix something
in `blueprints/theme-test.json` here. That is the honest state of it, and it is
why this is step 3 and not step 6.

What should happen: it prints a JSON line with a URL, you open it, and ColorMag
is active with a dozen sample posts, three categories, a nav menu with a
dropdown, and four pages.

**If it fails:**

| Symptom | Meaning | Do this |
|---|---|---|
| `not valid JSON` / `Host not...` | blocked network | allowlist those two hosts, or use `--engine wp-env` |
| Boots but ColorMag is not active | blueprint slug mismatch | run `scripts/detect-product.sh` and check `slug` matches `activateTheme` in the blueprint |
| A `wp-cli` blueprint step errors | step unsupported in this Playground version | delete that step, re-run, and fix it properly after |
| Port already in use | something on 9400 | `PORT=9411 ./boot-wp.sh ...` |

Do not continue past this step. Everything else assumes a working site.

---

## 4. Ingest ColorMag's documentation

ColorMag's docs are WordPress + BetterDocs, and they expose a REST API — which is
better than scraping, because the sections come from the site's own categories
rather than being guessed from URLs. That matters here specifically: every
article lives at `/colormag/docs/<slug>/`, so there is no section in the path at
all.

```bash
cd ~/src/colormag
python3 $THEMEGRILL_QA_HOME/scripts/ingest-docs.py \
  --rest https://docs.themegrill.com/colormag \
  --out .themegrill-qa
```

**Expected output** — I checked this against the live API, so the numbers should
match almost exactly:

```
found    11 categories, 93 articles

content      20 articles      widgets      18 articles
header       13 articles      faq          10 articles
global        8 articles      footer        8 articles
get-started   4 articles      additional    4 articles   ← under Customization
front-page    4 articles      how-to        3 articles   ← under Customization
customization 1 article
```

If the counts are wildly different, the docs changed since I looked — trust the
run, not this table. If anything lands under `thin`, open it: usually a page
built entirely from blocks the parser skipped.

### Prune the areas before you use them

The generated `suggested_areas` is documentation structure, not QA structure. For
ColorMag they are not the same thing, and the area count is what a full sweep
costs, so this is worth two minutes:

**Keep — real product surfaces:**
`header` · `content` · `footer` · `widgets` · `global` · `front-page` · `additional`

**Drop — support content, not product surfaces:**
`faq` (account, billing and login questions — nothing to test on the site) and
most of `how-to`.

**Fold:** `customization` has one article; merge it into `global`.

**Rename:** `get-started` is mostly installation, which *is* worth sweeping — call
it `activation` and make it the "does it activate cleanly on a site with existing
content" area.

That gives eight areas. Paste into ColorMag's sweep caller:

```yaml
areas_json: >-
  ["activation","header","content","footer","widgets","global",
   "front-page","additional"]
smoke_areas_json: >-
  ["activation","header","content"]
```

Eight areas × two environment combinations = 16 shards, roughly $42 for a full
pre-release pass.

---

## 5. The knowledge file — the hour that decides everything

```bash
cd ~/src/colormag
claude
> /knowledge-init
```

It drafts `.themegrill-qa/knowledge.md` from ColorMag's source, the docs you just
ingested, and its git history, leaving `TODO` on everything it could not derive.

**Then book an hour with whoever knows ColorMag best** and settle these four.
Nothing else in this setup returns as much:

1. **Order the critical flows by blast radius.** The draft proposes a list. Which
   of these would cost you a refund, and which is an annoyance? Front-page news
   blocks, demo import, customizer round-trip, header layouts, mobile menu,
   WooCommerce pages, upgrade migration.

2. **Confirm the theme mod option name.** The starter file guesses
   `theme_mods_colormag`. Verify with `wp option list --search='theme_mods*'`,
   and list anything ColorMag stores *outside* theme mods.

3. **Known non-issues.** Behaviour that looks like a bug and is deliberate. Even
   two entries help. The obvious candidate: switching themes away and back —
   theme mods are per-theme, so some loss is by design, and the agent will report
   it as a bug forever until this says otherwise.

4. **Upgrade paths.** Which ColorMag versions migrated settings, what must
   survive, and how to seed the old shape. This is the section most worth filling
   and the one most likely to be skipped.

Commit the result to the **ColorMag repo**, not to themegrill-qa.

---

## 6. Point it at fixes you already checked by hand

Pick three or four ColorMag fixes you personally verified recently.

```bash
cd ~/src/colormag
git checkout fix/CM-1234-whatever
claude
> /verify-fix
```

No arguments — it reads the product from `style.css`, the change from
`git diff`, and the Jira key from the branch name.

**Judge it against what you found manually:**

- Did it reproduce the bug on the old code *before* confirming the fix? If it
  skipped that, the verdict is worth much less.
- Did its blast-radius list match what you were worried about?
- Was its "Not checked" section honest, or did it imply coverage it did not have?

Where it disagrees with you, work out who was right. That answer belongs in the
knowledge file either way — which is how the file earns its keep.

**This is the decision point.** If it agrees with you on three fixes, go on to
CI. If it does not, fix the knowledge file and try again before spending anything
on automation.

---

## 7. Only then, CI

Add `.github/workflows/qa.yml` to the ColorMag repo:

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
      wp_version: latest
      php_version: "8.3"
    secrets:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

Test it twice deliberately: once on a PR that breaks something you know about,
to confirm it is caught; once on a comment-only typo fix, to confirm the triage
step skips it entirely. If trivial PRs are burning browser runs, fix the path
filters before opening this to the team.

---

## Where each file ends up

| File | Repo |
|---|---|
| `.themegrill-qa/knowledge.md` | colormag |
| `.themegrill-qa/docs/*.md`, `docs-index.json` | colormag (committed) |
| `.themegrill-qa/.docs-cache/` | colormag (gitignored) |
| `.themegrill-qa/findings/colormag-2026.jsonl` | colormag |
| `.github/workflows/qa.yml`, `sweep.yml` | colormag |
| `tests/e2e/**` | colormag, once specs exist |
| everything else | themegrill-qa |

Add to ColorMag's `.gitignore`:

```
.themegrill-qa/.docs-cache/
```

---

## Order of operations, condensed

```
WSL2 → clone + link skills → boot a site → ingest docs → prune areas
     → knowledge file + the human hour → verify-fix on known fixes
     → DECIDE → CI on ColorMag only → watch a dozen PRs → then Zakra
```

Step 3 is the technical risk. Step 5 is the one that determines whether the
output is useful. Step 6 is where you find out if any of it works.
