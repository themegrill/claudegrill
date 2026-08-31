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

Two things they need per product, once, and neither involves this repo:

```bash
pnpm install
pnpm exec playwright install chromium
```

and a gitignored `.themegrill-qa/.env.local` pointing at their own site:

```
TGQA_BASE_URL=http://test-colormag.local
CMP_ADMIN_USER=admin
CMP_ADMIN_PASS=password
```

The admin variable names come from the product's own `suite.json` (`env.admin_user`
and `env.admin_pass`) — ColorMag uses `CM_*`, ColorMag Pro `CMP_*`. `TGQA_ADMIN_USER`
and `TGQA_ADMIN_PASS` work everywhere as a fallback.

**On a pro product, add the licence key to the same file** and nothing else:

```
TGQA_LICENSE_COLORMAG_PRO=...
```

`run-suite.mjs --pro` installs its own licence probe into the site's
`mu-plugins/`, reads the result, and removes it again. There is no probe to set
up by hand, per product or otherwise.

---

## Deploying it — organisation owner, once

### 1. Public or private

**This repo is public,** and that is the intended state: there are no keys and no
customer data in it. Public removes three recurring problems at once — CI needs
no `QA_REPO_TOKEN`, reusable workflows are callable with no Access setting, and
developers need no individual git access for the plugin to load.

If it is ever made private again, all three come back, and both of these have to
be set: **Settings → Actions → General → Access** → *"Accessible from
repositories in the organization"*, and an org secret `QA_REPO_TOKEN` with
`contents: read`.

### 2. Version the release

```json
// .claude-plugin/marketplace.json
"version": "0.4.0"
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

## Pro products — one secret each

Only for the **pro** repos (ColorMag Pro, Zakra Pro, User Registration Pro,
Everest Forms Pro). Free repos need none of it. The reasoning is in
[PRO.md](PRO.md) §4.

1. **A dedicated QA licence key per product** — not the company key. Revocable
   without disturbing a customer or a colleague.

2. **Set it as a secret in that pro repo**, named `TGQA_LICENSE_<PRODUCT>`.
   Organisation secrets are not accessible to private repositories on GitHub
   Free, so it has to be per-repo:

   ```sh
   node plugins/themegrill-qa/scripts/sync-secrets.mjs --audit    # what is missing where
   node plugins/themegrill-qa/scripts/sync-secrets.mjs --confirm  # set them
   ```

That is the whole list — four secrets across four repos, and nothing in the free
repos. No GitHub App is involved: `qa-pro.yml` lives in the pro repo, so the pro
code under test is the caller's own checkout, and the free product it extends is
public.

Then install the pre-commit licence-key guard in every repo that holds a key:

```sh
node plugins/themegrill-qa/scripts/install-git-hook.mjs
```

---

## What the plugin contains

```
plugins/themegrill-qa/
├── .claude-plugin/plugin.json
├── skills/          the six commands
├── scripts/         the Node helpers the skills invoke
├── mu-plugins/      QA-only, mounted into the test site, never shipped
├── hooks/           the spec-guard Stop hook
└── blueprints/      seeded WordPress state
```

Scripts, mu-plugins and blueprints ship **inside** the plugin deliberately:
Claude Code copies a plugin into its own cache, and a copied plugin cannot reach
files outside its own directory. The skills resolve their location through
`CLAUDE_PLUGIN_ROOT`, and the scripts resolve the plugin root from their own file
path — so they behave identically from the plugin cache or a CI checkout.

The `spec-guard` Stop hook is registered automatically through the plugin's
`hooks/hooks.json`. One thing worth knowing before you judge whether it works:
**on exit 0 a hook's stderr goes to the debug log, not the terminal.** The
visible signal is `.themegrill-qa/spec-queue.jsonl` appearing in `git status`.

**Do not add a `hooks` field to `plugin.json`.** The standard `hooks/hooks.json`
is discovered automatically; naming it in the manifest as well registers it twice
and fails the **entire plugin load** with "Duplicate hooks file detected". This
cost a release once.

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
> skill for weeks without noticing.

Run the scripts directly from the checkout when you need them:

```bash
npm run suite:index      # what the suite covers
npm run check            # every .mjs parses
```
