# The suite contract

How a ThemeGrill product declares its Playwright suite to this platform, and what
the platform promises in return.

This document is the interface. `run-suite.mjs`, `suite-index.mjs`, the
`write-spec` skill and every workflow are implementations of it. A product repo
conforms to it by adding two files. Nothing else in either repo needs to change.

---

## Why this exists

An agent finding has to be rediscovered on every run. The same finding as a
committed spec is checked deterministically, the same way, forever.

So the platform runs a product's existing suite first, looks at only what the
suite does not already cover, and converts every verified finding into a
committed spec. The deterministic layer grows; the part that needs an agent
shrinks.

A product with no suite loses nothing. Every part of this degrades to the
platform's previous behaviour when `suite.json` is absent.

---

## 1. The manifest

A product declares its suite at **`.themegrill-qa/suite.json`**, in the product
repo. If the file is absent the product has no suite, and every consumer treats
that as a valid state rather than an error.

```json
{
  "runner": "playwright",
  "package_manager": "pnpm",
  "install": "pnpm install --frozen-lockfile",
  "command": "pnpm exec playwright test",
  "config": "playwright.config.ts",
  "spec_dir": "tests/e2e/specs",
  "spec_extension": ".spec.ts",
  "json_report": "test-results/results.json",
  "env": {
    "base_url": "CM_BASE_URL",
    "admin_user": "CM_ADMIN_USER",
    "admin_pass": "CM_ADMIN_PASS"
  },
  "tiers": {
    "fresh": "@fresh",
    "demo": "@demo"
  }
}
```

| Field | Required | Meaning |
|---|---|---|
| `runner` | yes | Only `playwright` is implemented. Anything else is rejected with exit 2. |
| `command` | yes | How to invoke the runner. Platform flags are appended to it. |
| `spec_dir` | yes | Where specs live, repo-relative. `suite-index.mjs` globs this. |
| `json_report` | yes | Where the JSON reporter writes, repo-relative. |
| `package_manager` | no | Inferred from the lockfile. |
| `install` | no | Skipped entirely when absent; `--install` then does nothing. |
| `config` | no | Inferred from a conventional `playwright.config.*` at the repo root. |
| `spec_extension` | no | Defaults to `.spec.ts`, then `.spec.js`. |
| `env` | no | See §4. Absent means only the generic `TGQA_*` names are exported. |
| `tiers` | no | Defaults to `{"fresh": "@fresh", "demo": "@demo"}`. |

**`env` maps the platform's generic concepts onto whatever variable names the
product's suite already uses**, so no product has to rename its variables to join
in.

Anything inferred rather than declared is **named on stderr** — "config: inferred
playwright.config.ts", "package_manager: inferred pnpm from pnpm-lock.yaml" — so
a wrong inference is visible rather than silent.

---

## 2. Tiers

This is the single most important design decision in the contract.

A product's specs cannot all run everywhere, and pretending otherwise is what
makes a green run a lie. ColorMag's suite was written against a hand-maintained
Local site with the ThemeGrill "Main" demo imported. A fresh `boot-wp` site has
none of that.

So every test carries a tier tag **in its title**, because the title is what
Playwright's `--grep` matches:

| Tag | Runs on | Meaning |
|---|---|---|
| `@fresh` | a clean `boot-wp` site seeded only by the blueprint | CI-safe. This is the tier that gates PRs. |
| `@demo` | a site with the product's demo content imported | Local / nightly only. **Not CI coverage.** |

Rules, enforced in code and not merely documented:

- **A test with no tier tag is treated as `@demo`** — the conservative reading.
  Never assume untagged means safe. `suite-index.mjs` counts untagged tests under
  `demo` and reports them separately as a hygiene number.
- **CI only ever runs `@fresh`.** A `@demo` test must never gate a PR, because it
  cannot be reproduced on a runner.
- **Every spec the agent writes is `@fresh`**, or it does not get written. If a
  finding can only be reproduced on a demo-imported site, the spec's blueprint
  requirement *is itself the finding* — report that and write no spec.

### 2b. The licence axis — `@pro` and `@unlicensed`

