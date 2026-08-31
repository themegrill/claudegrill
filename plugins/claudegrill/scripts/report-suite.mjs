#!/usr/bin/env node
/**
 * Compose the human-readable report for a suite run.
 *
 * The suite already knew what broke; this is the layer that says so. Before it,
 * the PR comment rendered a path and a title and nothing else, while the JSON it
 * read carried the error, the attachments and the retry count — so a reviewer had
 * to open the Actions tab and rebuild the failure by hand. Everything here comes
 * out of `suite.json` and `index.json`. Nothing is re-run, nothing is inferred by
 * an agent, and the whole thing is free.
 *
 * It is the single composer for all three surfaces. Two used to be written inline
 * in suite.yml and had already drifted apart from each other.
 *
 * Deterministic, so it is a script and not a skill (invariant 1).
 *
 * Usage
 *   node scripts/report-suite.mjs --suite suite.json --format md
 *   node scripts/report-suite.mjs --suite suite.json --index index.json \
 *     --format html --out qa-report.html --product-dir product
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { diagnose as diagnoseFn } from "./lib/diagnose.mjs";

// ------------------------------------------------------------------ arguments

const opt = {
  suite: "suite.json",
  index: null,
  format: "md",
  out: null,            // file to write; stdout when absent
  productDir: ".",      // where the repo-relative paths in suite.json resolve
  artifactUrl: null,    // the CI artifact, so the comment can link the evidence
  runUrl: null,
  artifactName: null,
  repo: null,           // owner/name, for permalinks
  sha: null,
  maxBytes: 60000,      // GitHub's comment ceiling is 65536
};

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--suite") opt.suite = argv[++i];
  else if (a === "--index") opt.index = argv[++i];
  else if (a === "--format") opt.format = argv[++i];
  else if (a === "--out") opt.out = argv[++i];
  else if (a === "--product-dir") opt.productDir = argv[++i];
  else if (a === "--artifact-url") opt.artifactUrl = argv[++i];
  else if (a === "--artifact-name") opt.artifactName = argv[++i];
  else if (a === "--run-url") opt.runUrl = argv[++i];
  else if (a === "--repo") opt.repo = argv[++i];
  else if (a === "--sha") opt.sha = argv[++i];
  else if (a === "--max-bytes") opt.maxBytes = Number(argv[++i]);
  else {
    console.error(`unknown flag: ${a}`);
    process.exit(2);
  }
}

if (!["md", "summary", "html"].includes(opt.format)) {
  console.error(`--format must be md, summary or html (got: ${opt.format})`);
  process.exit(2);
}

// An empty or unwritten value is the same as absent. CI passes these straight
// from workflow expressions, which yield "" rather than nothing when unset.
for (const k of ["artifactUrl", "runUrl", "artifactName", "repo", "sha", "index"]) {
  if (opt[k] === "" || opt[k] === "null") opt[k] = null;
}

// ----------------------------------------------------------------- the inputs

/**
 * A missing or unparseable result must still produce a report.
 *
 * This runs in `if: always()`, so it is reached precisely when things went
 * wrong. Throwing here would replace a bad verdict with no verdict at all.
 */
