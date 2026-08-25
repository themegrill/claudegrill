# Paste this into Claude Code

Open Claude Code **in your `themegrill-qa` repository** and paste everything
below the line. You will need `themegrill-qa-history.bundle` on disk — put it
somewhere easy like `~/Downloads/`.

---

Update this repository to the current version of themegrill-qa, using the git
bundle I have downloaded. Work carefully and stop rather than guess.

## What you are doing

This repo was created by extracting a zip and committing it as a single import
commit. Several versions have been released since. The bundle contains the
complete, current history. Your job is to bring the working tree to that state
without losing my commits and without leaving superseded files behind.

## Step 1 — Locate the bundle and confirm where you are

Find `themegrill-qa-history.bundle`. Look in `~/Downloads`, `~/Desktop`, the
repository root, and its parent. If you cannot find it, ask me for the path and
stop — do not attempt the migration without it.

Then confirm this is the right repository: it must be a git repo whose tracked
files include `CLAUDE.md` and either `scripts/` or `plugins/themegrill-qa/`. If
it is not, say so and stop.

Verify the bundle before trusting it:

```
git bundle verify <path-to-bundle>
```

It should report a complete history. If it does not, stop.

## Step 2 — Refuse to proceed on a dirty tree

Run `git status --short`. If there is **anything** uncommitted — modified,
staged, or untracked files I might care about — stop and show me the list. Ask
whether to commit, stash, or abandon them. Do not decide for me.

`.themegrill-qa/.docs-cache/` and `node_modules/` are safe to ignore if present.

## Step 3 — Tell me which version I am on

Report which of these the repo currently matches, most advanced first:

- **E** — `plugins/themegrill-qa/skills/` exists → already current, stop here and
  tell me so
- **D** — `scripts/detect-product.mjs` exists → Node port, pre-plugin
- **C** — `SETUP-COLORMAG.md` exists → REST docs ingestion added
- **B** — `STORAGE.md` or `CONVENTIONS.md` exists → storage / conventions added
- **A** — `scripts/detect-product.sh` exists → original scaffold, bash and Python

## Step 4 — Make a safety branch

```
git branch pre-migration-backup
```

Tell me it exists. If anything goes wrong later I want to be able to run
`git reset --hard pre-migration-backup`.

## Step 5 — Migrate

```
git remote add tgqa-upstream <path-to-bundle>
git fetch tgqa-upstream
git log --oneline tgqa-upstream/main
```

Show me that log. Then:

```
git read-tree -u --reset tgqa-upstream/main
```

**Use `read-tree -u --reset`, not `git checkout tgqa-upstream/main -- .`.** The
checkout form adds and updates files but never deletes the ones that were
removed, which would leave the old `.sh` and `.py` scripts alongside their `.mjs`
replacements — two of everything, and a confusing failure later. `read-tree`
makes the tree match exactly, deletions included.

Then clean up the remote:

```
git remote remove tgqa-upstream
```

## Step 6 — Verify, and do not skip any of these

Run each and report the result:

1. `git status --short` — should show staged changes only, no surprises
2. `git ls-files --cached | grep -E '\.(sh|py)$'` — **must print nothing.** Note
   that `grep` exits with status 1 when it finds no match: that is the *success*
   case here, not a failed command. Only treat this as a problem if it actually
   prints filenames
3. `ls plugins/themegrill-qa/scripts` — must list exactly five `.mjs` files:
   `boot-wp`, `detect-product`, `estimate-cost`, `ingest-docs`, `ingest-testsuite`
4. `ls .claude-plugin/marketplace.json plugins/themegrill-qa/.claude-plugin/plugin.json`
   — both must exist
5. Confirm `scripts/`, `blueprints/` and `.claude/` no longer exist at the repo
   root — their contents moved inside `plugins/themegrill-qa/`
6. `npm run check` — every script must parse
7. `git log --oneline | tail -3` — my original import commit must still be there
8. `git ls-files --cached | wc -l` — should be around 41 files. Wildly fewer means
   something went wrong

If any of 1–8 fails, stop, report which, and do not commit.

## Step 7 — Commit

Only once every check above passed:

```
git commit -m "Update to Node-only plugin layout

Adopts the current themegrill-qa structure: all scripts are Node with no
dependencies, and skills, scripts and blueprints move inside
plugins/themegrill-qa so they travel together as a Claude Code plugin."
```

Do **not** push. I will review and push myself.

## Step 8 — One thing that needs my input

Check whether the repo is named as I actually pushed it:

```
grep -rn "ThemeGrill/themegrill-qa" .github/workflows/
```

That should find five references across four files — three `repository:` lines in
the two reusable workflows, and two `uses:` lines in the caller examples. If my
remote (`git remote -v`) shows a different org or repo name, tell me the exact
lines that need changing and what to change them to — but ask before editing,
since I may have deliberately used a different name.

## Step 9 — Report

Finish with a short summary:

- version I was on, and what I am on now
- number of files added, modified, deleted
- each verification check and whether it passed
- anything you noticed that I should look at
- the exact command to undo it all if I change my mind

## Rules

- **Never `push`**, never `--force`, never `reset --hard` outside of an undo I
  explicitly ask for.
- Never delete the `pre-migration-backup` branch.
- If any command produces output you did not expect, stop and show me rather than
  working around it.
- Do not "helpfully" fix unrelated things you notice in the repo. Report them
  instead; this task is the migration only.
- If you cannot complete a step, leave the repo in a state where
  `git reset --hard pre-migration-backup` restores it, and say so plainly.
