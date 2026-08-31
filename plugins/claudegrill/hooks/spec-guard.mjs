#!/usr/bin/env node
/**
 * Notice when a session changed product source and wrote no spec.
 *
 * Runs on `Stop`. The requirement it is built around is **silence**: a hook that
 * talks on every session gets disabled within a week, and then the whole
 * mechanism is gone — including the one time it would have mattered. So it says
 * nothing at all unless there is genuinely an unguarded change, and it says it
 * once per branch rather than once per turn.
 *
 * It never blocks. Exit 2 is the only code that can block a Stop, and nothing
 * here is worth interrupting a developer for. Every failure path exits 0.
 *
 * One caveat, verified against the Claude Code hooks documentation rather than
 * assumed: **on exit 0 a hook's stderr goes to the debug log, not to the user.**
 * The line below is therefore visible under `claude --debug`, and the mechanism
 * that actually reaches a human is the queue file itself — committed, in the
 * repo, and read back by `/write-spec` and `pr-qa-review`. That is deliberate:
 * the queue being visible in the repo is what makes it get drained.
 *
 * Contract: SUITE.md §8.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

/** Product source, as opposed to tests, docs, translations and CI config. */
const SOURCE_EXT = /\.(php|js|jsx|ts|tsx|mjs|cjs|scss|sass|css)$/i;

/** Nothing in here is worth failing a developer's session over. */
function quit() {
  process.exit(0);
}

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  // The Stop payload carries the session's cwd; fall back to ours.
  let cwd = process.cwd();
  try {
    const payload = JSON.parse((await readStdin()) || "{}");
    if (payload.cwd && fs.existsSync(payload.cwd)) cwd = payload.cwd;
  } catch {
    /* no payload, or not JSON — our own cwd is a fine default */
  }

  let root;
  try {
    root = git(["rev-parse", "--show-toplevel"], cwd);
  } catch {
    quit(); // not a git checkout
  }

  // --- 1. Is this a product repo that has opted in? ------------------------
  //
  // The manifest is read directly rather than through detect-product.mjs. This
  // runs at the end of every turn, so it must cost nothing: reading one small
  // file beats spawning a Node process that scans for WordPress headers.
  const manifestPath = path.join(root, ".themegrill-qa", "suite.json");
  if (!fs.existsSync(manifestPath)) quit();

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    quit(); // a broken manifest is run-suite's problem to report, not ours
  }
  const specDir = (manifest.spec_dir ?? "tests/e2e/specs").replace(/\/+$/, "");

  // --- 2. Did this session touch product source? ---------------------------
  //
  // `git status --porcelain` rather than `git diff HEAD` because it also sees
  // untracked files — and a brand-new spec file is untracked, which is exactly
  // the case that must NOT be reported as unguarded.
  let changed;
  try {
    changed = git(["status", "--porcelain", "--untracked-files=all"], root)
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const p = line.slice(3);
        // Renames arrive as `old -> new`; the new path is what matters.
        const arrow = p.indexOf(" -> ");
        return (arrow === -1 ? p : p.slice(arrow + 4)).replace(/^"|"$/g, "");
      });
  } catch {
    quit();
  }

  const isTest = (f) =>
    f.startsWith(`${specDir}/`) ||
    /(^|\/)tests?\//i.test(f) ||
    /\.spec\.[cm]?[jt]sx?$/.test(f);

  const sourceChanged = changed.filter((f) => SOURCE_EXT.test(f) && !isTest(f));
  if (sourceChanged.length === 0) quit();

  // --- 3. Was a spec written alongside it? ---------------------------------
  const specChanged = changed.some(
    (f) => f.startsWith(`${specDir}/`) || /\.spec\.[cm]?[jt]sx?$/.test(f),
  );
  if (specChanged) quit();

  // --- 4. Queue it, once per branch -----------------------------------------
  let branch = "";
  let sha = "";
  try {
    branch = git(["rev-parse", "--abbrev-ref", "HEAD"], root);
    sha = git(["rev-parse", "HEAD"], root);
  } catch {
    /* a repo with no commits yet still deserves a queue entry */
  }

  const queuePath = path.join(root, ".themegrill-qa", "spec-queue.jsonl");

  // Dedup: one nag per branch. Without this the same unguarded change is queued
  // at the end of every turn, and the queue becomes noise nobody drains.
  if (fs.existsSync(queuePath)) {
    try {
      const already = fs
        .readFileSync(queuePath, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .some((line) => {
          try {
            const rec = JSON.parse(line);
            return rec.branch === branch && rec.status === "pending";
          } catch {
            return false;
          }
        });
      if (already) quit();
    } catch {
      /* unreadable queue: fall through and append */
    }
  }

  const record = {
    ts: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    branch,
    jira: (branch.match(/[A-Z][A-Z0-9]+-\d+/) ?? [null])[0],
    files: sourceChanged.slice(0, 20),
    sha,
    status: "pending",
  };

  try {
    fs.mkdirSync(path.dirname(queuePath), { recursive: true });
    // Append, never rewrite: one object per line means concurrent writers do
    // not clobber each other, the same reason the findings ledger works this way.
    fs.appendFileSync(queuePath, JSON.stringify(record) + "\n");
  } catch {
    quit(); // cannot write? then say nothing, rather than nagging with no record
  }

  process.stderr.write(
    "claudegrill: source changed with no new spec — run /write-spec (queued 1 item)\n",
  );
  quit();
}

main().catch(quit);
