# Install

**Nobody installs anything.** An organisation owner deploys the plugin once and
it reaches every developer's Claude Code on their next restart.

That is the whole story for the team. The rest of this document is for the owner
doing the deploy, and for whoever works on the tooling itself.

---

## The developer's experience

1. Restart Claude Code.
2. Run `/themegrill-qa:verify-fix` in a product checkout.

**The commands are namespaced.** Plugin skills always are, so it is
`/themegrill-qa:verify-fix`, not `/verify-fix`. This is the most likely day-one
support question — say it in the announcement.

Two things they do need per product, once, and neither involves this repo:

```bash
pnpm install
pnpm exec playwright install chromium
```

and a gitignored `.themegrill-qa/.env.local` pointing at their own site:

```
TGQA_BASE_URL=http://test-colormag.local
CM_ADMIN_USER=admin
CM_ADMIN_PASS=password
```

---

## Deploying it — organisation owner, once

### 1. Decide public or private first

Every developer's Claude Code **clones the marketplace repo with their own git
credentials**. If this repo is private, each of them needs GitHub access to it
before the plugin will load — and CI needs a `QA_REPO_TOKEN` on top of that.

There are no keys and no customer data in here. Making it public removes both
problems. If you keep it private, confirm both settings now:

- **Settings → Actions → General → Access** → *"Accessible from repositories in
  the organization"*, or the CI `uses:` line cannot resolve at all
- An org secret `QA_REPO_TOKEN` with `contents: read` on this repo

### 2. Version the release

```json
// .claude-plugin/marketplace.json
"version": "0.2.0"
```

**This is the only thing that triggers an update.** `plugin.json` deliberately
carries no version — a version there would *win* over the marketplace entry and
pin the plugin, so updates would stop reaching people. `claude plugin validate`
warns about the missing version every time; that warning is correct, and
silencing it moves release control to a file nobody bumps.

### 3. Validate

```bash
claude plugin validate .
claude plugin validate ./plugins/themegrill-qa
```

One warning about the missing version is expected. Do not run `--strict` here —
it treats that warning as an error, and it only matters for submissions to
Anthropic's public community marketplace, which this is not.

### 4. Deploy through claude.ai

**claude.ai → Admin Settings → Claude Code → Managed settings.** Fetched at
startup and polled hourly, so it reaches everyone without touching a machine.

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

`autoUpdate: true` is what stops you chasing people to update later.

This installs at **managed scope**: developers cannot disable or uninstall it.

> **Not on a claude.ai Team or Enterprise plan?** Deploy the same JSON as
> `managed-settings.json` via MDM — `/Library/Application Support/ClaudeCode/`
> on macOS, `C:\Program Files\ClaudeCode\` on Windows.

### 5. Verify on one machine before rolling on

```
/status
```

The **Setting sources** line must read `Enterprise managed settings (remote)`. If
that line is missing, no managed source was found and nothing else is true.

```
/plugin
```

`themegrill-qa` should appear under **managed** scope. Then confirm
`/themegrill-qa:verify-fix` resolves.

### 6. Shipping updates

Edit → commit → **bump `version` in `marketplace.json`** → push. Developers pick
it up within the hour or at next launch. Forget the bump and nobody gets it.

---

## What the plugin contains

```
plugins/themegrill-qa/
├── .claude-plugin/plugin.json
├── skills/          the six commands
├── scripts/         the Node helpers the skills invoke
├── hooks/           the spec-guard Stop hook
└── blueprints/      seeded WordPress state
```

Scripts and blueprints ship **inside** the plugin deliberately: Claude Code
copies a plugin into its own cache, and a copied plugin cannot reach files
outside its own directory. The skills resolve their location through
`CLAUDE_PLUGIN_ROOT`, and `boot-wp.mjs` resolves the plugin root from its own
file path — so it behaves identically from the plugin cache or a CI checkout.

The `spec-guard` Stop hook is registered automatically through the plugin's
`hooks/hooks.json`. One thing worth knowing before you judge whether it works:
**on exit 0 a hook's stderr goes to the debug log, not the terminal.** The
visible signal is `.themegrill-qa/spec-queue.jsonl` appearing in `git status`.

---

## CI installs nothing either

The reusable workflows check this repository out at run time. Product repos gain
no dependency and commit nothing beyond their own caller workflow and their
`.themegrill-qa/` directory.

---

## Working on the tooling itself

Not for the team — for whoever changes the skills or scripts.

```bash
git clone git@github.com:ThemeGrill/themegrill-qa.git
cd themegrill-qa
npm run dev          # claude --plugin-dir ./plugins/themegrill-qa
```

`--plugin-dir` loads your working copy directly, and **takes precedence over the
installed marketplace plugin for that session** — so you can test changes without
uninstalling anything. `/reload-plugins` picks up edits without a restart.

> **Never symlink skills into `~/.claude/skills`.** A skill there is
> *unnamespaced* and **wins over the plugin's copy**, so you end up with both
> `/verify-fix` (your stale local copy) and `/themegrill-qa:verify-fix` (the real
> one) and no indication which just ran. That is how someone runs a months-old
> skill for weeks without noticing. This repo used to ship an `install.mjs` that
> did exactly that; it has been removed.

Run the scripts directly from the checkout when you need them:

```bash
npm run suite:index      # what the suite covers
npm run cost:projection  # the declining-spend curve
npm run check            # every .mjs parses
```

## Pro products — four extra setup steps

Only needed for the **pro** repos (ColorMag Pro, Zakra Pro, User Registration
Pro, Everest Forms Pro). The free repos need none of this. Full detail and the
reasoning is in [PRO.md](PRO.md) §4; these are the steps themselves, numbered
because every one of them has cost someone an afternoon.

1. **A dedicated QA licence key per product** — not the company key. Revocable
   without disturbing a customer or a colleague.

2. **An org-owned GitHub App, Contents: read-only**, installed on the pro repos
   only. `secrets.GITHUB_TOKEN` is scoped to the repository running the workflow
   and **cannot** check out another private repo — it fails with a 404 that reads
   exactly like "no such repository".

3. **Set every secret per repository.** Organisation secrets are not accessible
   to private repositories on GitHub Free, so `TGQA_APP_ID`,
   `TGQA_APP_PRIVATE_KEY` and the product's `TGQA_LICENSE_*` must exist in each
   repo separately:

   ```sh
   node plugins/themegrill-qa/scripts/sync-secrets.mjs --audit
   node plugins/themegrill-qa/scripts/sync-secrets.mjs --confirm
   ```

4. **themegrill-qa → Settings → Actions → General → Access →
   "Accessible from repositories in the ThemeGrill organization".**
   Without this every caller workflow fails with **"workflow was not found"**,
   which reads like a typo in the `uses:` path and is not. This is a setting, not
   a plan restriction — reusable workflows in a private repo do work on Free.

Then install the pre-commit licence-key guard in every repo that holds a key:

```sh
node plugins/themegrill-qa/scripts/install-git-hook.mjs
```