function readJson(file) {
  if (!file) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

const r = readJson(opt.suite) ?? {};
const idx = readJson(opt.index);

// --------------------------------------------------------------- small pieces

const s = (n) => (n === 1 ? "" : "s");
const secs = (ms) => `${Math.round((ms ?? 0) / 1000)}s`;

/** GitHub renders a blob permalink as a clickable, line-anchored link. */
function permalink(file, line) {
  if (!file) return null;
  if (!opt.repo || !opt.sha) return null;
  return `https://github.com/${opt.repo}/blob/${opt.sha}/${file}${line ? `#L${line}` : ""}`;
}

/** Where the failure actually happened, falling back to where the test starts. */
function where(f) {
  const loc = f.location?.file ? f.location : { file: f.file, line: f.line };
  return { file: loc.file, line: loc.line };
}

/** `tests/e2e/specs/a/b.spec.ts` -> `b.spec.ts`, for a heading. */
const basename = (p) => String(p ?? "").split("/").pop();

/** Attachments, grouped by the kind a reader cares about. */
function evidenceOf(f) {
  const out = { screenshot: [], trace: [], video: [], other: [] };
  for (const a of f.attachments ?? []) {
    // Attachments are objects now; a run from an older run-suite.mjs still has
    // bare strings, and a report that crashes on those helps nobody.
    const at = typeof a === "string" ? { path: a, name: null, content_type: null } : a;
    const name = (at.name ?? "").toLowerCase();
    const p = (at.path ?? "").toLowerCase();
    if (name.includes("screenshot") || /\.(png|jpe?g)$/.test(p)) out.screenshot.push(at);
    else if (name.includes("trace") || /\.zip$/.test(p)) out.trace.push(at);
    else if (name.includes("video") || /\.(webm|mp4)$/.test(p)) out.video.push(at);
    else out.other.push(at);
  }
  return out;
}

/**
 * The Expected/Received block, pulled out of an assertion message.
 *
 * Matched line by line rather than with one pattern, because the wording varies
 * by matcher — `Expected:` for toBeVisible, `Expected length:` for toHaveLength,
 * `Expected string:` for toHaveText, and several carry a third `Received array:`
 * line. A pattern pinned to one of those silently drops the diff for the rest.
 */
function expectedReceived(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const isPart = (l) => /^\s*(Expected|Received)\b.*:/.test(l);
  let best = [];
  let run = [];
  for (const l of lines) {
    if (isPart(l)) {
      run.push(l.trimEnd());
    } else {
      if (run.length > best.length) best = run;
      run = [];
    }
  }
  if (run.length > best.length) best = run;
  // One line alone is not a diff — it is a stray sentence that happens to start
  // with the word.
  return best.length >= 2 ? best.join("\n") : null;
}

// -------------------------------------------------------------------- verdict

/**
 * The headline, and the states that are not simply pass/fail.
 *
 * Each of these existed in the workflow already and each is load-bearing — in
 * particular `ran_nothing`, which is the difference between "your change is
 * safe" and "nothing was checked". They are kept word for word.
 */
function verdict() {
  if (r.suite === false) {
    return {
      state: "not-configured",
      heading: "QA suite — not configured",
      lines: ["This product has no `.themegrill-qa/suite.json`, so nothing ran."],
    };
  }
  if (r.ran_nothing) {
    return {
      state: "broken",
      heading: "QA suite — BROKEN, not passed",
      lines: [
        "**The runner executed 0 tests.** That is a broken harness, not a pass —",
        "do not read this as the change being safe.",
        "",
        "Likely causes: the grep matched nothing, `spec_dir` is wrong, or the",
        "install left no runner. The step log says which.",
      ],
    };
  }
  if (r.scope?.mode === "none") {
    return {
      state: "nothing-to-run",
      heading: "QA suite — nothing to run",
      lines: [
        "This PR changes no product source, so no spec could be affected.",
        "That is not a statement about the change being correct.",
      ],
    };
  }
  if (r.ok === undefined) {
    return {
      state: "could-not-run",
      heading: "QA suite — could not run",
      lines: [`\`${r.reason ?? "no parseable result"}\``, "", "A harness failure, not a test failure."],
    };
  }
  return {
    state: r.ok ? "passed" : "failed",
    heading: `QA suite — ${r.ok ? "passed ✅" : "failed ❌"}`,
    lines: [],
  };
}

/** The scope sentence: which areas ran, and why only those. */
function scopeLines() {
  const sc = r.scope;
  if (sc?.mode === "changed") {
    return [
      `**Scope: only the areas this diff maps to — \`${(sc.areas ?? []).join("`, `")}\`.**`,
      "Other areas were not run on this PR. The nightly full run covers them.",
      "",
    ];
  }
  if (sc?.mode === "full") {
    return [`**Scope: the full \`@fresh\` tier** — ${sc.reason}.`, ""];
  }
  return [];
}

// ------------------------------------------------------------------- markdown

/**
 * One failure, written so the reader knows where to start.
 *
 * Order matters: what broke, why the spec exists, what it usually means, then
 * the raw evidence. A reviewer who reads only the first two lines should still
 * come away knowing where to look.
 */
function failureMarkdown(f, i) {
  const w = where(f);
  const link = permalink(w.file, w.line);
  const at = `${w.file}:${w.line ?? "?"}`;
  const d = diagnoseFn(f);
  const out = [];

  out.push(`<details open><summary><b>${i + 1}. ${escapeMd(f.title)}</b></summary>`, "");
  // One line: GitHub turns a single newline inside a paragraph into a break,
  // which would stack these three fragments down the comment.
  const meta = [`**Broke at** ${link ? `[\`${at}\`](${link})` : `\`${at}\``}`];
  if (f.area) meta.push(`area \`${f.area}\``);
  if ((f.guards ?? []).length) meta.push(`guards ${f.guards.map((g) => `\`${g}\``).join(", ")}`);
  out.push(meta.join(" · "), "");

  // The docblock's own sentence about why this spec exists. On a failure it is
  // the most useful line available: it names the behaviour that just stopped.
  if (f.why) out.push(`**This spec exists because:** ${escapeMd(f.why)}`, "");

  out.push(`**Usually means:** ${d.cause}.`);
  out.push(`**Check first:** ${d.check}.`, "");

  const er = expectedReceived(f.error_full ?? f.error);
  if (er) out.push("```diff", er, "```", "");

  if (f.error_snippet) {
    out.push("```", clip(f.error_snippet, 1200), "```", "");
  } else if (f.error_full ?? f.error) {
    out.push("```", clip(f.error_full ?? f.error, 1200), "```", "");
  }

  if (f.retries > 0) {
    out.push(`Retried ${f.retries} time${s(f.retries)} and failed every time.`, "");
  }

  const ev = evidenceOf(f);
  const bits = [];
  if (ev.screenshot.length) bits.push(`${ev.screenshot.length} screenshot${s(ev.screenshot.length)}`);
  if (ev.trace.length) bits.push(`${ev.trace.length} trace${s(ev.trace.length)}`);
  if (ev.video.length) bits.push(`${ev.video.length} video${s(ev.video.length)}`);
  if (bits.length) out.push(`**Evidence:** ${bits.join(", ")} — in the report below.`, "");

  out.push("</details>");
  return out;
}

/** GitHub renders a bare `|` inside a table cell as a column break. */
const escapeMd = (t) => String(t ?? "").replace(/\|/g, "\\|");

/** Trim to a budget on a line boundary, so a code frame stays readable. */
function clip(text, max) {
  const t = String(text ?? "");
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const nl = cut.lastIndexOf("\n");
  return (nl > max * 0.5 ? cut.slice(0, nl) : cut) + "\n… truncated, see the full report";
}

/** The PR comment. Marker first — the workflow finds and edits its own comment. */
function markdown(detailed = false) {
  const v = verdict();
  const out = ["<!-- claudegrill-suite -->", `## ${v.heading}`, ""];
  out.push(...v.lines);

  if (v.state === "passed" || v.state === "failed") {
    out.push(
      `**${r.passed} passed · ${r.failed} failed · ${r.skipped} skipped · ${r.flaky} flaky**`,
      `tier \`${r.tier}\` · ${secs(r.duration_ms)} · ${r.total} tests`,
      "",
    );
    out.push(...scopeLines());

    if (r.ok) {
      out.push(
        "**This covers only the areas that have specs** — see the coverage note",
        "below before treating it as full assurance.",
        "",
      );
    }

    if ((r.failures ?? []).length) {
      out.push("### What failed", "");
      // A budget, not a count: one enormous failure and twenty small ones
      // should both post. Exceeding GitHub's ceiling loses the whole comment.
      let used = out.join("\n").length;
      let shown = 0;
      for (const [i, f] of (r.failures ?? []).entries()) {
        const block = failureMarkdown(f, i);
        const cost = block.join("\n").length;
        if (used + cost > opt.maxBytes - 2000 && shown > 0) break;
        out.push(...block, "");
        used += cost;
        shown++;
      }
      const rest = (r.failures ?? []).length - shown;
      if (rest > 0) {
        out.push(`_${rest} further failure${s(rest)} not shown here — they are all in the report._`, "");
      }
    }

    // Named, at last. "4 flaky" told nobody which four, so nobody fixed them.
    if ((r.flaky_tests ?? []).length) {
      out.push(
        "<details><summary>" +
          `⚠️ ${r.flaky_tests.length} test${s(r.flaky_tests.length)} passed only on retry` +
          "</summary>",
        "",
        "A flaky suite erodes trust faster than a failing one — these are not green.",
        "",
        "| Test | Spec | Retries |",
        "|---|---|---|",
      );
      for (const t of r.flaky_tests) {
        out.push(`| ${escapeMd(t.title)} | \`${t.file}:${t.line ?? "?"}\` | ${t.retries} |`);
      }
      out.push("</details>", "");
    } else if (r.flaky > 0) {
      out.push(`> ⚠️ ${r.flaky} test${s(r.flaky)} passed only on retry. A flaky suite erodes trust faster than a failing one.`, "");
    }
  }

  out.push(...evidenceLinks());
  out.push(...coverageLines(detailed));
  out.push("", "<sub>Deterministic check — no AI, no API cost. The suite runs what developers committed.</sub>");

  let body = out.join("\n");
  if (body.length > opt.maxBytes) body = body.slice(0, opt.maxBytes - 200) + "\n\n_… truncated._";
  return body;
}

