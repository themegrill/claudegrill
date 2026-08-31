#!/usr/bin/env node
/**
 * Ingest a product's public documentation into the QA knowledge layer.
 *
 * Node, so it runs on Windows and macOS with nothing but Node installed.
 *
 * Why this exists
 * ---------------
 * A knowledge file needs two kinds of thing. Structure — settings, options,
 * capabilities — is derivable from source. *Intent* — what a setting is for,
 * what should happen after Save — is not in the source at all. It is in the
 * docs, written by people who know the product.
 *
 * Two modes:
 *
 *   --rest BASE   WordPress REST API. Preferred for ThemeGrill's own docs:
 *                 sections come from the site's own categories rather than being
 *                 guessed from URL segments. Required for ColorMag, whose
 *                 articles all sit at /colormag/docs/<slug>/ with no section in
 *                 the path at all.
 *
 *   <sitemap URL> Sitemap plus HTML scrape, for docs sites without a usable API.
 *
 * Output
 *   .themegrill-qa/docs/<section>.md    per section, incl. stated outcomes
 *   .themegrill-qa/docs-index.json      sections, counts, suggested areas
 *
 * Usage
 *   node scripts/ingest-docs.mjs --rest https://docs.themegrill.com/colormag
 *   node scripts/ingest-docs.mjs https://docs.example.com/sitemap.xml
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const UA = "claudegrill-docs-ingest/1.0 (+internal QA tooling)";

/** Below this an article is flagged for review — but still included. A thin
 *  entry is a nuisance; a silently dropped one is a hole nobody notices. */
const MIN_ARTICLE_CHARS = 150;

// ------------------------------------------------------------------ arguments

const argv = process.argv.slice(2);
const opt = {
  sitemap: null,
  rest: null,
  postType: "docs",
  taxonomy: "doc_category",
  out: ".themegrill-qa",
  sections: [],
  limit: 0,
  delay: 400,
  cache: null,
};

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--rest") opt.rest = argv[++i];
  else if (a === "--post-type") opt.postType = argv[++i];
  else if (a === "--taxonomy") opt.taxonomy = argv[++i];
  else if (a === "--out") opt.out = argv[++i];
  else if (a === "--section") opt.sections.push(argv[++i]);
  else if (a === "--limit") opt.limit = Number(argv[++i]);
  else if (a === "--delay") opt.delay = Number(argv[++i]);
  else if (a === "--cache") opt.cache = argv[++i];
  else if (!a.startsWith("--")) opt.sitemap = a;
  else {
    console.error(`unknown flag: ${a}`);
    process.exit(2);
  }
}

if (!opt.rest && !opt.sitemap) {
  console.error(
    "give either a sitemap URL or --rest BASE_URL\n" +
      "e.g. node scripts/ingest-docs.mjs --rest https://docs.themegrill.com/colormag",
  );
  process.exit(2);
}

opt.cache = opt.cache ?? path.join(opt.out, ".docs-cache");

// -------------------------------------------------------------------- fetching

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** GET with an on-disk cache, so re-running is free and a partial run resumes. */
async function get(url, { retries = 2 } = {}) {
  const key =
    (new URL(url).pathname + new URL(url).search)
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .slice(0, 180) || "index";
  const file = path.join(opt.cache, `${key}.txt`);

  if (fs.existsSync(file) && fs.statSync(file).size > 0) {
    return fs.readFileSync(file, "utf8");
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.text();
      fs.mkdirSync(opt.cache, { recursive: true });
      fs.writeFileSync(file, body);
      if (opt.delay) await sleep(opt.delay); // be kind to your own server
      return body;
    } catch (err) {
      if (attempt === retries) {
        console.error(`  ! fetch failed: ${url} (${err.message})`);
        return null;
      }
      await sleep(1500 * (attempt + 1));
    }
  }
  return null;
}

async function getJson(url) {
  const body = await get(url);
  if (body === null) return null;
  try {
    return JSON.parse(body);
  } catch {
    console.error(`  ! not JSON: ${url}`);
    return null;
  }
}

