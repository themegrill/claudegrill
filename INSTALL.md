# Who installs what

**Most developers install nothing.** The PR reviewer runs in GitHub Actions, so
every developer gets QA on their pull requests without touching their machine.

A local install is only for the optional `/verify-fix` command — checking a fix
on your own machine before pushing. That is useful to whoever fixes bugs, which
is probably two or three people to begin with, not the whole team.

So the honest answer to "does every developer need to clone this?" is **no**.
Install it for the people who will use it, and add more later.

---

## Three routes, in order of preference

### A. Managed settings — nobody installs anything · recommended

An organisation owner adds this once in **claude.ai → Admin Settings → Claude
Code → Managed settings**:

```json
{
  "extraKnownMarketplaces": {
    "themegrill": {
      "source": { "source": "github", "repo": "ThemeGrill/themegrill-qa" }
    }
  },
  "enabledPlugins": {
    "themegrill-qa@themegrill": true
  }
}
```

Every developer's Claude Code picks it up automatically. No clone, no commands,
no environment variables, and managed settings cannot be accidentally disabled by
an individual. Updates arrive when you bump the version in
`.claude-plugin/marketplace.json`.

This is the right answer for a team of any size, and it is one person's five
minute job.

### B. Plugin install — one command per person

If you would rather not use managed settings, or want to pilot with two people
first:

```
/plugin marketplace add ThemeGrill/themegrill-qa
/plugin install themegrill-qa@themegrill
```

Both are typed inside Claude Code. The marketplace repo is private, so this uses
the developer's existing git credentials — GitHub shorthand resolves over SSH, so
anyone with a working `git clone` of your repos already has what they need.

Updates: `/plugin update themegrill-qa@themegrill`. Claude Code also refreshes
marketplaces hourly in the background and will offer the update.

One wrinkle worth knowing: background refresh runs `git pull` with credential
helpers disabled, so **SSH remotes update silently and HTTPS ones may not**.
Adding the marketplace by shorthand (`ThemeGrill/themegrill-qa`) rather than an
`https://` URL avoids the issue.

### C. Git clone — the fallback

Only if plugins are unavailable to you, or you are developing the QA tooling
itself and want to edit skills and see the change immediately:

```
git clone git@github.com:ThemeGrill/themegrill-qa.git
cd themegrill-qa
node install.mjs
```

`install.mjs` links the five skills into `~/.claude/skills` (junctions on
Windows, so no administrator rights needed) and sets `THEMEGRILL_QA_HOME`. Update
with `git pull` — and re-run `node install.mjs` if it reported that it had to
copy rather than link.

**Precedence matters here:** a skill in `~/.claude/skills` wins over the plugin's
copy. That is what makes route C useful for development, and also means you
should not mix C with A or B on the same machine unless you intend the local copy
to override.

---

## What the plugin contains

```
plugins/themegrill-qa/
├── .claude-plugin/plugin.json
├── skills/          the five commands
├── scripts/         the Node helpers the skills invoke
└── blueprints/      seeded WordPress state
```

Scripts and blueprints ship **inside** the plugin deliberately. Claude Code
copies a plugin into its own cache on install, and a copied plugin cannot reach
files outside its directory — so anything the skills need has to travel with
them. The skills resolve their own location through `CLAUDE_PLUGIN_ROOT`, and
`boot-wp.mjs` resolves the plugin root from its own file path, which means it
works identically from the plugin cache, a git clone, or a CI checkout.

That is also why there is no `THEMEGRILL_QA_HOME` requirement on routes A and B.
It exists only for route C.

---

## CI installs nothing either

The reusable workflows check out this repository at run time and copy the
plugin's `skills/`, `scripts/` and `blueprints/` into the runner for the duration
of the job. Product repositories gain no dependency and nothing is committed to
them beyond their own caller workflow and knowledge file.

---

## Recommended rollout

1. **Now:** you alone, route C, so you can fix the tooling as you go.
2. **After `/verify-fix` earns its keep:** route A for the whole org, which
   costs one settings change and gives everyone the command with no setup.
3. **Never:** copying the skills into each product repository. Seven divergent
   copies is the one arrangement that reliably rots.
