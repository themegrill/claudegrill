#!/usr/bin/env python3
"""
Estimate what themegrill-qa costs to run, so the number comes from assumptions you can
argue with rather than from a vendor's guess.

    python3 scripts/estimate-cost.py
    python3 scripts/estimate-cost.py --products 7 --prs-per-month 40 --model sonnet-5

Every figure here is an ASSUMPTION. The two that dominate the result are
`avg_context_k` (how large the conversation gets, driven almost entirely by how
many page snapshots the agent takes) and how many PRs survive the triage filter.
Measure both in week one and replace the defaults.
"""

import argparse

# Published per-million-token prices. Cache write (1h) is 2x input; cache read
# is 0.1x input. See platform.claude.com/docs/en/about-claude/pricing
MODELS = {
    "haiku-4.5": (1.0, 5.0),
    "sonnet-5":  (2.0, 10.0),
    "sonnet-4.6":(3.0, 15.0),
    "opus-5":    (5.0, 25.0),
}

ACTIONS_PER_MIN_PRIVATE = 0.006   # Linux 2-core, private repo
ACTIONS_FREE_MIN_TEAM   = 3000


def agent_run_cost(model, base_k, final_k, turns, out_k):
    """
    Cost of one agentic run, accounting for prompt caching.

    Each turn re-reads the accumulated conversation (billed as a cache read at
    0.1x) and appends new content (billed as a cache write at 2x). Context grows
    roughly linearly as tool results accumulate, so average context over the run
    is taken as the midpoint.
    """
    inp, outp = MODELS[model]
    write_rate = inp * 2.0
    read_rate  = inp * 0.1

    avg_context_k = (base_k + final_k) / 2
    reads_m  = (turns * avg_context_k) / 1000
    writes_m = final_k / 1000          # everything ends up written once
    out_m    = out_k / 1000

    return reads_m * read_rate + writes_m * write_rate + out_m * outp


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--model", default="sonnet-5", choices=MODELS)
    p.add_argument("--products", type=int, default=7)
    p.add_argument("--prs-per-month", type=int, default=40,
                   help="per product, before triage filtering")
    p.add_argument("--triage-pass-rate", type=float, default=0.6,
                   help="share of PRs with functional changes worth a browser run")
    p.add_argument("--smoke-sweeps-per-month", type=float, default=4,
                   help="per product; fractional is fine (0.36 = ~2.5/month across 7)")
    p.add_argument("--full-sweeps-per-month", type=float, default=1,
                   help="per product; fractional is fine")
    p.add_argument("--releases-per-month-total", type=float, default=None,
                   help="release-driven mode: N full sweeps per month across the "
                        "WHOLE catalogue, no cron, no core watcher. Overrides the "
                        "two per-product sweep counts.")
    p.add_argument("--smoke-shards", type=int, default=6)
    p.add_argument("--full-shards", type=int, default=18)
    p.add_argument("--public-repos", action="store_true",
                   help="Actions minutes are free on public repos")
    a = p.parse_args()

    # --- per-run token shapes (the assumptions that matter) ---------------
    pr    = dict(base_k=25,  final_k=120, turns=40,  out_k=18)
    shard = dict(base_k=20,  final_k=200, turns=70,  out_k=25)
    recon = dict(base_k=40,  final_k=70,  turns=15,  out_k=12)

    # Release-driven mode: full sweeps happen only when a product ships, and you
    # ship 2-3 products a month — so spread that across the catalogue rather
    # than charging every product a monthly cadence it does not have.
    if a.releases_per_month_total is not None:
        a.full_sweeps_per_month  = a.releases_per_month_total / a.products
        a.smoke_sweeps_per_month = 0.0

    pr_cost    = agent_run_cost(a.model, **pr)
    shard_cost = agent_run_cost(a.model, **shard)
    recon_cost = agent_run_cost(a.model, **recon)

    smoke = a.smoke_shards * shard_cost + recon_cost
    full  = a.full_shards  * shard_cost + recon_cost

    print(f"model: {a.model}   (${MODELS[a.model][0]}/M in, ${MODELS[a.model][1]}/M out)")
    print("=" * 62)
    print(f"{'one PR review':<34} ${pr_cost:>7.2f}")
    print(f"{'one sweep shard':<34} ${shard_cost:>7.2f}")
    print(f"{'smoke sweep (' + str(a.smoke_shards) + ' shards + recon)':<34} ${smoke:>7.2f}")
    print(f"{'full sweep (' + str(a.full_shards) + ' shards + recon)':<34} ${full:>7.2f}")
    print()

    runs = a.prs_per_month * a.triage_pass_rate
    per_product = (runs * pr_cost
                   + a.smoke_sweeps_per_month * smoke
                   + a.full_sweeps_per_month * full)

    # Actions minutes: PR run ~12 min; each shard ~25 min; recon ~5 min.
    mins = (runs * 12
            + a.smoke_sweeps_per_month * (a.smoke_shards * 25 + 5)
            + a.full_sweeps_per_month  * (a.full_shards  * 25 + 5))
    ci = 0.0 if a.public_repos else mins * ACTIONS_PER_MIN_PRIVATE

    print(f"per product / month  ({runs:.0f} PR runs, "
          f"{a.smoke_sweeps_per_month:g} smoke, {a.full_sweeps_per_month:.2g} full)")
    print(f"{'  Claude':<34} ${per_product:>7.2f}")
    print(f"{'  Actions (' + f'{mins:,.0f} min' + ')':<34} ${ci:>7.2f}"
          + ("  [free — public repo]" if a.public_repos else ""))
    print(f"{'  subtotal':<34} ${per_product + ci:>7.2f}")
    print()
    total = (per_product + ci) * a.products
    print(f"{'ALL ' + str(a.products) + ' PRODUCTS / MONTH':<34} ${total:>7.2f}")
    print(f"{'annualised':<34} ${total * 12:>7.2f}")
    if not a.public_repos:
        print(f"\nnote: {ACTIONS_FREE_MIN_TEAM:,} Actions minutes/month are included on Team;"
              f"\n      you would use ~{mins * a.products:,.0f}.")
    print("\nThe lever that actually moves this number is not the model choice.")
    print("It is moving coverage from agent runs into committed Playwright specs,")
    print("which cost Actions minutes only. Every spec you accumulate permanently")
    print("removes work from the priced column.")


if __name__ == "__main__":
    main()