/**
 * How to get at the evidence.
 *
 * The artifact was always uploaded and never linked, which made it invisible.
 * The trace needs `show-report` because a service worker cannot start from a
 * `file://` page — so say that here rather than letting someone discover it.
 */
function evidenceLinks() {
  const out = [];
  const anything = (r.failures ?? []).length || (r.flaky_tests ?? []).length;
  if (!anything) return out;

  out.push("", "---", "", "### The full report");
  if (opt.artifactUrl) {
    out.push(
      "",
      `Download [**${opt.artifactName ?? "the QA artifact"}**](${opt.artifactUrl}) and open ` +
        "`qa-report.html` — screenshots, the error in full, and what was and was not checked.",
    );
  } else if (opt.runUrl) {
    out.push("", `The artifact is on [the run](${opt.runUrl}) — open \`qa-report.html\` inside it.`);
  }
  if (r.trace_mode && r.trace_mode !== "off") {
    out.push(
      "",
      "For a step-by-step replay of a failing test — every action, the DOM at each " +
        "step, network and console — unzip it and run:",
      "",
      "```",
      `npx playwright show-report ${r.html_report ?? "playwright-report"}`,
      "```",
      "",
      "<sub>The trace needs that command rather than opening the file directly; a " +
        "trace viewer cannot start from a `file://` page.</sub>",
    );
  }
  return out;
}

