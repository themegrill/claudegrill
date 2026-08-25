# Who installs what

**Most developers install nothing.** The PR reviewer runs in GitHub Actions, so
every developer gets QA on their pull requests without touching their machine.

A local install is only for the optional `/verify-fix` command — checking a fix
on your own machine before pushing. That is useful to whoever fixes bugs, which
is probably two or three people to begin with, not the whole team.

So the honest answer to "does every developer need to clone this?" is **no**.
Install it for the people who will use it, and add more later.

---

## Which route, and when

**Right now: the clone.** While the skills are still changing week to week, a
clone with symlinks means an edit takes effect on the next run. The plugin
routes copy the skills into a cache, so every change would need a commit, a
version bump and an update — friction on exactly the loop you are in.

Switch to the plugin **when both** of these are true, not before:

- the skills have stopped changing weekly, and
- more than about three people want `/verify-fix` on their own machine.

Until then the plugin manifests sit in the repo doing nothing, which costs
nothing. Do not delete them; you will want them later.

---

### Now — git clone

```
git clone git@github.com:ThemeGrill/themegrill-qa.git
cd themegrill-qa
node install.mjs
```

Links the six skills into `~/.claude/skills` (junctions on Windows, so no
administrator rights) and sets `THEMEGRILL_QA_HOME`. Update with `git pull` — and
re-run `node install.mjs` if it reported that it had to copy rather than link.

Note the precedence: **a skill in `~/.claude/skills` wins over a plugin's copy.**
That is what makes this route right for developing the tooling, and it also means
you can adopt a plugin route later without this install fighting it.

#### The spec-guard hook is opt-in on this route

The plugin routes below register the `spec-guard` hook automatically, through the
plugin's own `hooks/hooks.json`. A clone does not — Claude Code only reads that
file for installed plugins — so add it by hand if you want it, in
`~/.claude/settings.json` or a project's `.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"$THEMEGRILL_QA_HOME/plugins/themegrill-qa/hooks/spec-guard.mjs\"",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

**Deliberately opt-in.** It runs at the end of every turn, and a hook somebody
did not ask for is a hook they disable — along with everything else you later
want to put on that event.

What it does: if the repo has a `.themegrill-qa/suite.json`, and this session
changed product source (`.php`, `.js`, `.ts`, `.scss`, `.css` outside `tests/`)
without touching the spec directory, it appends one `pending` record to
`.themegrill-qa/spec-queue.jsonl`. Once per branch, never twice. It never blocks
and it exits 0 on every failure path.

One thing worth knowing before you judge whether it is working: **on exit 0 a
hook's stderr goes to Claude Code's debug log, not to your terminal.** So the
one-line nudge shows up under `claude --debug`; the thing you will actually
notice is the queue file appearing in `git status`. That is the intended
mechanism — the queue is committed precisely so it is visible in the repo, and
`/write-spec` with no arguments drains the oldest entry.

---

### Later — plugin install, one command per person

```
/plugin marketplace add ThemeGrill/themegrill-qa
/plugin install themegrill-qa@themegrill
```

Both typed inside Claude Code. The repo is private, so this uses the developer's
existing git credentials — GitHub shorthand resolves over SSH, so anyone who can
already `git clone` your repos has what they need.

Updates: `/plugin update themegrill-qa@themegrill`. Claude Code also refreshes
marketplaces hourly and offers the update. One wrinkle: background refresh runs
`git pull` with credential helpers disabled, so **SSH remotes update silently and
HTTPS ones may not** — add the marketplace by shorthand rather than an `https://`
URL and the issue does not arise.

The real reason to get here eventually is version control over what the team
runs. With clones, everyone is on whatever they last pulled; a bad skill change
produces wrong QA verdicts across the team with no way to pin them back.

---

### Later still — managed settings, nobody installs anything

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

Every developer's Claude Code picks it up — no clone, no commands, no environment
variable, and an individual cannot disable it by accident. Worth doing when the
tooling is stable and you want it everywhere; not worth the dependency on an org
owner before then.

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

1. **Now:** you alone, cloned, so you can fix the tooling as you go.
2. **When the skills settle and a second or third person wants `/verify-fix`:**
   plugin install, one command each.
3. **When it is everywhere and stable:** managed settings, so nobody installs
   anything.
4. **Never:** copying the skills into each product repository. Seven divergent
   copies is the one arrangement that reliably rots.

Do not skip to 3. The plugin cache is the wrong place for code you are still
editing, and the setup cost of the earlier steps is minutes.