**Orthogonal to the tier, not a third value of it.** `@fresh`/`@demo` say which
*site* a spec needs; these say which *licence state* it needs. A spec is
`@fresh @pro`, or `@fresh @unlicensed`, or `@fresh` alone — never one instead of
the other, which is why `suite-index.mjs` reports `by_pro` separately and why the
tier counts still sum to the test count.

| Tag | Needs | Runs where |
|---|---|---|
| `@pro` | pro code mounted **and** a licence that resolved to VALID | the `pro` CI job |
| `@unlicensed` | pro code mounted **and deliberately no licence** | the `unlicensed` CI job |
| *(neither)* | nothing | everywhere, **including with pro installed** |

Four rules, and the third is the one people miss:

- **A `@pro` run either has a valid licence or it fails.** It does not skip
  quietly and it does not pass. `run-suite.mjs --pro` verifies the licence
  through the booted site's own probe before a single spec runs, and refuses with
  `licence not active — pro features not under test` (exit 2 — a broken harness,
  not a failing product). A pro suite that silently exercised the free code path
  is worse than no pro suite, because it reports coverage that does not exist.
- **`@pro` is EXCLUDED from every non-pro run.** Those specs need code that is
  not mounted; running them would fail for the wrong reason, and skipping them
  silently would hide that pro is untested.
- **Untagged specs must pass with pro installed as well as without it.**
  "Installing pro breaks a free feature" is a real and expensive bug class and
  the only thing that catches it is running the free suite in the pro
  environment — the `free-with-pro` job, which is a distinct CI job and not an
  afterthought. This is not hypothetical: it found ColorMag Pro shipping the
  pre-CMAG-650 version of the lone-logo header rule on its first run.
- **`@unlicensed` needs a DIFFERENT SITE**, one booted `--with-pro` and without
  `--license`, which is why it is a separate job rather than a filter. It covers
  the state every customer passes through between installing a pro product and
  entering their key — and the one nobody develops in.

### `area_paths` — which specs a diff could have broken

Optional, and only needed if you want CI to narrow a PR to the areas it touches.
It maps product source paths onto area names:

```json
"area_paths": {
  "header":  ["inc/customizer/options/header-builder/**", "template-parts/header/**"],
  "content": ["inc/colormag-wp-query.php", "template-parts/content/**"]
}
```

`run-suite.mjs --since <base-ref>` diffs against that ref, maps the changed files
through this table, and runs only those areas.

**The safety rule, and the only reason narrowing can be trusted:**

| What changed | What runs |
|---|---|
| source files, all matching a pattern | those areas only |
| a source file matching **no** pattern | **the full tier** |
| anything under `tests/` that is not a spec (fixtures, setup, helpers) | **the full tier** — a broken fixture can break any spec |
| a spec file | that spec's own area |
| no product source at all — docs, translations, CI | nothing, reported as `mode: "none"` |
| the manifest declares no `area_paths` | **the full tier** |

An omission in this table therefore costs **runner time, never coverage**. Err
toward broad patterns. Narrowing on a diff nobody mapped is how a change ships
with no coverage and a green tick over it.

Two things are always included regardless of the mapping: the specs whose
`@guards` names the branch's Jira key, and the areas of any spec file the branch
itself changed.

**Scoping trades total coverage per PR for speed, so something else has to run
the full tier.** Once PR runs are scoped, nothing else does — a spec whose area
is never touched stops executing entirely. Pair it with the scheduled full run in
`examples/caller-suite.yml`. That schedule is not garnish; it is the half of the
bargain that keeps the suite honest.

### The area dimension

Additive and optional: an `@area` tag matching an area name from the product's
knowledge file — `@header`, `@content`, `@customizer`. This is what lets a sweep
shard run only its own area's specs, and what lets `suite-index.mjs` tell the
agent which areas it does not need to look at.

Tags are lowercase, hyphenated, and match the knowledge file's critical-flow
names exactly. A tag that matches nothing in the knowledge file is reported as
unrecognised rather than silently accepted.

---

## 3. Spec annotation

Every test carries a docblock immediately above it. `suite-index.mjs` parses it
with a regex over source text — there is no TypeScript parser anywhere in this
platform and there will not be one.

