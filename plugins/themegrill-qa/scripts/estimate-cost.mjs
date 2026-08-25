#!/usr/bin/env node
/**
 * What this costs to run. Node, so no Python is needed anywhere in this repo.
 *
 *   node scripts/estimate-cost.mjs
 *   node scripts/estimate-cost.mjs --products 7 --releases-per-month-total 2.5
 *   node scripts/estimate-cost.mjs --products 1 --prs-per-month 20   # the pilot
 *
 * The per-run token shapes below are the assumptions that matter, and they are
 * estimates until you have measured real runs. Once the pilot has produced a
 * dozen runs, replace them with observed figures rather than trusting this.
 */

import process from "node:process";

// Published per-million-token prices. Cache write (1h) is 2x input; cache read
// is 0.1x input. See platform.claude.com/docs/en/about-claude/pricing
const MODELS = {
  "haiku-4.5": [1.0, 5.0],
  "sonnet-5": [2.0, 10.0],
  "sonnet-4.6": [3.0, 15.0],
  "opus-5": [5.0, 25.0],
};

const ACTIONS_PER_MIN_PRIVATE = 0.006; // Linux 2-core, private repo
const ACTIONS_FREE_MIN_TEAM = 3000;

/**
 * Cost of one agentic run, accounting for prompt caching.
 *
 * Each turn re-reads the accumulated conversation (billed as a cache read at
 * 0.1x) and appends new content (billed as a cache write at 2x). Context grows
 * roughly linearly as tool results pile up, so the average context over the run
 * is taken as the midpoint.
 */
function agentRunCost(model, { baseK, finalK, turns, outK }) {
  const [inp, outp] = MODELS[model];
  const writeRate = inp * 2.0;
  const readRate = inp * 0.1;

  const avgContextK = (baseK + finalK) / 2;
  const readsM = (turns * avgContextK) / 1000;
  const writesM = finalK / 1000; // everything ends up written once
  const outM = outK / 1000;

  return readsM * readRate + writesM * writeRate + outM * outp;
}

// ------------------------------------------------------------------ arguments

const o = {
  model: "sonnet-5",
  products: 7,
  prsPerMonth: 40,
  triagePassRate: 0.6,
  smokeSweepsPerMonth: 4,
  fullSweepsPerMonth: 1,
  releasesPerMonthTotal: null,
  smokeShards: 6,
  fullShards: 18,
  publicRepos: false,

  // --- the suite offset -----------------------------------------------------
  // Fraction of a product's declared areas covered by GREEN @fresh specs, i.e.
  // `areas_covered.length / areas_declared.length` from suite-index.mjs. Zero by
  // default, so every number above stays exactly what it was before the suite
  // layer existed.
  suiteCoverage: 0,
  projectionMonths: 0,
  specsPerMonth: 4,
  areasPerProduct: 9,
};

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const n = () => Number(argv[++i]);
  if (a === "--model") o.model = argv[++i];
  else if (a === "--products") o.products = n();
  else if (a === "--prs-per-month") o.prsPerMonth = n();
  else if (a === "--triage-pass-rate") o.triagePassRate = n();
  else if (a === "--smoke-sweeps-per-month") o.smokeSweepsPerMonth = n();
  else if (a === "--full-sweeps-per-month") o.fullSweepsPerMonth = n();
  else if (a === "--releases-per-month-total") o.releasesPerMonthTotal = n();
  else if (a === "--smoke-shards") o.smokeShards = n();
  else if (a === "--full-shards") o.fullShards = n();
  else if (a === "--public-repos") o.publicRepos = true;
  else if (a === "--suite-coverage") o.suiteCoverage = n();
  else if (a === "--projection") o.projectionMonths = n();
  else if (a === "--specs-per-month") o.specsPerMonth = n();
  else if (a === "--areas-per-product") o.areasPerProduct = n();
  else {
    console.error(`unknown flag: ${a}`);
    process.exit(2);
  }
}

if (!MODELS[o.model]) {
  console.error(`unknown model: ${o.model}. Known: ${Object.keys(MODELS).join(", ")}`);
  process.exit(2);
}

