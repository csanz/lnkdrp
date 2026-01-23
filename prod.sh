#!/usr/bin/env bash
#
# Local production runner (build + start).
# Use this to validate performance characteristics that differ from dev mode.
#
# Usage:
#   ./prod.sh
#   PORT=3002 ./prod.sh
#   ./prod.sh --skip-build
#

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

PORT="${PORT:-3001}"
SKIP_BUILD="${SKIP_BUILD:-0}"

for arg in "$@"; do
  case "$arg" in
    --skip-build)
      SKIP_BUILD="1"
      ;;
    -h|--help)
      echo "Usage: ./prod.sh [--skip-build]"
      echo
      echo "Environment:"
      echo "  PORT=<port>         Port to run on (default: 3001)"
      echo "  SKIP_BUILD=1        Skip 'next build' and only run 'next start'"
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      echo "Run: ./prod.sh --help" >&2
      exit 2
      ;;
  esac
done

export NODE_ENV="production"
export NEXT_TELEMETRY_DISABLED="${NEXT_TELEMETRY_DISABLED:-1}"

NEXT_BIN="$ROOT_DIR/node_modules/.bin/next"
if [[ ! -x "$NEXT_BIN" ]]; then
  echo "Missing Next.js binary at: $NEXT_BIN" >&2
  echo "Run: npm install" >&2
  exit 1
fi

if [[ "$SKIP_BUILD" != "1" ]]; then
  echo "[prod.sh] Building (NODE_ENV=production)…"
  "$NEXT_BIN" build
fi

echo "[prod.sh] Starting production server on http://localhost:${PORT} …"
exec "$NEXT_BIN" start -p "$PORT"