```js
/**
 * @area    header
 * @tier    fresh
 * @guards  CMAG-1234
 * @source  verify-fix 2026-08-24
 * @why     Switching to the centered header layout dropped the tagline entirely.
 *          Guards the regression, not the layout's styling.
 */
test('centered header keeps the tagline @fresh @header', async ({ page }) => {
```

| Field | Required | Meaning |
|---|---|---|
| `@why` | **yes** | Why this spec exists. `CONVENTIONS.md` rule 6 already requires it; this makes it machine-readable. |
| `@area` | recommended | Matches the title's `@area` tag. Redundancy is deliberate: the title drives `--grep`, the docblock drives the index, and a mismatch between them is a reportable hygiene error. |
| `@tier` | recommended | Same. |
| `@guards` | when applicable | The Jira key or bug identifier this spec exists to prevent recurring. Comma-separated for several. |
| `@source` | when written by the platform | Which skill wrote it and when — `verify-fix 2026-08-24`, `regression-sweep 2026-08-24`, or `human`. |

A missing field is `null`, never a crash. The count of tests with an incomplete
docblock is reported, so the suite's own hygiene is visible.

---

## 4. Environment variables

`run-suite.mjs` exports these before invoking the runner, mapping through the
manifest's `env` block:

| Concept | Generic name | Also exported as |
|---|---|---|
| Site URL | `TGQA_BASE_URL` | whatever `env.base_url` names |
| Admin user | `TGQA_ADMIN_USER` | whatever `env.admin_user` names |
| Admin password | `TGQA_ADMIN_PASS` | whatever `env.admin_pass` names |
| Environment label | `TGQA_ENV` | — (`playground` \| `wp-env` \| `local`) |
| Tier being run | `TGQA_TIER` | — |

Exporting both means a product's existing suite keeps working unchanged, while
new specs can be written against the generic names.

### Where the site and credentials come from

`run-suite.mjs` resolves the base URL in strict precedence:

1. `--base-url <url>`
2. `TGQA_BASE_URL` in the environment
3. **`.themegrill-qa/.env.local`** in the product repo — gitignored
4. `--boot [playground|wp-env]`, which boots a disposable site and tears it down

**The developer's existing site comes before booting a fresh one, deliberately.**
Booting is the slow, network-dependent step, and someone fixing a bug already has
the site that bug lives on. Playground is the fallback, not the default.

`.env.local` is `KEY=value`, `#` comments, optional quotes. Both the generic
names and the product's own mapped names are read:

```
TGQA_BASE_URL=http://test-colormag.local
CM_ADMIN_USER=admin
CM_ADMIN_PASS=password
```

**Credentials are never written to a file this repo tracks.** They come from the
environment, from that gitignored `.env.local`, or from CI secrets. If you find
yourself typing a password into a spec, a config or a workflow, stop.

Add `.env.local` to the product's `.gitignore` before writing one.

### Running it cheaply

`--json` (implied whenever stdout is not a TTY) suppresses all progress and sends
the runner's own output to a log file named in the result's `log` field. **This
matters for cost when an agent is the caller:** the suite is plain Node and
spends no tokens, but every line it prints is a line the agent pays to read.
Quiet mode is ~300 characters instead of ~2.5KB on ColorMag.

---

## 5. The output contract

`run-suite.mjs` emits **exactly one line of JSON on stdout** and nothing else.
All human-readable progress goes to stderr.

