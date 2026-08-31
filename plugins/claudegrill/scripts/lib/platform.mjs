/**
 * The four things every script in here has to get right on Windows.
 *
 * Extracted from `boot-wp.mjs`, where each of these was learned the hard way
 * against a real ColorMag checkout. Sharing them means `run-suite.mjs` inherits
 * the fixes rather than rediscovering the bugs.
 */

import { execFileSync } from "node:child_process";
import process from "node:process";

export const isWindows = process.platform === "win32";

/** npx, spelled correctly for the platform. */
export function npxCommand() {
  return isWindows ? "npx.cmd" : "npx";
}

/**
 * Quote one argument for Windows' `shell: true` spawn path.
 *
 * `.cmd` files (npx.cmd) can only be launched with `shell: true`, and Node does
 * not escape array-form arguments for that path the way it does for a plain
 * (non-shell) spawn — it just joins them with spaces. Any argument containing a
 * space (a `--path=` flag built from `Local Sites\...`, `Program Files\...`,
 * anything under a directory a human named) then splits into two shell tokens
 * and the child process receives garbage. Confirmed breaking `--path=` this way
 * when the mounted theme lived under `Local Sites`. Wrapping the whole token in
 * double quotes is enough here — every value these scripts build is a path,
 * version string, slug or grep pattern, none of which legitimately contain a `"`.
 *
 * Whitespace is not the only trigger. `run-suite.mjs` builds Playwright `--grep`
 * patterns like `(?=.*@fresh)(?=.*@header)`, which contain no space at all and
 * which `cmd.exe` would treat as grouping syntax. So quote on any character cmd
 * gives meaning to, not merely on spaces.
 */
export function shellQuote(arg) {
  return isWindows && /[\s()&|<>^%!]/.test(arg) ? `"${arg}"` : arg;
}

/**
 * Kill a process and everything it started.
 *
 * A bare `process.kill(pid)` on Windows leaves the child tree running — for
 * Playwright that means orphaned browser processes holding the report file open.
 * On POSIX the negative pid targets the whole process group, which requires the
 * child to have been spawned `detached: true`.
 */
export function killTree(pid) {
  try {
    if (isWindows) {
      execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
      });
    } else {
      process.kill(-pid, "SIGTERM"); // negative: the whole process group
    }
    return true;
  } catch {
    try {
      process.kill(pid, "SIGTERM");
      return true;
    } catch {
      return false;
    }
  }
}
