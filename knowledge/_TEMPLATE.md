# <Product Name>

<!--
This file is the highest-value asset in the repo. It is what stops the agent
rediscovering the product on every run, and it is what turns a generic browser
agent into one that knows your product.

Rules for maintaining it:
  - Every confirmed bug adds a line to "Known-fragile areas".
  - Every false positive the agent reports adds a line to "Known non-issues".
  - Keep it factual. Do not write aspirations here; write how it behaves today.
  - If a section is unverified, mark it TODO rather than guessing. The agent
    trusts this file, so a wrong line here produces confidently wrong QA.
-->

- **Slug:** `<text-domain>`
- **Type:** theme | plugin
- **Repo:** <org/repo>
- **Pro companion:** <org/repo-pro> or "none"
- **Jira project key:** <KEY>
- **Supported:** WP <min>+ · PHP <min>+
- **Companion plugins required for full function:** <e.g. demo importer>

## What it is, in two sentences

<Plain description. What a customer buys it for. What the main screen looks like.>

## Critical flows

Ordered by what would hurt most if it broke. The agent tests these first.

1. **<Flow name>** — <entry point> → <steps> → <observable success condition>
2. ...

## Admin surfaces

| Surface | Where | Notes |
|---|---|---|
| <Settings page> | `<admin URL path>` | <what it controls> |

## Frontend surfaces

<Templates / blocks / shortcodes the product renders, and how to reach each one.>

## Roles and capabilities

| Role | Should be able to | Must NOT be able to |
|---|---|---|
| Administrator | | |
| Editor | | |
| Subscriber | | |
| Logged out | | |

## Integrations

<Each one, plus how to tell at a glance whether it is working.>

## Data model / persistence

<Where settings live: option names, theme mods, post meta, custom tables.
The agent needs this to check that a save actually persisted.>

## Upgrade paths that matter

<Version transitions with migrations. What data must survive. How to seed the
old shape for testing.>

## Known-fragile areas

<Where bugs keep coming from. Be specific. This directs exploration.>

## Known non-issues

<Behaviour that looks like a bug and is not. Prevents repeat false positives.
Include a one-line reason for each.>

## Environment notes

<Anything unusual: needs networking, needs a license, breaks under SQLite,
requires a specific companion plugin, etc.>
