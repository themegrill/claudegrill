# What this costs

**The short answer: the pull-request path costs nothing.** No API key, no tokens,
no per-run charge. The only recurring spend is a developer's existing Claude Code
seat, which you are already paying for.

That is a deliberate design change, not an accident of configuration. An earlier
version of this platform ran an agent on every pull request and modelled out at
roughly **$1,000/month across seven products**. That model is gone. What replaced
it is in [SUITE.md](SUITE.md): the developer writes the spec once, CI runs it
deterministically forever.

Recompute any number here with your own assumptions:

```bash
node plugins/themegrill-qa/scripts/estimate-cost.mjs
node plugins/themegrill-qa/scripts/estimate-cost.mjs --projection 24
```

Every figure below is **modelled, not measured**. See *Measure this properly* at
the end.

---

## What you actually pay for, today

| Layer | Runs | Cost |
|---|---|---|
| **CI suite on every PR** | `suite.yml`, scoped to the diff | **$0** — runner minutes only, free on a public repo |
| **Nightly full tier** | `suite.yml`, `scope: full` | **$0** — same |
| **`/themegrill-qa:verify-fix`** | a developer, locally, on a fix | the developer's own Claude Code seat |
| **`/themegrill-qa:write-spec`** | after a verified finding | same seat, same session |
| Regression sweeps | manual, on a release | API tokens — see below |
| Agent PR review | **off by default** | API tokens — see below |

`colormag` is public, so its Actions minutes are free. On a private repo the same
work is roughly **$0.006/min**; a scoped PR run is about 2 minutes and the
nightly full run about 5, so a busy product lands near **$1–2/month**.

### The local session, in tokens

The expensive layer is a developer reading output, not the suite running. Two
things keep that small, both verified against ColorMag's real suite:

- `run-suite.mjs --json` emits **one line, ~300 bytes, zero stderr**. Before that
  flag worked, ~2.5KB of Playwright progress went into context on every run.
- `--since` narrows a PR to the areas its diff touches — 4 areas instead of 21
  tests on a real CMAG-741 diff.

A `/themegrill-qa:verify-fix` run is a normal Claude Code session: reading a
diff, driving a browser, writing a verdict. It draws on the seat you already pay
for. Nothing in the local path bills the API.

---

## What it would cost to turn the agent tiers back on

Kept here because the tiers still exist in the repo, unused, and because a
product whose suite is still thin may want them.

Modelled on Sonnet 5 ($2/M input, $10/M output; 1-hour cache write at 2× input,
cache read at 0.1×):

| Run | Cost |
|---|---|
| One agent PR review | **~$1.24** |
| One sweep shard | **~$2.59** |
| Smoke sweep (6 shards + reconcile) | **~$16** |
| Full sweep (18 shards + reconcile) | **~$47** |

Turning the agent back on for **every** PR across seven products is the
~$1,000/month shape. Running only release sweeps, at 2.5 releases a month across
the catalogue, is about **$17/product/month — ~$118/month for all seven**.

Both agent workflows pass `--max-budget-usd`, so these are capped. Note the cap
**stops the run** rather than failing it: a cap set too tight silently truncates
coverage. That is why the shard default is $3.50 against a modelled $2.59, and
why the way to spend less is to shorten the area list rather than tighten the cap.

---

## Why the suite is the lever

An agent finding costs tokens on **every run, forever**. The same finding as a
committed spec costs tokens **once**, then runs for approximately free for the
life of the product.

```bash
node plugins/themegrill-qa/scripts/estimate-cost.mjs --projection 24
```

That prints the curve. It is the entire argument for the suite layer, and the
reason `suite-index.mjs` reports `areas_uncovered` — the list of areas where no
spec exists and an agent would still be the only option.

**The number that matters is coverage, not spend.** ColorMag currently has
**10 of 16 areas with no `@fresh` specs at all**. Spend is already near zero; the
open question is how much the free tier actually covers.

---

## Measure this properly

Every figure above is a model. Replace it with observation:

- **Token costs**: after a dozen real `/themegrill-qa:verify-fix` sessions, check
  actual usage and replace the per-run token shapes at the top of
  `estimate-cost.mjs`. They are estimates and are labelled as such in the source.
- **Runner minutes**: the Actions **Usage** tab on any run gives the real figure
  per job. Compare against the ~2 min scoped / ~5 min full assumed here.
- **Suite runtime**: measured on ColorMag — ~47s for 20 `@fresh` specs against a
  Local site, ~291s against a Playground site, ~35s scoped to two areas.

Do not treat the modelled numbers as a budget until at least the first of those
has been done.
