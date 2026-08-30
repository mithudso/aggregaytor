#!/usr/bin/env bash
# watch_and_index.sh — re-run the semantic indexer whenever tracked source dirs change.
#
# Prefers fswatch (brew install fswatch); falls back to a 30-second
# `find -newer` polling loop when fswatch is not installed.
#
# Usage: ./scripts/watch_and_index.sh
# Stop with Ctrl-C.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

WATCH_DIRS=(packages adapters extensions tools scripts docs skills)
INDEXER=(python3 scripts/semantic_indexer.py)
POLL_SECONDS=30

# Only these dirs actually present (guards against layout changes).
PRESENT_DIRS=()
for d in "${WATCH_DIRS[@]}"; do
  [ -d "$d" ] && PRESENT_DIRS+=("$d")
done
if [ ${#PRESENT_DIRS[@]} -eq 0 ]; then
  echo "watch_and_index: none of the tracked dirs exist under $REPO_ROOT" >&2
  exit 1
fi

run_index() {
  echo "[watch_and_index] $(date '+%H:%M:%S') change detected — reindexing…"
  if "${INDEXER[@]}"; then
    echo "[watch_and_index] index refreshed."
  else
    # Indexer exits 2 with its own actionable message (Ollama/chromadb missing).
    echo "[watch_and_index] indexer failed — will retry on next change." >&2
  fi
}

echo "[watch_and_index] watching: ${PRESENT_DIRS[*]}"
run_index || true

if command -v fswatch >/dev/null 2>&1; then
  echo "[watch_and_index] using fswatch."
  # -o batches events into one line per change burst; -l debounces 2s.
  fswatch -o -l 2 \
    --exclude 'node_modules' --exclude 'dist' --exclude '\.git' \
    --exclude '\.semantic-index' --exclude '\.build-hash' \
    "${PRESENT_DIRS[@]}" | while read -r _count; do
    run_index || true
  done
else
  echo "[watch_and_index] fswatch not found — polling every ${POLL_SECONDS}s (brew install fswatch for instant updates)."
  STAMP="$(mktemp "${TMPDIR:-/tmp}/aggregaytor-watch.XXXXXX")"
  trap 'rm -f "$STAMP"' EXIT
  touch "$STAMP"
  while true; do
    sleep "$POLL_SECONDS"
    CHANGED="$(find "${PRESENT_DIRS[@]}" \
      \( -name node_modules -o -name dist -o -name .git -o -name .semantic-index \) -prune -o \
      -type f -newer "$STAMP" -print -quit 2>/dev/null || true)"
    if [ -n "$CHANGED" ]; then
      touch "$STAMP"
      run_index || true
    fi
  done
fi