```json
{
  "ok": false,
  "suite": true,
  "runner": "playwright",
  "tier": "fresh",
  "env": "playground",
  "base_url": "http://127.0.0.1:9400",
  "duration_ms": 91234,
  "total": 61, "passed": 57, "failed": 2, "skipped": 1, "flaky": 1,
  "html_report": "playwright-report",
  "trace_mode": "retain-on-failure",
  "failures": [
    {
      "title": "centered header keeps the tagline @fresh @header",
      "file": "tests/e2e/specs/header-layout.spec.ts",
      "line": 31,
      "area": "header",
      "guards": ["CMAG-1234"],
      "why": "the tagline vanished at the centered layout in 3.1.4",
      "error": "first 400 chars of the failure message",
      "error_full": "the same message, to 4000 chars",
      "error_snippet": "  30 | ...\n> 31 | await expect(...)\n     |       ^",
      "location": { "file": "tests/e2e/specs/header-layout.spec.ts", "line": 44, "column": 9 },
      "errors": ["every error on the last attempt, not just the first"],
      "attachments": [
        { "name": "screenshot", "content_type": "image/png", "path": "test-results/.../test-failed-1.png" },
        { "name": "trace", "content_type": "application/zip", "path": "test-results/.../trace.zip" }
      ],
      "retries": 1,
      "attempts": [
        { "retry": 0, "status": "failed", "duration_ms": 14200, "error": "...", "attachments": [] }
      ]
    }
  ],
  "fixme": [{ "title": "...", "guards": ["CMAG-733"] }],
  "flaky_tests": [{ "title": "...", "file": "...", "line": 12, "area": "header", "retries": 1, "error": "..." }],
  "passed_tests": null
}
```

### Evidence, and the fields that carry it

Every field above is **additive** — consumers that read the older, smaller shape
keep working. Three of them repay explanation:

- **`location` is where the failure actually happened; `line` is only where the
  test opens.** Report `location` when it is present and fall back to `line`.
  Playwright supplies `location` and `error_snippet` for assertion failures and
  omits both for a bare test timeout, which has no assertion site — verified
  against 1.62.1, so a consumer must handle their absence.
- **`attachments` are objects**, not the bare strings this contract once
  specified, because `screenshot`, `trace` and `video` are three different
  offers to a reader and telling them apart by file extension is guesswork.
- **`passed_tests` is `null` unless `--full-results` was passed**, which
  distinguishes "nothing passed" from "nobody asked". It is opt-in because every
  line of stdout is context an agent pays for on every run.

The platform forces `--reporter=json,html` and `--trace=retain-on-failure` on the
command line, never in the product's config, the same way it already forced
`--reporter=json`. So a run leaves a Playwright HTML report at `html_report`
alongside the JSON, and a trace for the tests that failed — at no cost to the
tests that passed. `--no-trace` and `--no-html-report` opt out.

There is deliberately **no video**. Playwright exposes `--trace` on the CLI but
not `--video` or `--screenshot`; those are config-only, so capturing video would
mean editing every product's `playwright.config.ts`. The trace already carries a
frame-by-frame filmstrip, the DOM at each step, the network log and the console.

When there is no manifest:

```json
{ "ok": true, "suite": false, "reason": "no suite manifest" }
```

`ok` is `false` on any failure. `flaky` counts tests that passed on retry —
surface it, because a flaky suite erodes trust faster than a failing one.

### Exit codes

Callers need to distinguish "tests failed" from "harness broken", and before this
contract nothing did.

| Code | Meaning |
|---|---|
| `0` | Suite passed, or there is no suite |
| `1` | The suite ran and tests failed |
| `2` | Could not run — no base URL, install failed, runner missing, bad manifest, timeout |

---

## 5b. The report

`report-suite.mjs` turns a run into something a person can act on. It reads
`suite.json` and `index.json`, re-runs nothing, costs nothing, and is the single
composer for all three surfaces — the PR comment, the step summary and the HTML
report. Two of those used to be written inline in `suite.yml` and had already
drifted apart from each other.

```
node scripts/report-suite.mjs --suite suite.json --index index.json \
  --format md|summary|html [--out FILE] [--product-dir DIR] \
  [--repo owner/name --sha SHA] [--artifact-url URL] [--run-url URL]
```

| Flag | Why it matters |
|---|---|
| `--format md` | The PR comment. Marker-tagged so the workflow edits one comment in place. |
| `--format summary` | The same, plus suite-hygiene lines, for `$GITHUB_STEP_SUMMARY`. |
| `--format html` | The self-contained page. |
| `--product-dir` | Where the repo-relative attachment paths resolve. CI passes `product`. |
| `--repo` / `--sha` | Turns the failing location into a clickable blob permalink. |
| `--artifact-url` | Links the evidence. Uploaded-and-never-linked is how the artifact spent its whole life invisible. |

