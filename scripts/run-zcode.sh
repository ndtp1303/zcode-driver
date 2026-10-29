#!/usr/bin/env bash
# Run one zcode remote job, or a status/list/continue/stop/approval command.
# Usage: run-zcode.sh [--url URL] [--timeout SEC] <workdir> <prompt-file | "prompt">
#        run-zcode.sh status|list|continue|stop|approvals|approve ...
# Output of a run: <workdir>/run.jsonl, final.txt, run.err, meta.json
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if ! command -v node >/dev/null 2>&1; then
  echo "node missing (need >= 22)" >&2
  exit 2
fi
exec node "$ROOT/src/cli.js" "$@"
