#!/usr/bin/env bash
# Deploy script run ON the mini. Pulls latest from origin, runs bun install,
# typechecks, copies the launchd plist if it changed, and reloads the
# service.
#
# Idempotent. Refuses to advance if the working tree has uncommitted local
# changes — `git pull --ff-only` will fail in that case rather than try to
# merge.
#
# Run from anywhere; uses absolute paths.

set -euo pipefail

GARY_DIR="$HOME/Developer/gary"
BUN="$HOME/.bun/bin/bun"
PLIST_SRC="$GARY_DIR/scripts/com.707labs.gary.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.707labs.gary.plist"
SERVICE="com.707labs.gary"
LOG_DIR="$HOME/Library/Logs/gary"

cd "$GARY_DIR"

echo "[deploy] git pull --ff-only"
git fetch origin
before="$(git rev-parse HEAD)"
git pull --ff-only origin main
after="$(git rev-parse HEAD)"

if [[ "$before" == "$after" ]]; then
  echo "[deploy] already up to date — checking for stale install/state"
fi

echo "[deploy] bun install --frozen-lockfile"
"$BUN" install --frozen-lockfile

echo "[deploy] typecheck"
"$BUN" run typecheck

# Install plist if it changed.
if ! diff -q "$PLIST_SRC" "$PLIST_DST" > /dev/null 2>&1; then
  echo "[deploy] plist changed; installing"
  cp "$PLIST_SRC" "$PLIST_DST"
fi

mkdir -p "$LOG_DIR"

uid=$(id -u)
target="gui/$uid/$SERVICE"

if launchctl print "$target" > /dev/null 2>&1; then
  echo "[deploy] reloading $target"
  launchctl bootout "$target" || true
  # Wait for it to fully unload — bootstrap on an active label fails.
  for _ in {1..10}; do
    launchctl print "$target" > /dev/null 2>&1 || break
    sleep 0.5
  done
fi

echo "[deploy] bootstrap $target"
launchctl bootstrap "gui/$uid" "$PLIST_DST"

# Wait briefly for the service to spawn and emit its first log line.
echo "[deploy] waiting for boot…"
for _ in {1..20}; do
  if grep -q '"msg":"loop starting"' "$LOG_DIR/stdout.log" 2>/dev/null; then
    break
  fi
  sleep 0.5
done

echo "[deploy] head $LOG_DIR/stdout.log:"
tail -5 "$LOG_DIR/stdout.log"
echo
echo "[deploy] done. before=$before after=$after"
