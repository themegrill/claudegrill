#!/usr/bin/env bash
# Boot a disposable WordPress with the product under test mounted from the
# working tree, and print the URL + credentials the agent should drive.
#
# Two engines:
#   playground  (default) - PHP-WASM + SQLite. Boots in seconds, no Docker.
#                           Best for UI/editor/customizer/frontend work.
#   wp-env                - Real MySQL + PHP in Docker. Slower, but correct for
#                           anything touching MySQL-specific SQL, real cron,
#                           mail, or multisite.
#
# Usage:
#   scripts/boot-wp.sh [--engine playground|wp-env] [--wp 6.9] [--php 8.3]
#                      [--port 9400] [--with <slug>=<path> ...] [--reset]
#
# Prints a JSON line: {"url":"http://127.0.0.1:9400","user":"admin","pass":"password",...}

set -euo pipefail

ENGINE="playground"
WP_VERSION="${WP_VERSION:-latest}"
PHP_VERSION="${PHP_VERSION:-8.3}"
PORT="${PORT:-9400}"
RESET=""
EXTRAS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --engine) ENGINE="$2"; shift 2 ;;
    --wp)     WP_VERSION="$2"; shift 2 ;;
    --php)    PHP_VERSION="$2"; shift 2 ;;
    --port)   PORT="$2"; shift 2 ;;
    --with)   EXTRAS+=("$2"); shift 2 ;;
    --reset)  RESET="--reset"; shift ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

# Resolve our own location through any symlink, so a user-level install
# (~/.claude/skills/... symlinked at one clone of themegrill-qa) finds its siblings.
# THEMEGRILL_QA_HOME overrides, for installs that move things around.
SELF="${BASH_SOURCE[0]}"
if command -v readlink >/dev/null && readlink -f "$SELF" >/dev/null 2>&1; then
  SELF="$(readlink -f "$SELF")"
fi
HERE="$(cd "$(dirname "$SELF")" && pwd -P)"
QA_HOME="${THEMEGRILL_QA_HOME:-$(cd "$HERE/.." && pwd -P)}"

INFO="$("$QA_HOME/scripts/detect-product.sh")"
TYPE="$(echo "$INFO"  | python3 -c 'import json,sys; print(json.load(sys.stdin)["type"])')"
SLUG="$(echo "$INFO"  | python3 -c 'import json,sys; print(json.load(sys.stdin)["slug"])')"
ROOT="$(echo "$INFO"  | python3 -c 'import json,sys; print(json.load(sys.stdin)["root"])')"

if [[ "$ENGINE" == "playground" ]]; then
  # --path lets Playground auto-detect that this directory is a theme or plugin
  # and mount it at the right place itself. More robust than constructing the
  # virtual path by hand, and it survives changes to Playground's internals.
  ARGS=( start
         --path="${ROOT}"
         --php="${PHP_VERSION}"
         --wp="${WP_VERSION}"
         --port="${PORT}"
         --login
         --skip-browser
         --quiet
         --define-bool WP_DEBUG true
         --define-bool WP_DEBUG_LOG true
         --define-bool WP_DEBUG_DISPLAY false )

  [[ -n "$RESET" ]] && ARGS+=( "$RESET" )

  # Extra plugins/themes to mount alongside (e.g. a pro add-on, or WooCommerce
  # checked out locally for a compatibility run).
  for e in "${EXTRAS[@]:-}"; do
    [[ -z "$e" ]] && continue
    eslug="${e%%=*}"; epath="${e#*=}"
    ARGS+=( --mount="${epath}:/wordpress/wp-content/plugins/${eslug}" )
  done

  # A blueprint activates the product and seeds content so the agent lands on a
  # site that actually exercises the product rather than a bare install.
  BP="$QA_HOME/blueprints/$([[ "$TYPE" == "theme" ]] && echo theme-test.json || echo plugin-test.json)"
  if [[ -f "$BP" ]]; then
    RENDERED="$(mktemp /tmp/bp-XXXXXX.json)"
    ENTRY_FILE="$(echo "$INFO" | python3 -c 'import json,sys; print(json.load(sys.stdin)["entry"])')"
    sed -e "s/__SLUG__/${SLUG}/g" -e "s|__ENTRY__|${ENTRY_FILE}|g" "$BP" > "$RENDERED"
    ARGS+=( --blueprint="$RENDERED" )
  fi

  npx --yes @wp-playground/cli@latest "${ARGS[@]}" > /tmp/playground.log 2>&1 &
  BOOT_PID=$!

  # Wait for the server rather than sleeping a fixed amount.
  for i in $(seq 1 90); do
    if curl -fsS -o /dev/null "http://127.0.0.1:${PORT}/"; then break; fi
    if ! kill -0 "$BOOT_PID" 2>/dev/null; then
      echo "playground exited early; log follows:" >&2
      cat /tmp/playground.log >&2
      # Playground fetches WordPress and PHP.wasm over the network on first boot.
      # In a locked-down runner this surfaces as an opaque JSON parse error,
      # because an HTML error page arrives where a zip was expected.
      if grep -qiE 'not valid JSON|Host not|ENOTFOUND|ETIMEDOUT|certificate' /tmp/playground.log; then
        echo "" >&2
        echo "HINT: this looks like blocked network egress, not a bad config." >&2
        echo "      Playground needs playground.wordpress.net and wordpress.org" >&2
        echo "      on first boot. Allowlist them, pre-warm the cache at" >&2
        echo "      ~/.wordpress-playground, or use --engine wp-env instead." >&2
      fi
      exit 1
    fi
    sleep 1
  done

  python3 -c "
import json
print(json.dumps({
  'engine':'playground','url':'http://127.0.0.1:${PORT}',
  'admin':'http://127.0.0.1:${PORT}/wp-admin/','user':'admin','pass':'password',
  'autologin':True,'pid':${BOOT_PID},'log':'/tmp/playground.log',
  'php':'${PHP_VERSION}','wp':'${WP_VERSION}','slug':'${SLUG}','type':'${TYPE}',
  'caveats':['SQLite not MySQL','no real cron','no outbound mail']
}))"

elif [[ "$ENGINE" == "wp-env" ]]; then
  command -v docker >/dev/null || { echo "wp-env needs Docker" >&2; exit 1; }
  npx --yes @wordpress/env@latest start
  npx --yes @wordpress/env@latest run cli \
      wp "$([[ "$TYPE" == "theme" ]] && echo 'theme activate' || echo 'plugin activate')" "$SLUG" || true
  python3 -c "
import json
print(json.dumps({
  'engine':'wp-env','url':'http://localhost:8888',
  'admin':'http://localhost:8888/wp-admin/','user':'admin','pass':'password',
  'autologin':False,'slug':'${SLUG}','type':'${TYPE}','caveats':[]
}))"
else
  echo "unknown engine: $ENGINE" >&2; exit 2
fi