/**
 * What the suite does not cover — kept, because a green tick hides it.
 *
 * `detailed` adds the suite-hygiene lines. They belong in the step summary,
 * where a maintainer is looking at the suite itself, and not in the PR comment,
 * where they would bury the failure the author actually came to read.
 */
function coverageLines(detailed = false) {
  if (!idx?.suite) return [];
  const out = [
    "",
    "---",
    "",
    `**Coverage** — ${idx.tests} tests in ${idx.spec_files} files · ${idx.by_tier.fresh} fresh, ${idx.by_tier.demo} demo`,
  ];
  if ((idx.areas_uncovered ?? []).length) {
    out.push(
      "",
      `**No \`@fresh\` specs at all:** ${idx.areas_uncovered.join(", ")}`,
      "",
      "Nothing automated covers these areas. A green tick above says nothing about them.",
    );
  }
  if (detailed) {
    if ((idx.thinnest_areas ?? []).length) {
      out.push("", `**Thin (fewer than 3 specs):** ${idx.thinnest_areas.join(", ")}`);
    }
    const h = idx.hygiene ?? {};
    if (h.incomplete_docblocks || h.untagged_tier) {
      out.push(
        "",
        `Hygiene: ${h.incomplete_docblocks} incomplete docblock(s), ${h.untagged_tier} ` +
          "untagged tier(s) — untagged counts as `@demo` and never runs here.",
      );
    }
  }
  return out;
}

/** The step summary: the same content, minus the comment marker. */
function summary() {
  return markdown(true).replace("<!-- claudegrill-suite -->\n", "");
}

// ----------------------------------------------------------------------- html

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;  // one screenshot
const MAX_PAGE_BYTES = 10 * 1024 * 1024;  // the whole page
let imageBudget = MAX_PAGE_BYTES;

