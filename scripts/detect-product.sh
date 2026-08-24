#!/usr/bin/env bash
# Detect what WordPress product lives in the current directory.
#
# This is what makes `/verify-fix` work with "little to no context": the agent
# does not need to be told which product it is looking at, what the slug is, or
# whether it is a theme or a plugin. It reads that from the source itself.
#
# Emits JSON on stdout:
#   {"type":"theme","slug":"colormag","name":"ColorMag","version":"4.0.1",
#    "textdomain":"colormag","root":"/path/to/repo","knowledge":"knowledge/colormag.md"}
#
# Usage: scripts/detect-product.sh [path]   (defaults to $PWD)

set -euo pipefail

TARGET="${1:-$PWD}"
cd "$TARGET"

# Walk up to the repo root so this works from any subdirectory.
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "$TARGET")"
cd "$ROOT"

header_field() {
  # $1 = file, $2 = header name. WordPress headers look like "Theme Name: ColorMag"
  # Only scan the first 60 lines: headers are always at the top and this avoids
  # matching similarly-named strings deeper in the file.
  head -n 60 "$1" \
    | grep -i -m1 "^[[:space:]]*\*\?[[:space:]]*${2}[[:space:]]*:" \
    | sed -E "s/^[[:space:]]*\*?[[:space:]]*${2}[[:space:]]*:[[:space:]]*//I" \
    | tr -d '\r' \
    | sed -E 's/[[:space:]]+$//' || true
}

TYPE=""; NAME=""; VERSION=""; TEXTDOMAIN=""; ENTRY=""

# --- Theme? style.css with a "Theme Name" header is definitive. ---
if [[ -f style.css ]] && [[ -n "$(header_field style.css 'Theme Name')" ]]; then
  TYPE="theme"
  ENTRY="style.css"
  NAME="$(header_field style.css 'Theme Name')"
  VERSION="$(header_field style.css 'Version')"
  TEXTDOMAIN="$(header_field style.css 'Text Domain')"
fi

# --- Plugin? find the PHP file carrying a "Plugin Name" header. ---
if [[ -z "$TYPE" ]]; then
  # Prefer a root-level PHP file; fall back to a shallow scan.
  for f in *.php $(find . -maxdepth 2 -name '*.php' -not -path './vendor/*' \
                        -not -path './node_modules/*' 2>/dev/null | head -40); do
    [[ -f "$f" ]] || continue
    if [[ -n "$(header_field "$f" 'Plugin Name')" ]]; then
      TYPE="plugin"
      ENTRY="${f#./}"
      NAME="$(header_field "$f" 'Plugin Name')"
      VERSION="$(header_field "$f" 'Version')"
      TEXTDOMAIN="$(header_field "$f" 'Text Domain')"
      break
    fi
  done
fi

if [[ -z "$TYPE" ]]; then
  echo '{"error":"not a WordPress theme or plugin: no Theme Name or Plugin Name header found"}'
  exit 1
fi

# Slug: text domain is the most reliable slug source in this catalogue.
# Fall back to the directory name.
SLUG="${TEXTDOMAIN:-$(basename "$ROOT")}"
SLUG="$(echo "$SLUG" | tr '[:upper:]' '[:lower:]' | tr ' _' '--')"

# Locate the product knowledge file. A copy living inside the product repo wins
# over the central one: colocating it means the PR that renames an option can
# update its description in the same commit, which is the only thing that
# reliably stops the file drifting out of sync with the code.
KNOWLEDGE=""
for candidate in ".themegrill-qa/knowledge.md" \
                 "knowledge/${SLUG}.md" \
                 "../themegrill-qa/knowledge/${SLUG}.md" \
                 "${THEMEGRILL_QA_HOME:-}/knowledge/${SLUG}.md"; do
  if [[ -n "$candidate" && -f "$candidate" ]]; then
    KNOWLEDGE="$candidate"; break
  fi
done

# Branch and ticket key: a branch like fix/CM-1234-header-overlap tells the agent
# which Jira issue this work belongs to without anyone typing it.
BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')"
TICKET="$(echo "$BRANCH" | grep -oE '[A-Z][A-Z0-9]+-[0-9]+' | head -1 || true)"

# Pro companion: many of these products ship a free repo plus a pro add-on.
HAS_PRO="false"
[[ -d "../${SLUG}-pro" || -d "./${SLUG}-pro" ]] && HAS_PRO="true"

python3 - "$TYPE" "$SLUG" "$NAME" "$VERSION" "$TEXTDOMAIN" "$ROOT" \
            "$KNOWLEDGE" "$ENTRY" "$BRANCH" "$TICKET" "$HAS_PRO" <<'PY'
import json, sys
k = ["type","slug","name","version","textdomain","root","knowledge","entry","branch","ticket","has_pro"]
d = dict(zip(k, sys.argv[1:]))
d["has_pro"] = d["has_pro"] == "true"
for f in ("knowledge","ticket","version","textdomain"):
    if not d.get(f): d[f] = None
print(json.dumps(d, indent=2))
PY
