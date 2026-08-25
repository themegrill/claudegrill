# Bringing an already-pushed copy up to date

You extracted an earlier zip and pushed it. This says what changed since, and the
three ways to catch up — easiest first.

---

## 1. Work out which version you pushed

Run this in your repo. The first line that matches tells you where you are.

```bash
ls plugins/themegrill-qa/skills 2>/dev/null && echo "→ E · current (plugin layout)"
ls scripts/detect-product.mjs   2>/dev/null && echo "→ D · Node port, pre-plugin"
ls SETUP-COLORMAG.md            2>/dev/null && echo "→ C · REST docs + ColorMag walkthrough"
ls STORAGE.md                   2>/dev/null && echo "→ B · storage + findings ledger"
ls CONVENTIONS.md               2>/dev/null && echo "→ B · spec conventions + packages/core"
ls scripts/detect-product.sh    2>/dev/null && echo "→ A · original scaffold (bash + Python)"
```

On Windows PowerShell:

```powershell
foreach ($p in @(
  @('plugins/themegrill-qa/skills','E · current (plugin layout)'),
  @('scripts/detect-product.mjs','D · Node port, pre-plugin'),
  @('SETUP-COLORMAG.md','C · REST docs + ColorMag walkthrough'),
  @('STORAGE.md','B · storage + findings ledger'),
  @('scripts/detect-product.sh','A · original scaffold (bash + Python)')
)) { if (Test-Path $p[0]) { "→ $($p[1])" } }
```

If **E** appears you are already current and can stop reading.

---

## 2. Option A — replace the contents · recommended

If you have not edited any files yourself, this is the safest route, because a
half-finished manual migration is the one state that produces confusing errors
later.

```bash
cd /path/to/your/themegrill-qa-repo

# Remove everything tracked except git's own directory, then unpack the new zip
git rm -r --quiet --cached .
find . -mindepth 1 -maxdepth 1 -not -name '.git' -exec rm -rf {} +

unzip -q ~/Downloads/themegrill-qa.zip -d /tmp/tgqa-new
rm -rf /tmp/tgqa-new/themegrill-qa/.git      # never copy a foreign .git over yours
cp -a /tmp/tgqa-new/themegrill-qa/. .

git add -A
git status --short | head -40        # read this before committing
git commit -m "Update to Node-only plugin layout"
git push
```

That `rm -rf …/.git` line is not optional paranoia. Earlier zips were packed with
a `.git` directory inside them, and `cp -a` would then overwrite your repository's
history with mine — your import commit gone, replaced by nine unrelated ones. The
zip shipped alongside this file has no `.git`, but delete it anyway in case you
reach for an older download.

Windows PowerShell equivalent:

```powershell
cd C:\path\to\themegrill-qa-repo
git rm -r --quiet --cached .
Get-ChildItem -Force | Where-Object { $_.Name -ne '.git' } | Remove-Item -Recurse -Force
Expand-Archive -Path "$HOME\Downloads\themegrill-qa.zip" -DestinationPath "$env:TEMP\tgqa-new" -Force
Remove-Item "$env:TEMP\tgqa-new\themegrill-qa\.git" -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item "$env:TEMP\tgqa-new\themegrill-qa\*" -Destination . -Recurse -Force
git add -A
git status --short
git commit -m "Update to Node-only plugin layout"
git push
```

`git rm -r --cached .` matters: without it, files that were **deleted** in the
new version stay tracked, and you end up with both `scripts/boot-wp.sh` and
`plugins/themegrill-qa/scripts/boot-wp.mjs` in the repo.

---

## 3. Option B — fetch real history from the bundle

If you would rather have the individual commits and their messages than one
squashed update, use the bundle that came with this file:

```bash
cd /path/to/your/themegrill-qa-repo
git remote add upstream /path/to/themegrill-qa-history.bundle
git fetch upstream
git log --oneline upstream/main          # inspect before you take it

# Make the working tree and index match upstream exactly, keeping your own
# commit as history:
git read-tree -u --reset upstream/main
git status --short                        # read this
git commit -m "Update to Node-only plugin layout"

git remote remove upstream
git push
```

**Use `read-tree`, not `git checkout upstream/main -- .`.** The obvious-looking
checkout adds and updates files but never *deletes* the ones that went away, so
all five old `.sh` and `.py` scripts survive and you end up with two of
everything. `read-tree -u --reset` makes the tree match exactly, deletions
included. Verified: 40 files, no stale scripts, your import commit still in the
log.

If you would rather your repo simply *be* that history and you do not mind
discarding your single import commit:

```bash
git fetch upstream 'refs/heads/*:refs/heads/upstream-*'
git reset --hard upstream-main
git push --force-with-lease
```

Only do the force-push if nobody else has cloned it yet.