// --- per-run token shapes ---------------------------------------------------
const PR = { baseK: 25, finalK: 120, turns: 40, outK: 18 };
const SHARD = { baseK: 20, finalK: 200, turns: 70, outK: 25 };
const RECON = { baseK: 40, finalK: 70, turns: 15, outK: 12 };

// Release-driven mode: full sweeps happen only when a product ships, and you ship
// two or three products a month — so spread that across the catalogue rather than
// charging every product a monthly cadence it does not have.
if (o.releasesPerMonthTotal !== null) {
  o.fullSweepsPerMonth = o.releasesPerMonthTotal / o.products;
  o.smokeSweepsPerMonth = 0;
}

const prCost = agentRunCost(o.model, PR);
const shardCost = agentRunCost(o.model, SHARD);
const reconCost = agentRunCost(o.model, RECON);

const smoke = o.smokeShards * shardCost + reconCost;
const full = o.fullShards * shardCost + reconCost;

// --- the suite offset -------------------------------------------------------
//
// An area covered by green @fresh specs costs RUNNER MINUTES instead of an agent
// shard. That is the entire economic argument for the suite layer, and until now
// nothing in this repo expressed it as a number.
//
// Two assumptions, stated rather than buried, because they are what the curve
// below stands on:
//
//   1. Shards scale linearly with uncovered areas. A covered area's shard is
//      simply not dispatched.
//   2. A PR review does NOT scale to zero with coverage. Reading the diff,
//      classifying risk, triaging suite failures and writing the comment happen
//      whatever the coverage is; only the missions scale. PR_FIXED_SHARE is the
//      fraction that does not move.
//
// Both are estimates. Replace them with observed figures once the pilot has
// produced a dozen runs — the same caveat as the token shapes above.
const PR_FIXED_SHARE = 0.4;

// Minutes the suite itself costs, which is what replaces the agent work.
const SUITE_MIN_PER_PR = 6;
const SUITE_MIN_PER_SWEEP = 10;

/** Everything one product costs in a month at a given spec coverage, 0..1. */
function perProductAt(coverage) {
  const cov = Math.min(Math.max(coverage, 0), 1);

  const runs = o.prsPerMonth * o.triagePassRate;
  const prAt = prCost * (PR_FIXED_SHARE + (1 - PR_FIXED_SHARE) * (1 - cov));

  const smokeShards = o.smokeShards * (1 - cov);
  const fullShards = o.fullShards * (1 - cov);
  const smokeAt = smokeShards * shardCost + reconCost;
  const fullAt = fullShards * shardCost + reconCost;

  const claude =
    runs * prAt + o.smokeSweepsPerMonth * smokeAt + o.fullSweepsPerMonth * fullAt;

  // Actions minutes: a PR run ~12 min; each shard ~25 min; recon ~5 min. The
  // suite adds minutes back — cheap ones, which is the whole point.
  const mins =
    runs * 12 +
    o.smokeSweepsPerMonth * (smokeShards * 25 + 5) +
    o.fullSweepsPerMonth * (fullShards * 25 + 5) +
    (cov > 0
      ? runs * SUITE_MIN_PER_PR +
        (o.smokeSweepsPerMonth + o.fullSweepsPerMonth) * SUITE_MIN_PER_SWEEP
      : 0);

  const ci = o.publicRepos ? 0 : mins * ACTIONS_PER_MIN_PRIVATE;
  return { claude, ci, mins, runs, smokeShards, fullShards };
}

const money = (n) => `$${n.toFixed(2)}`.padStart(9);
const row = (label, value, suffix = "") =>
  console.log(label.padEnd(34) + money(value) + suffix);

console.log(
  `model: ${o.model}   ($${MODELS[o.model][0]}/M in, $${MODELS[o.model][1]}/M out)`,
);
console.log("=".repeat(62));
row("one PR review", prCost);
row("one sweep shard", shardCost);
row(`smoke sweep (${o.smokeShards} shards + recon)`, smoke);
row(`full sweep (${o.fullShards} shards + recon)`, full);
console.log();

const here = perProductAt(o.suiteCoverage);
const runs = here.runs;
const perProduct = here.claude;
const mins = here.mins;
const ci = here.ci;

const fmt = (n, d = 0) => n.toLocaleString("en-US", { maximumFractionDigits: d });

