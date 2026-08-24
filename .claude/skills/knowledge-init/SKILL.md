---
name: knowledge-init
description: Draft a product's QA knowledge file from its source, for a human to correct
argument-hint: "[path to an existing code knowledge base, if you have one]"
allowed-tools: Bash, Read, Grep, Glob
pass-arguments: true
---

# Bootstrap a QA knowledge file

Produces a **draft** of `.themegrill-qa/knowledge.md` by reading the product's source.
The draft is a starting point that saves an hour of blank-page work. It is not
the finished file, and it must not be committed as if it were.

`$ARGUMENTS` may be a path to an existing generated code knowledge base — use it
as an additional input if given.

## Three inputs, three different jobs

| Input | Gives you | How to get it |
|---|---|---|
| **Source** | Structure — settings pages, option keys, capabilities, hooks, routes | the greps below |
| **Docs** | Intent — what each setting is *for*, the flows, expected outcomes | `scripts/ingest-docs.mjs` |
| **Git history** | Fragility — where bugs keep coming from | `git log` mining |

Only two things are then left for a human: which flows matter *most*, and the
known-non-issues list. That is a 30-minute conversation, not an afternoon.

**Run the docs ingest first if the product has a docs site.** It is the single
highest-value input, because expected behaviour is the one thing source cannot
tell you and the thing the agents most need:

```bash
node scripts/ingest-docs.mjs https://docs.<product>.com/sitemap.xml --out .themegrill-qa
```

That writes `.themegrill-qa/docs/<section>.md` plus `.themegrill-qa/docs-index.json`. Two things
in there matter especially:

- **The "Stated outcomes" block** in each section file. Every line is a sentence
  where the docs promise a specific result — "non-members will see the
  restriction message instead of the content". Each is a ready-made assertion,
  phrased by the product owner. Lift these into the knowledge file's expected-
  behaviour sections almost verbatim, with the doc URL attached.
- **`suggested_areas`** in the index. Doc sections are a human-authored
  decomposition of the product, which is exactly what the sweep shards on. Use
  it as the `areas_json` starting point rather than inventing an area list.

Docs describe the happy path, so they give you *correct* behaviour, not
boundaries. Adversarial missions still come from the attack patterns in the
`regression-sweep` skill. And docs go stale — see **Doc drift** below, which
turns that liability into a useful signal.

## Still not an answer

Even with all three inputs, mark anything you inferred rather than read as
`TODO`. The agents trust this file, so a confident guess about intended behaviour
produces confident wrong QA. Say plainly in your summary which sections a human
still needs to supply.

## Step 1 — Read the product

```bash
scripts/detect-product.mjs
```

Then gather, with evidence for each finding:

**Settings surfaces**
```bash
grep -rn "add_menu_page\|add_submenu_page\|add_options_page\|add_theme_page" --include=*.php .
grep -rn "register_setting\|add_settings_field" --include=*.php .
grep -rn "\$wp_customize->add_section\|add_setting\|add_control" --include=*.php .
```

**Persistence** — the agents need this to verify a save actually stuck
```bash
grep -rno "get_option(\s*['\"][a-z0-9_-]*" --include=*.php . | sort -u
grep -rno "get_theme_mod(\s*['\"][a-z0-9_-]*" --include=*.php . | sort -u
grep -rn "get_post_meta\|update_post_meta" --include=*.php . | head -40
grep -rn "CREATE TABLE\|dbDelta" --include=*.php .
```

**Capability boundaries** — the basis of the roles table
```bash
grep -rn "current_user_can\|check_admin_referer\|wp_verify_nonce" --include=*.php . | head -60
```

**Entry points and surfaces**
```bash
grep -rn "register_post_type\|register_taxonomy\|add_shortcode" --include=*.php .
grep -rn "register_rest_route" --include=*.php .
grep -rn "wp_ajax_\|admin-ajax" --include=*.php . | head -40
grep -rn "registerBlockType" --include=*.js --include=*.jsx --include=*.json . | head -30
```