// ------------------------------------------------------------- HTML to text

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  rarr: "→", larr: "←", hellip: "…", mdash: "—", ndash: "–",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", times: "×", middot: "·",
};

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

/** Strip page furniture and reduce markup to readable text with structure. */
function htmlToText(html) {
  if (!html) return "";

  let s = String(html);

  // Drop whole blocks that never carry article content.
  for (const tag of [
    "script", "style", "noscript", "svg", "nav", "header", "footer", "aside",
    "form", "button", "template", "iframe",
  ]) {
    s = s.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi"), " ");
    s = s.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, "gi"), " ");
  }

  s = s
    .replace(/<h([1-6])\b[^>]*>/gi, (_, n) => `\n\n${"#".repeat(Number(n))} `)
    .replace(/<\/h[1-6]>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/(p|div|section|article|tr|ul|ol|table|blockquote|pre)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<(strong|b)\b[^>]*>|<\/(strong|b)>/gi, "**")
    .replace(/<code\b[^>]*>|<\/code>/gi, "`")
    .replace(/<[^>]+>/g, " ");

  return decodeEntities(s)
    .replace(/\*\*\s*\*\*/g, "")
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// A sentence that states an outcome is a candidate assertion.
const OUTCOME =
  /\b(will be|will then|will now|you will|should (?:see|be|now)|is displayed|are displayed|appears?|redirect(?:ed|s)? to|takes? you to|instead of|results? in|is (?:created|saved|sent|applied|shown)|becomes?|receives?)\b/i;