console.log(
  `per product / month  (${runs.toFixed(0)} PR runs, ` +
    `${+o.smokeSweepsPerMonth.toFixed(2)} smoke, ${+o.fullSweepsPerMonth.toFixed(2)} full)`,
);
if (o.suiteCoverage > 0) {
  const base = perProductAt(0);
  console.log(
    `  suite coverage ${(o.suiteCoverage * 100).toFixed(0)}% of areas` +
      ` — shards ${o.fullShards} → ${here.fullShards.toFixed(1)} on a full sweep`,
  );
  console.log(
    `  Claude without the suite would be ${money(base.claude).trim()}` +
      ` — saving ${money(base.claude - here.claude).trim()}/product/month`,
  );
}
row("  Claude", perProduct);
row(`  Actions (${fmt(mins)} min)`, ci, o.publicRepos ? "  [free — public repo]" : "");
row("  subtotal", perProduct + ci);
console.log();

const total = (perProduct + ci) * o.products;
row(`ALL ${o.products} PRODUCT${o.products === 1 ? "" : "S"} / MONTH`, total);
row("annualised", total * 12);

if (!o.publicRepos) {
  console.log(
    `\nnote: ${fmt(ACTIONS_FREE_MIN_TEAM)} Actions minutes/month are included on Team;` +
      `\n      you would use ~${fmt(mins * o.products)}.`,
  );
}

// ---------------------------------------------------------------- projection
//
// The declining curve. This is the entire argument for the suite layer, and
// until it existed nothing in this repo showed it — the model could only ever
// print a flat monthly cost, which made "specs pay for themselves" a claim
// rather than a number.
//
// The coverage model is deliberately crude and deliberately pessimistic:
// specs accumulate at a fixed rate, each area needs several before it counts as
// covered, and coverage saturates at 100% rather than continuing to pay off.
if (o.projectionMonths > 0) {
  const SPECS_PER_AREA = 3; // matches suite-index.mjs's `thinnest_areas` threshold

  console.log();
  console.log(
    `projection — ${o.specsPerMonth} spec${o.specsPerMonth === 1 ? "" : "s"}/product/month, ` +
      `${o.areasPerProduct} areas, ${SPECS_PER_AREA} specs to cover one`,
  );
  console.log("=".repeat(62));
  console.log(
    "month".padEnd(8) +
      "coverage".padStart(10) +
      "Claude".padStart(12) +
      "Actions".padStart(11) +
      "total/mo".padStart(12),
  );

  let cumulative = 0;
  let baselineCumulative = 0;
  const base = perProductAt(0);

  for (let month = 1; month <= o.projectionMonths; month++) {
    const specs = o.specsPerMonth * month;
    const coverage = Math.min(specs / (o.areasPerProduct * SPECS_PER_AREA), 1);
    const p = perProductAt(coverage);

    const totalMonth = (p.claude + p.ci) * o.products;
    cumulative += totalMonth;
    baselineCumulative += (base.claude + base.ci) * o.products;

    // Every month for the first year, then annually — a 36-month table nobody
    // reads is worse than a 12-row one they do.
    if (month <= 12 || month % 12 === 0) {
      console.log(
        String(month).padEnd(8) +
          `${(coverage * 100).toFixed(0)}%`.padStart(10) +
          money(p.claude * o.products).slice(-12).padStart(12) +
          money(p.ci * o.products).slice(-11).padStart(11) +
          money(totalMonth).slice(-12).padStart(12),
      );
    }
  }

  console.log();
  row(`cumulative over ${o.projectionMonths} months`, cumulative);
  row("  same period, no suite", baselineCumulative);
  row("  saved", baselineCumulative - cumulative);
  console.log(
    `\nThat gap is what the suite layer buys. It is not a discount — it is work` +
      `\nmoved from the priced column into the runner-minutes column, permanently.`,
  );
}

console.log(`
The lever that actually moves this number is not the model choice.
It is moving coverage from agent runs into committed Playwright specs,
which cost Actions minutes only. Every spec you accumulate permanently
removes work from the priced column.

  --suite-coverage 0.55        model today's coverage (from suite-index.mjs:
                               areas_covered.length / areas_declared.length)
  --projection 24              show the curve as coverage grows`);