**Migrations** — the highest-value section, and the one most often missing
```bash
grep -rn "version_compare\|db_version\|upgrade_routine\|_upgrade_" --include=*.php .
git log --oneline --all -- '*upgrade*' '*migrat*' | head -30
```

**Supported versions** — from the plugin/theme header and `readme.txt`

If a generated code knowledge base was supplied, use it to resolve structure
faster — but verify anything you take from it against the source. A generated KB
describes how the code is arranged, not what the product promises a user.

## Step 2 — Mine history for the fragile-areas section

This is the part that makes the file worth more than a source dump:

```bash
git log --oneline -400 | grep -iE "fix|bug|hotfix|regress|revert" | head -80
git log --oneline -400 --diff-filter=M --name-only | sort | uniq -c | sort -rn | head -25
```

Files that appear repeatedly in fix commits are your fragile areas, evidenced
rather than guessed. Cite the commits.

Read `readme.txt` / `CHANGELOG.md` too: an entry that says "fixed X again" is
telling you X is structurally fragile, not that it was fixed twice.

## Step 3 — Write the draft

Fill `knowledge/_TEMPLATE.md` and write it to `.themegrill-qa/knowledge.md`.

Rules for the draft:

- Every derived fact gets its source: `` `colormag_header_layout` (inc/customizer/header.php:42) ``.
- Every non-derivable claim is `TODO`, never a plausible guess. Specifically:
  **critical-flow ordering**, **expected behaviour**, **known non-issues**, and
  **what must survive an upgrade** are human sections. Leave them empty with a
  note on what the human needs to supply.
- Critical flows may be *proposed* from the surfaces you found, but label the
  list `TODO: confirm ordering` — you can see what exists, not what matters.
- Do not pad. A short accurate file beats a long speculative one.

## Step 4 — Hand it over honestly

End with a summary in this shape:

```
Drafted .themegrill-qa/knowledge.md for <product>

Derived from source (verify, but should be broadly right)
  - 14 customizer sections, 61 settings
  - 9 option keys, 3 theme-mod groups
  - 4 capability checks guarding admin surfaces
  - 2 upgrade routines (3.x→4.0, 4.0→4.1)

Evidenced from git history
  - fragile: inc/customizer/header.php (11 fix commits), demo-importer (8)

NEEDS A HUMAN — the agents will be wrong until these are filled in
  - critical-flow ordering: proposed, unconfirmed
  - expected behaviour for <n> flows
  - known non-issues: empty
  - upgrade: what must survive is unknown

Suggested next step: 30 minutes with whoever knows <product> best, on the
four items above. Everything else can be corrected as it comes up.
```

## Doc drift is a feature, not a problem

The obvious objection to using docs as the intent source is that docs go stale —
an article written for 3.x describing a settings screen that moved in 4.0 will
send an agent hunting for something that no longer exists.

Treat that as an output rather than a defect. If the docs say a control exists
and the product does not have it, exactly one of two things is true:

- the docs are stale — a **documentation bug**, worth a ticket, because customers
  are reading it and filing support requests; or
- the feature regressed or was removed without the docs being updated — a
  **product bug**, worth a bigger ticket.

Either way it is a real finding that nothing else in the pipeline would catch,
and it comes free with the ingest. Record every mismatch as
`DOC DRIFT: <doc url> says X, product does Y` and let a human decide which side
is wrong. Do not guess which one it is.

This makes the docs a de-facto specification, which also means the ingest should
be re-run when a product ships — a version's docs are part of its release.

## Rules

- **Never commit this yourself.** Leave it for review. A knowledge file that
  entered the repo without a human reading it is a liability.
- Do not delete or overwrite an existing `.themegrill-qa/knowledge.md`. If one is there,
  write `.themegrill-qa/knowledge.draft.md` beside it and report the differences.
- If the product is large, cover breadth over depth — every surface named once
  beats three surfaces documented exhaustively.
