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

const runs = o.prsPerMonth * o.triagePassRate;
const perProduct =
  runs * prCost + o.smokeSweepsPerMonth * smoke + o.fullSweepsPerMonth * full;

// Actions minutes: a PR run ~12 min; each shard ~25 min; recon ~5 min.
const mins =
  runs * 12 +
  o.smokeSweepsPerMonth * (o.smokeShards * 25 + 5) +
  o.fullSweepsPerMonth * (o.fullShards * 25 + 5);
const ci = o.publicRepos ? 0 : mins * ACTIONS_PER_MIN_PRIVATE;

const fmt = (n, d = 0) => n.toLocaleString("en-US", { maximumFractionDigits: d });

console.log(
  `per product / month  (${runs.toFixed(0)} PR runs, ` +
    `${+o.smokeSweepsPerMonth.toFixed(2)} smoke, ${+o.fullSweepsPerMonth.toFixed(2)} full)`,
);
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

console.log(`
The lever that actually moves this number is not the model choice.
It is moving coverage from agent runs into committed Playwright specs,
which cost Actions minutes only. Every spec you accumulate permanently
removes work from the priced column.`);
