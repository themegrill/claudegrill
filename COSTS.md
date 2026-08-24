# What this costs

Run `python3 scripts/estimate-cost.py` to recompute any of this with your own
assumptions. Every number below is modelled, not measured — see *Measure this
properly* at the end.

Prices used: Sonnet 5 at $2/M input, $10/M output; 1-hour cache write at 2×
input, cache read at 0.1×; GitHub Actions Linux 2-core at $0.006/min on private
repos, free on public ones.

## Per run

| Run | Cost |
|---|---|
| One PR review | **~$1.24** |
| One sweep shard | **~$2.59** |
| Smoke sweep (6 shards + reconcile) | **~$16** |
| Full sweep (18 shards + reconcile) | **~$47** |

Both workflows pass `--max-budget-usd`, so these are capped, not open-ended. Note
the cap **stops the run** when reached rather than failing — a cap set too tight
silently truncates coverage. That is why the shard default is $3.50 against a
modelled $2.59, and why the way to spend less is to shorten the area list rather
than tighten the cap.

## Per month

Assuming 40 PRs per product (60% surviving the triage filter), 4 smoke sweeps,
1 full sweep:

| | Per product | All 7 |
|---|---|---|
| Claude | $141 | **$990** |
| Actions (~1,363 min) | $8 | $57 |
| **Total** | **$149** | **~$1,047** |

Annualised at that shape: **~$12.5k**. Public repos remove the Actions line
entirely; a Team plan includes 3,000 minutes against the ~9,500 this would use.

## The thing the model got wrong until it was measured

I assumed PR reviews would dominate. They do not:

| | Share of cost |
|---|---|
| Exploratory sweeps | **79%** |
| PR reviews | 21% |

Dropping PR agent runs almost entirely only takes all-seven from $1,047 to $845.
So the accumulation argument applies to **sweeps**, not PRs — and it applies by
shrinking the *area list*, because every area genuinely covered by committed
specs is an area the sweep no longer has to explore.

| Spec coverage | Shards (smoke/full) | All 7 per month |
|---|---|---|
| Nothing covered — today | 6 / 18 | $990 |
| ~⅓ of areas covered | 4 / 12 | $736 |
| ~½ covered | 3 / 8 | $591 |
| Most covered, sweeps probe the frontier | 2 / 4 | **$446** |

That is the compounding curve, in currency. It bottoms out at roughly half of
today's cost while *increasing* coverage, because the specs keep running.

## Model choice is the smaller lever

All seven products per month:

| Model | Cost |
|---|---|
| Haiku 4.5 | $552 |
| **Sonnet 5** | **$1,047** |
| Sonnet 4.6 | $1,542 |
| Opus 5 | $2,531 |

Sonnet 5 is the default. Two things worth knowing: Sonnet 5 is *cheaper* than
Sonnet 4.6, so there is no reason to pin the older one; and Haiku is tempting on
price but browser-driving with adversarial reasoning is exactly the workload
where a weaker model produces false findings, which cost more in engineer-hours
than the difference saves. Consider Haiku for the reconcile step only, where the
input is already-verified text.

## Keeping the bill down

Already built in:

- **Triage step** — docs, translations and CI-only diffs never reach a browser.
- **Draft PRs skipped.**
- **`concurrency: cancel-in-progress`** — three pushes to a PR pay for one review.
- **`--max-budget-usd` and `--max-turns`** on every agent invocation.
- **Depth tiering** — patch releases get a smoke sweep, majors get the full one.
- **Shard cap** (`max_shards`) so a long area list cannot run away.
- **Chromium only**, not three browser engines.

Worth adding when volume justifies it: batch processing is 50% off, and sweeps
are asynchronous by nature, so a nightly batched sweep is a genuine halving.

## Measure this properly

The two assumptions that dominate everything above are how large the
conversation grows (driven almost entirely by how many page snapshots the agent
takes) and what share of PRs survive triage. Both are cheap to measure and
neither should be taken from a model.

In week one, run one product only and read the actual numbers:

- `claude -p --output-format json` returns `total_cost_usd`.
- `claude-code-action` exposes an `execution_file` output; its contents are not
  documented, so inspect one before relying on parsing it.
- Org-level spend is visible on the Claude Console usage dashboard.

Then edit the token shapes at the top of `estimate-cost.py` and re-run it. If
real costs come in more than about 2× the model, the cause is almost certainly
snapshot size — tighten the mission scope per shard before anything else.