---

## 4. Option C — apply the recent patches by hand

`themegrill-qa-recent-patches.tar.gz` holds the last three commits as patch
files. Useful if you are at version **D** and only need the last two steps, or if
you have local edits you want git to merge around:

```bash
tar xzf themegrill-qa-recent-patches.tar.gz
git am 0002-Ship-as-a-Claude-Code-plugin*.patch
git am 0003-Rewrite-Phase-1*.patch
```

Start from `0001` if you are at version **A**, **B** or **C**. If `git am` stops
on a conflict, `git am --abort` and use Option A instead — the patches assume the
exact file contents they were generated against.

---

## What actually changed, newest first

### Ship as a Claude Code plugin · the structural one

Everything the skills need moved inside a plugin directory, because Claude Code
copies a plugin into its own cache and a copied plugin **cannot reach files
outside its own folder**. Left where they were, the scripts would have been left
behind on install.

| Before | After |
|---|---|
| `.claude/skills/` | `plugins/themegrill-qa/skills/` |
| `scripts/` | `plugins/themegrill-qa/scripts/` |
| `blueprints/` | `plugins/themegrill-qa/blueprints/` |

New files:

- `.claude-plugin/marketplace.json` — makes this repo a private plugin
  marketplace. Bump `version` here to release an update to the team.
- `plugins/themegrill-qa/.claude-plugin/plugin.json` — the plugin manifest.
  Deliberately has **no** `version` field, because setting it here would mask the
  marketplace value.
- `INSTALL.md` — the three install routes, and who needs a local install at all.

Changed:

- All five `SKILL.md` files gained a "Where the scripts live" preamble and now
  invoke scripts as `node "$QA/scripts/…"`, where `$QA` resolves from
  `CLAUDE_PLUGIN_ROOT` with a clone fallback.
- `boot-wp.mjs` resolves the plugin root from its own file path first, and
  tolerates `THEMEGRILL_QA_HOME` pointing at either the repo root or the plugin
  directory.
- Both reusable workflows copy from the new paths.
- `package.json` script paths, `install.mjs` source path.
- `README.md` layout, `CLAUDE.md` layout and conventions, `SETUP.md` Phase 1,
  `SETUP-COLORMAG.md` step 1.

### Port everything to Node · the big one

Deleted, replaced by `.mjs` equivalents that were verified to produce identical
output before the originals were removed:

```
scripts/detect-product.sh    → detect-product.mjs
scripts/boot-wp.sh           → boot-wp.mjs
scripts/ingest-docs.py       → ingest-docs.mjs
scripts/ingest-testsuite.py  → ingest-testsuite.mjs
scripts/estimate-cost.py     → estimate-cost.mjs
```

New: `install.mjs`, `package.json`.

**If you keep the old files you will have two of everything**, so make sure the
`.sh` and `.py` versions are actually gone — that is the single most likely
mistake in a manual migration:

```bash
git ls-files | grep -E '\.(sh|py)$'      # must print nothing
```

Also in this commit: `boot-wp` no longer reports a broken site as ready. The
readiness check previously accepted any HTTP response, and Playground answers with
502s *while it is failing*, so it would hand the agent an unusable site.

### Earlier commits

- **REST docs ingestion** — `ingest-docs` gained `--rest`, needed for ColorMag
  because its article URLs carry no section. Added `SETUP-COLORMAG.md`.
- **Test-suite extractor** — `ingest-testsuite` reads a Selenium/Robot suite as a
  specification rather than converting it.
- **Storage and the findings ledger** — added `STORAGE.md`; the sweep skill now
  checks `.themegrill-qa/findings/<product>-<year>.jsonl` before reporting.
- **Spec conventions and the suite layer** — added `CONVENTIONS.md`,
  `packages/core/`, `examples/colormag-customizer.spec.js`.

---

## After migrating, check these five things

```bash
npm run check                            # every .mjs parses
git ls-files | grep -E '\.(sh|py)$'      # nothing
ls plugins/themegrill-qa/scripts         # five .mjs files
ls .claude-plugin/marketplace.json       # exists
node install.mjs                         # links skills, smoke-tests
```

Then, from a product checkout:

```bash
node "$THEMEGRILL_QA_HOME/plugins/themegrill-qa/scripts/detect-product.mjs"
```

That should print JSON naming your product. If it does, the migration is sound
and the next thing to do is still task 1 in `CLAUDE.md` — get `boot-wp.mjs`
through a real Playground boot.

---

## One thing to fix by hand whichever route you take

Both reusable workflows and the two caller examples name the repo as
`ThemeGrill/themegrill-qa`. If you pushed to a different org or under a different
name, update it:

```bash
grep -rn "ThemeGrill/themegrill-qa" .github/workflows/
```