const esc = (t) =>
  String(t ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/**
 * Inline a screenshot as a data URI.
 *
 * The report has to survive being downloaded, unzipped and opened from disk with
 * no server, so an `<img src="test-results/…">` would be a broken image the
 * moment anyone moved the file. Inlining costs bytes; a report nobody can read
 * costs the whole exercise.
 */
function inlineImage(at) {
  const rel = typeof at === "string" ? at : at?.path;
  if (!rel) return null;
  const abs = path.resolve(opt.productDir, rel);
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    return null;
  }
  if (stat.size > MAX_IMAGE_BYTES || stat.size > imageBudget) return null;
  try {
    const b64 = fs.readFileSync(abs).toString("base64");
    imageBudget -= b64.length;
    const ext = path.extname(abs).toLowerCase();
    const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png";
    return `data:${mime};base64,${b64}`;
  } catch {
    return null;
  }
}

function failureHtml(f, i) {
  const w = where(f);
  const link = permalink(w.file, w.line);
  const at = `${w.file}:${w.line ?? "?"}`;
  const d = diagnoseFn(f);
  const ev = evidenceOf(f);
  const out = [];

  out.push(`<article class="card fail">`);
  out.push(`<h3><span class="n">${i + 1}</span> ${esc(f.title)}</h3>`);

  out.push(`<p class="meta">`);
  out.push(`Broke at ${link ? `<a href="${esc(link)}"><code>${esc(at)}</code></a>` : `<code>${esc(at)}</code>`}`);
  if (f.area) out.push(` · area <code>${esc(f.area)}</code>`);
  if ((f.guards ?? []).length) out.push(` · guards ${f.guards.map((g) => `<code>${esc(g)}</code>`).join(", ")}`);
  if (f.retries > 0) out.push(` · retried ${f.retries}×, failed every time`);
  out.push(`</p>`);

  if (f.why) out.push(`<p class="why"><b>This spec exists because:</b> ${esc(f.why)}</p>`);

  out.push(
    `<div class="dx"><p><b>Usually means:</b> ${esc(d.cause)}.</p>` +
      `<p><b>Check first:</b> ${esc(d.check)}.</p>` +
      `<p class="hedge">A pattern match on the error text, not a verified finding — start here, do not stop here.</p></div>`,
  );

  const er = expectedReceived(f.error_full ?? f.error);
  if (er) out.push(`<pre class="er">${esc(er)}</pre>`);
  if (f.error_snippet) out.push(`<pre class="snippet">${esc(f.error_snippet)}</pre>`);
  if (f.error_full ?? f.error) {
    out.push(
      `<details><summary>Full error</summary><pre>${esc(f.error_full ?? f.error)}</pre></details>`,
    );
  }

  const shots = ev.screenshot.map(inlineImage).filter(Boolean);
  if (shots.length) {
    out.push(`<div class="shots">`);
    for (const src of shots) {
      out.push(`<a href="${src}" target="_blank"><img src="${src}" alt="Screenshot at failure" loading="lazy"></a>`);
    }
    out.push(`</div>`);
  } else if (ev.screenshot.length) {
    out.push(`<p class="note">A screenshot was captured but is too large to inline — it is in the artifact.</p>`);
  }

  const links = [...ev.trace, ...ev.video, ...ev.other]
    .map((a) => `<li><code>${esc(a.path)}</code>${a.name ? ` — ${esc(a.name)}` : ""}</li>`)
    .join("");
  if (links) {
    out.push(
      `<details><summary>Other evidence in this artifact</summary><ul class="files">${links}</ul>` +
        `<p class="note">Replay a trace with <code>npx playwright show-report ${esc(r.html_report ?? "playwright-report")}</code>.</p></details>`,
    );
  }

  if ((f.attempts ?? []).length > 1) {
    const rows = f.attempts
      .map(
        (a) =>
          `<tr><td>${a.retry === 0 ? "first run" : `retry ${a.retry}`}</td>` +
          `<td>${esc(a.status ?? "?")}</td><td>${secs(a.duration_ms)}</td></tr>`,
      )
      .join("");
    out.push(
      `<details><summary>Attempts</summary><table><thead><tr><th>Attempt</th><th>Result</th><th>Took</th></tr></thead><tbody>${rows}</tbody></table></details>`,
    );
  }

  out.push(`</article>`);
  return out.join("");
}

