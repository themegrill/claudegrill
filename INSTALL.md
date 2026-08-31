# Installing the plugin

**How the claudegrill plugin reaches the team.** One organisation owner does
this once; nobody else installs anything.

This file is only about the plugin and its marketplace. **Setting a product up
is [SETUP.md](SETUP.md)** — that is a different job, done per product, by the
developer who works on it.

---

## What a developer does

1. Restart Claude Code.
2. Run `/claudegrill:setup` once per product.
3. Run `/claudegrill:write-fix` and `/claudegrill:verify-fix` as they work.

**The commands are namespaced.** Plugin skills always are, so it is
`/claudegrill:setup`, not `/setup`. This is the most likely day-one support
question — say it in the announcement.

Everything else a developer needs — what `setup` asks for, credentials, licence
keys, the CI workflow — is in [SETUP.md](SETUP.md). Nothing on this page is
their concern.

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
claude plugin validate ./plugins/claudegrill
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
      "source": { "source": "github", "repo": "ThemeGrill/claudegrill" },
      "autoUpdate": true
    }
  },
  "enabledPlugins": { "claudegrill@themegrill": true }
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

`claudegrill` should appear under **managed** scope. Then confirm
`/claudegrill:verify-fix` resolves.

### 6. Shipping updates

Edit → commit → **bump `version` in `marketplace.json`** → push. Developers pick
it up within the hour or at next launch. Forget the bump and nobody gets it.

---


## What the plugin contains


```
plugins/claudegrill/
├── .claude-plugin/plugin.json
├── skills/          the entry points, plus the house PHP standard
├── scripts/         the Node helpers the skills invoke
├── templates/       the CI workflows `setup` writes into a product repo
├── mu-plugins/      QA-only, mounted into the test site, never shipped
├── hooks/           the spec-guard Stop hook
└── blueprints/      seeded WordPress state
```

Scripts, templates, mu-plugins and blueprints ship **inside** the plugin
deliberately:
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
git clone git@github.com:ThemeGrill/claudegrill.git
cd claudegrill
npm run dev          # claude --plugin-dir ./plugins/claudegrill
```

`--plugin-dir` loads your working copy directly, and **takes precedence over the
installed marketplace plugin for that session** — so you can test changes without
uninstalling anything. `/reload-plugins` picks up edits without a restart.

> **Never symlink skills into `~/.claude/skills`.** A skill there is
> *unnamespaced* and **wins over the plugin's copy**, so you end up with both
> `/verify-fix` (your stale local copy) and `/claudegrill:verify-fix` (the real
> one) and no indication which just ran. That is how someone runs a months-old
> skill for weeks without noticing.

Run the scripts directly from the checkout when you need them:

```bash
npm run suite:index      # what the suite covers
npm run check            # every .mjs parses
```

---

## Checklist — the organisation owner's half

- [ ] Public/private decided; token and Access settings done if private
- [ ] Marketplace version bumped, plugin validated
- [ ] Managed settings deployed; `/status` verified on one machine
- [ ] Team told about the `/claudegrill:` prefix

---

## Next

The plugin being installed does nothing on its own. Each product still has to be
set up once — see **[SETUP.md](SETUP.md)**, which is one command.