function outcomeSentences(text, limit = 12) {
  const out = [];
  for (const raw of text.split(/(?<=[.!?])\s+/)) {
    const s = raw.split(/\s+/).join(" ").trim();
    if (s.length >= 25 && s.length <= 260 && OUTCOME.test(s)) out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

// ------------------------------------------------------------------- writing

function writeSection({ dir, slug, label, parent, source, rows, mode }) {
  const all = rows.flatMap((r) => r.outcomes);
  const file = path.join(dir, `${slug}.md`);
  const lines = [`# Docs — ${label}\n`];

  if (parent) lines.push(`_Sub-section of ${parent}._\n`);

  lines.push(
    `<!-- Generated by ingest-docs.mjs from ${source}${mode === "rest" ? " (REST)" : ""}.`,
    `     ${rows.length} articles. This is the INTENT source for QA:`,
    `     what the product promises, in the product owner's words.`,
    `     Do not hand-edit — re-run the ingest instead. -->\n`,
  );

  if (all.length) {
    lines.push("## Stated outcomes in this section\n");
    lines.push(
      "_Each of these is a candidate assertion. If the product does not do this, " +
        "that is either a regression or a stale doc — both are findings._\n",
    );
    for (const s of [...new Set(all)]) lines.push(`- ${s}`);
    lines.push("\n---\n");
  }

  for (const r of rows) {
    lines.push(`## ${r.title}\n`);
    lines.push(`<${r.url}>\n`);
    lines.push(`${r.text}\n`);
    lines.push("---\n");
  }

  fs.writeFileSync(file, lines.join("\n"));
  return file;
}

// ---------------------------------------------------------------- REST mode

async function ingestRest() {
  const base = opt.rest.replace(/\/+$/, "");
  console.log(`rest     ${base}`);

  const terms = await getJson(
    `${base}/wp-json/wp/v2/${opt.taxonomy}?per_page=100&_fields=id,name,slug,count,parent`,
  );
  if (!terms || !Array.isArray(terms) || !terms.length) {
    console.error(
      `could not read ${opt.taxonomy} from ${base} — check --taxonomy and the URL`,
    );
    process.exit(1);
  }

  const byId = new Map(terms.map((t) => [t.id, t]));
  const totalExpected = terms.reduce((n, t) => n + (t.count || 0), 0);
  console.log(`found    ${terms.length} categories, ${totalExpected} articles\n`);

  const articles = [];
  for (let page = 1; page <= 25; page++) {
    const batch = await getJson(
      `${base}/wp-json/wp/v2/${opt.postType}?per_page=100&page=${page}` +
        `&_fields=id,slug,link,title,content,${opt.taxonomy}`,
    );
    if (!batch || !Array.isArray(batch) || !batch.length) break;
    articles.push(...batch);
    if (batch.length < 100) break;
  }

  if (!articles.length) {
    console.error(`no ${opt.postType} records returned from ${base}`);
    process.exit(1);
  }

  const grouped = new Map();
  const push = (k, v) => grouped.set(k, [...(grouped.get(k) ?? []), v]);

  for (const art of articles) {
    const ids = art[opt.taxonomy] ?? [];
    if (!ids.length) {
      push("uncategorised", art);
      continue;
    }
    // An article in several categories belongs to its most specific one: a child
    // term is a narrower surface than its parent.
    const chosen = ids
      .slice()
      .sort((a, b) => {
        const pa = (byId.get(a)?.parent ?? 0) !== 0 ? 1 : 0;
        const pb = (byId.get(b)?.parent ?? 0) !== 0 ? 1 : 0;
        return pb - pa || b - a;
      })[0];
    push(byId.get(chosen)?.slug ?? `term-${chosen}`, art);
  }

  const ordered = [...grouped.entries()].sort((a, b) => b[1].length - a[1].length);
  const docsDir = path.join(opt.out, "docs");
  fs.mkdirSync(docsDir, { recursive: true });

  const index = { source: base, mode: "rest", sections: [], suggested_areas: [] };

  for (const [slug, artsAll] of ordered) {
    if (opt.sections.length && !opt.sections.includes(slug)) continue;
    const arts = opt.limit ? artsAll.slice(0, opt.limit) : artsAll;

    const term = terms.find((t) => t.slug === slug) ?? {};
    const label = term.name ?? slug;
    const parent = byId.get(term.parent ?? 0)?.name ?? null;

    console.log(
      `${slug}  (${arts.length} articles)${parent ? `  <- under ${parent}` : ""}`,
    );

    const rows = [];
    const thin = [];

    for (const art of arts) {
      const title =
        htmlToText(art.title?.rendered ?? "") || art.slug || "(untitled)";
      const text = htmlToText(art.content?.rendered ?? "");
      const outcomes = outcomeSentences(text);

      if (text.length < MIN_ARTICLE_CHARS) {
        thin.push({ url: art.link ?? "", chars: text.length });
        console.error(
          `  ! THIN, review: ${art.link ?? art.slug} (${text.length}c) — included anyway`,
        );
      }

      rows.push({ title, url: art.link ?? "", text, outcomes });
      console.log(
        `  . ${title.slice(0, 66).padEnd(66)} ${String(text.length).padStart(6)}c ` +
          `${String(outcomes.length).padStart(2)} outcomes`,
      );
    }

    const file = writeSection({
      dir: docsDir, slug, label, parent, source: base, rows, mode: "rest",
    });

    index.sections.push({
      section: slug, label, parent,
      file: path.relative(opt.out, file).split(path.sep).join("/"),
      articles: rows.length, failed: 0, thin,
      outcomes: rows.reduce((n, r) => n + r.outcomes.length, 0),
      titles: rows.map((r) => r.title),
    });
    console.log(`  -> ${file}\n`);
  }

  index.suggested_areas = index.sections.map((s) => s.section);
  return index;
}

// ------------------------------------------------------------- sitemap mode

async function ingestSitemap() {
  console.log(`sitemap  ${opt.sitemap}`);
  const xml = await get(opt.sitemap);
  if (!xml) {
    console.error("could not fetch the sitemap");
    process.exit(1);
  }

  const urls = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)]
    .map((m) => m[1])
    .filter((u) => !u.endsWith(".xml"));

  if (!urls.length) {
    console.error("no <loc> entries found — is that really a sitemap?");
    process.exit(1);
  }

  const sectionOf = (u) => {
    const parts = new URL(u).pathname.split("/").filter(Boolean);
    return parts[0] ?? "root";
  };
  const slugOf = (u) => {
    const parts = new URL(u).pathname.split("/").filter(Boolean);
    return parts.length > 1 ? parts[parts.length - 1] : "_index";
  };

  const grouped = new Map();
  for (const u of urls) {
    const k = sectionOf(u);
    grouped.set(k, [...(grouped.get(k) ?? []), u]);
  }

  console.log(`found    ${urls.length} urls across ${grouped.size} sections\n`);

  const docsDir = path.join(opt.out, "docs");
  fs.mkdirSync(docsDir, { recursive: true });
  const index = { source: opt.sitemap, mode: "sitemap", sections: [], suggested_areas: [] };

  for (const [slug, allUrls] of [...grouped.entries()].sort(
    (a, b) => b[1].length - a[1].length,
  )) {
    if (opt.sections.length && !opt.sections.includes(slug)) continue;
    const list = opt.limit ? allUrls.slice(0, opt.limit) : allUrls.slice().sort();

    console.log(`${slug}  (${list.length} urls)`);
    const rows = [];
    const thin = [];
    let failed = 0;

    for (const u of list) {
      const html = await get(u);
      if (!html) {
        failed++;
        continue;
      }
      const text = htmlToText(html);

      // A section landing page carries only a link list.
      const isLanding = slugOf(u) === "_index" || slugOf(u) === slug;
      if (isLanding) {
        console.log(`  . ${"(section landing page, skipped)".padEnd(66)} ${text.length}c`);
        continue;
      }
      if (text.length < MIN_ARTICLE_CHARS) {
        thin.push({ url: u, chars: text.length });
        console.error(`  ! THIN, review: ${u} (${text.length}c) — included anyway`);
      }

      const h1 = text.match(/^#\s+(.+)$/m);
      const title = h1
        ? h1[1].trim()
        : slugOf(u).replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
      const outcomes = outcomeSentences(text);

      rows.push({ title, url: u, text, outcomes });
      console.log(
        `  . ${title.slice(0, 66).padEnd(66)} ${String(text.length).padStart(6)}c ` +
          `${String(outcomes.length).padStart(2)} outcomes`,
      );
    }

    if (!rows.length) continue;

    const file = writeSection({
      dir: docsDir, slug, label: slug, parent: null,
      source: opt.sitemap, rows, mode: "sitemap",
    });

    index.sections.push({
      section: slug, label: slug, parent: null,
      file: path.relative(opt.out, file).split(path.sep).join("/"),
      articles: rows.length, failed, thin,
      outcomes: rows.reduce((n, r) => n + r.outcomes.length, 0),
      titles: rows.map((r) => r.title),
    });
    console.log(`  -> ${file}\n`);
  }

  index.suggested_areas = index.sections.map((s) => s.section);
  return index;
}

// ------------------------------------------------------------------------ run

const index = opt.rest ? await ingestRest() : await ingestSitemap();

const ipath = path.join(opt.out, "docs-index.json");
fs.mkdirSync(opt.out, { recursive: true });
fs.writeFileSync(ipath, JSON.stringify(index, null, 2));

const tot = index.sections.reduce((n, s) => n + s.articles, 0);
const bad = index.sections.reduce((n, s) => n + s.failed, 0);
const thin = index.sections.reduce((n, s) => n + s.thin.length, 0);

console.log("=".repeat(68));
console.log(
  `${tot} articles in ${index.sections.length} sections -> ${path.join(opt.out, "docs")}`,
);
if (bad) {
  console.log(`${bad} pages failed to fetch — rerun to retry (the cache keeps the rest)`);
}
if (thin) {
  console.log(
    `${thin} articles came out unusually short — listed under "thin" in the index. ` +
      `Open one; usually a page built from blocks the parser skipped.`,
  );
}
console.log(`index -> ${ipath}`);
console.log("\nareas_json for the sweep caller:");
console.log(JSON.stringify(index.suggested_areas));