/** Group a list of tests by area, for the sections that are just inventories. */
function byArea(tests) {
  const groups = new Map();
  for (const t of tests ?? []) {
    const k = t.area ?? "unfiled";
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function html() {
  const v = verdict();
  const failed = (r.failures ?? []).length;
  const body = [];

  // 1. The verdict, and what it does and does not mean.
  body.push(`<header class="verdict ${v.state}">`);
  body.push(`<h1>${esc(v.heading)}</h1>`);
  if (v.state === "passed" || v.state === "failed") {
    body.push(
      `<p class="counts">` +
        `<b class="ok">${r.passed}</b> passed · ` +
        `<b class="bad">${r.failed}</b> failed · ` +
        `<b>${r.skipped}</b> skipped · ` +
        `<b class="warn">${r.flaky}</b> flaky</p>`,
    );
    body.push(
      `<p class="meta">tier <code>${esc(r.tier)}</code> · ${r.total} tests · ${secs(r.duration_ms)}` +
        (r.env ? ` · engine <code>${esc(r.env)}</code>` : "") +
        (r.base_url ? ` · <code>${esc(r.base_url)}</code>` : "") +
        "</p>",
    );
    const sc = r.scope;
    if (sc?.mode === "changed") {
      body.push(
        `<p class="scope"><b>Only the areas this diff maps to ran:</b> ` +
          `${(sc.areas ?? []).map((a) => `<code>${esc(a)}</code>`).join(" ")}. ` +
          `Other areas were not run here — the nightly full run covers them.</p>`,
      );
    } else if (sc?.mode === "full") {
      body.push(`<p class="scope"><b>The full <code>@fresh</code> tier ran</b> — ${esc(sc.reason ?? "")}.</p>`);
    }
  } else {
    body.push(`<p>${v.lines.filter(Boolean).map(esc).join("<br>")}</p>`);
  }
  if (opt.runUrl) body.push(`<p class="meta"><a href="${esc(opt.runUrl)}">The CI run</a></p>`);
  body.push(`</header>`);

  // 2. What went wrong — first, because it is why anyone opened this.
  if (failed) {
    body.push(`<section><h2>What went wrong</h2>`);
    body.push(...(r.failures ?? []).map(failureHtml));
    body.push(`</section>`);
  }

  // 3. Flaky: passed, but not honestly green.
  if ((r.flaky_tests ?? []).length) {
    body.push(`<section><h2>Passed only on retry</h2>`);
    body.push(
      `<p class="note">These count as passing, but they failed at least once. ` +
        `A flaky suite erodes trust faster than a failing one.</p>`,
    );
    body.push(`<table><thead><tr><th>Test</th><th>Spec</th><th>Retries</th></tr></thead><tbody>`);
    for (const t of r.flaky_tests) {
      body.push(
        `<tr><td>${esc(t.title)}</td><td><code>${esc(t.file)}:${t.line ?? "?"}</code></td><td>${t.retries}</td></tr>`,
      );
    }
    body.push(`</tbody></table></section>`);
  }

  // 4. What went right. Present only when asked for: see --full-results.
  if ((r.passed_tests ?? []).length) {
    body.push(`<section><h2>What went right</h2>`);
    body.push(`<p class="note">${r.passed_tests.length} test${s(r.passed_tests.length)} passed.</p>`);
    for (const [area, tests] of byArea(r.passed_tests)) {
      body.push(
        `<details><summary><code>${esc(area)}</code> — ${tests.length} passing</summary><ul class="pass">`,
      );
      for (const t of tests) body.push(`<li>${esc(t.title)}</li>`);
      body.push(`</ul></details>`);
    }
    body.push(`</section>`);
  }

  // 5. What was not checked. The honest section, and the reason a green tick
  //    upstream is not the same as "this product works".
  const gaps = [];
  if (r.skipped > 0) gaps.push(`<li>${r.skipped} test${s(r.skipped)} skipped in this run.</li>`);
  for (const f of r.fixme ?? []) {
    gaps.push(`<li>Marked <code>fixme</code>, still open: ${esc(f.title)}</li>`);
  }
  if (idx?.suite && (idx.areas_uncovered ?? []).length) {
    gaps.push(
      `<li><b>No <code>@fresh</code> specs at all:</b> ` +
        `${idx.areas_uncovered.map((a) => `<code>${esc(a)}</code>`).join(" ")}</li>`,
    );
  }
  if (gaps.length) {
    body.push(`<section><h2>What was not checked</h2>`);
    if (idx?.suite) {
      body.push(
        `<p class="note">Coverage — ${idx.tests} tests in ${idx.spec_files} files · ` +
          `${idx.by_tier.fresh} fresh, ${idx.by_tier.demo} demo.</p>`,
      );
    }
    body.push(`<ul class="gaps">${gaps.join("")}</ul>`);
    body.push(
      `<p class="note">Nothing automated covers the areas listed above. A pass says nothing about them.</p></section>`,
    );
  }

  body.push(
    `<footer><p>Deterministic report — no AI, no API cost. Generated from the suite's own JSON.` +
      (r.trace_mode ? ` Traces: <code>${esc(r.trace_mode)}</code>.` : "") +
      `</p></footer>`,
  );

  return page(v, body.join("\n"));
}

/** The shell. Inline CSS only — the report must render with no network at all. */
function page(v, inner) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>QA suite — ${esc(r.tier ?? "report")}${v.state === "failed" ? " — failed" : ""}</title>
<style>
:root {
  color-scheme: light dark;
  --bg: #fff; --fg: #1c1e21; --muted: #5b6167; --line: #d8dee4;
  --card: #f6f8fa; --bad: #cf222e; --ok: #1a7f37; --warn: #9a6700;
  --code: #f0f2f5;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1117; --fg: #e6edf3; --muted: #9198a1; --line: #30363d;
    --card: #161b22; --bad: #ff7b72; --ok: #3fb950; --warn: #d29922;
    --code: #161b22;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 2rem 1.25rem 4rem; background: var(--bg); color: var(--fg);
  font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
main { max-width: 860px; margin: 0 auto; }
h1 { font-size: 1.6rem; margin: 0 0 .5rem; }
h2 { font-size: 1.15rem; margin: 2.5rem 0 1rem; padding-bottom: .4rem; border-bottom: 1px solid var(--line); }
h3 { font-size: 1rem; margin: 0 0 .5rem; }
code { background: var(--code); padding: .1em .35em; border-radius: 4px; font-size: .875em;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
pre { background: var(--code); border: 1px solid var(--line); border-radius: 6px; padding: .8rem 1rem;
  overflow-x: auto; font-size: .8rem; line-height: 1.5;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
pre code { background: none; padding: 0; }
a { color: inherit; }
.verdict { border-left: 4px solid var(--muted); padding-left: 1rem; }
.verdict.failed, .verdict.broken { border-color: var(--bad); }
.verdict.passed { border-color: var(--ok); }
.counts { font-size: 1.05rem; margin: .25rem 0; }
.counts .ok { color: var(--ok); } .counts .bad { color: var(--bad); } .counts .warn { color: var(--warn); }
.meta, .note, .hedge { color: var(--muted); font-size: .875rem; }
.scope { font-size: .925rem; }
.card { border: 1px solid var(--line); border-left: 3px solid var(--bad); border-radius: 8px;
  background: var(--card); padding: 1.1rem 1.25rem; margin: 0 0 1.25rem; }
.card .n { display: inline-block; min-width: 1.5em; color: var(--muted); }
.why { font-size: .925rem; border-left: 2px solid var(--line); padding-left: .75rem; margin: .75rem 0; }
.dx { background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: .75rem 1rem; margin: .9rem 0; }
.dx p { margin: .25rem 0; font-size: .925rem; }
.dx .hedge { margin-top: .5rem; font-style: italic; }
.er { border-left: 3px solid var(--warn); }
.shots { display: flex; flex-wrap: wrap; gap: .75rem; margin: 1rem 0; }
.shots img { max-width: 100%; width: 380px; border: 1px solid var(--line); border-radius: 6px; display: block; }
details { margin: .6rem 0; }
summary { cursor: pointer; font-size: .9rem; }
table { border-collapse: collapse; width: 100%; font-size: .875rem; }
th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid var(--line); }
ul.files, ul.pass, ul.gaps { padding-left: 1.25rem; font-size: .9rem; }
footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid var(--line); color: var(--muted); font-size: .8rem; }
</style>
</head>
<body><main>
${inner}
</main></body>
</html>
`;
}

// ------------------------------------------------------------------- dispatch

const output = opt.format === "html" ? html() : opt.format === "summary" ? summary() : markdown();

if (opt.out) {
  fs.mkdirSync(path.dirname(path.resolve(opt.out)), { recursive: true });
  fs.writeFileSync(opt.out, output);
} else {
  process.stdout.write(output);
}