Three properties are load-bearing:

1. **It always produces a verdict.** It runs under `if: always()`, which is
   precisely when things have gone wrong, so a missing or unparseable
   `suite.json` reports "could not run" rather than throwing and leaving a red
   check with no explanation.
2. **The HTML is genuinely self-contained** — screenshots inlined as data URIs,
   CSS inline, no script, no network request of any kind. It has to survive
   being downloaded, unzipped and opened from disk with no server.
3. **The comment respects a byte budget.** GitHub rejects a comment over 65536
   characters, so a broadly red run drops the tail of the failure list and says
   so, rather than posting nothing at all.

### The diagnosis is a guess, and says so

`lib/diagnose.mjs` maps a failure's error text to a plain-English cause and a
first thing to check — "the element never appeared", "the site was not serving",
"a behavioural change". It is a lookup table: deterministic, free, and no agent
runs on the PR path.

Every diagnosis is worded as *usually means* and carries a visible hedge in the
report. A deterministic guess labelled a guess helps a reviewer start in the
right place. The same guess presented as a finding would undercut invariant 5 —
a finding needs reproduction twice plus cited evidence, and a regex over an error
string has neither.

---

## 6. The index contract

`suite-index.mjs` emits one line of JSON describing what the suite covers.

```json
{
  "suite": true,
  "spec_files": 18,
  "tests": 61,
  "by_tier": { "fresh": 44, "demo": 17 },
  "by_area": { "header": 9, "content": 14, "customizer": 12 },
  "guards": { "CMAG-733": ["tests/e2e/specs/console.spec.ts:12"] },
  "fixme": [{ "title": "...", "file": "...", "guards": ["CMAG-733"], "why": "..." }],
  "areas_covered": ["header", "content", "customizer"],
  "areas_uncovered": ["footer", "widgets", "front-page", "activation"],
  "thinnest_areas": ["footer", "widgets"]
}
```

**`areas_uncovered` is the backlog.** It is the difference between the areas
declared in the product's `.themegrill-qa/knowledge.md` (or `docs-index.json`'s
`suggested_areas`) and the areas the suite actually covers, and **it is where
attention belongs**. An area with green `@fresh` specs does not need an agent
shard; an area with none does.

`thinnest_areas` ranks covered-but-barely areas — fewer than three `@fresh` tests
— so a sweep can top them up rather than treating one smoke test as coverage.

---

## 7. What a product repo adds

Two files, and nothing else:

```
.themegrill-qa/
  suite.json         the manifest above
  spec-queue.jsonl   source changes with no spec yet (committed, see §8)
```

`knowledge.md` and the findings ledger already live there. No dependency on this
repo is added to the product; the workflows check this repo out at run time.

---

## 8. The spec queue

`.themegrill-qa/spec-queue.jsonl` is one JSON object per line, appended never
rewritten, and **committed**:

```json
{"ts":"2026-08-25T09:12:00Z","branch":"fix/CMAG-1234-header","jira":"CMAG-1234","files":["inc/customizer/header.php"],"sha":"<HEAD>","status":"pending"}
```

The `spec-guard` hook appends a `pending` record when a session changes product
source without touching `spec_dir`. `/write-spec` with no arguments drains the
oldest pending item. `/verify-fix` marks its item `done` when it graduates a
finding. `pr-qa-review` reads the queue and adds a one-line nudge to its comment.

It is committed rather than gitignored on purpose: the queue being visible in the
repo is what makes it get drained.

---

## 9. Where work lives, and which way it moves

| Layer | Remembers | Where | Re-checked by |
|---|---|---|---|
| `knowledge.md` | how the product is *meant* to work | product repo | reading it |
| findings ledger `.jsonl` | every confirmed finding, fingerprinted | product repo | reading it |
| `tests/e2e/**` | the bug, frozen as a deterministic assertion | product repo | the runner |
| agent exploration | anything not yet in the three above | — | **an agent, every run** |

**Work moves downward through those layers, never upward.** Something the agent
discovered becomes a spec; something a spec proved becomes a line in the
knowledge file. Nothing that is already a spec goes back to being explored.
