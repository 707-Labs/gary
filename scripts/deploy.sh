#!/usr/bin/env bash
# Deploy Gary on this Mac. The com.707labs.gary LaunchAgent runs locally; there is
# no remote host. The script renders scripts/com.707labs.gary.plist with the
# current HEAD as GARY_CONVERSATION_RUNTIME_RELEASE, installs it, restarts the
# agent and fails unless the boot and conversation-readiness log lines appear.
#
# src/readonly-startup.ts refuses to start unless `git rev-parse HEAD` equals that
# pin and no tracked file is modified, so a dirty tree is refused up front.
#
# usage: scripts/deploy.sh [--skip-tests]
set -euo pipefail

GARY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUN="$HOME/.bun/bin/bun"
TEMPLATE="$GARY_DIR/scripts/com.707labs.gary.plist"
PLIST="$HOME/Library/LaunchAgents/com.707labs.gary.plist"
SERVICE="com.707labs.gary"
TARGET="gui/$(id -u)/$SERVICE"
LOG_DIR="$HOME/Library/Logs/gary"
STDOUT="$LOG_DIR/stdout.log"
STDERR="$LOG_DIR/stderr.log"
SKIP_TESTS=0
for arg in "$@"; do
  case "$arg" in
    --skip-tests) SKIP_TESTS=1 ;;
    *) echo "usage: $0 [--skip-tests]" >&2; exit 2 ;;
  esac
done

cd "$GARY_DIR"
if [[ -n "$(git status --porcelain=v1 --untracked-files=no)" ]]; then
  echo "[deploy] refusing: tracked files are modified; the release pin must match HEAD exactly" >&2
  git status --short --untracked-files=no >&2
  exit 1
fi
release="$(git rev-parse HEAD)"
echo "[deploy] release $release ($(git log -1 --format=%s))"
if ! git merge-base --is-ancestor "$release" origin/main 2> /dev/null; then
  echo "[deploy] note: HEAD is not on origin/main yet; push once the deploy is verified"
fi

echo "[deploy] bun install --frozen-lockfile"
"$BUN" install --frozen-lockfile
echo "[deploy] typecheck"
"$BUN" run typecheck
if [[ "$SKIP_TESTS" -eq 0 ]]; then
  echo "[deploy] bun test"
  "$BUN" test
fi

mkdir -p "$LOG_DIR" "$(dirname "$PLIST")"
sed "s/__GARY_RELEASE__/$release/" "$TEMPLATE" > "$PLIST.tmp"
plutil -lint "$PLIST.tmp" > /dev/null
grep -q "<string>$release</string>" "$PLIST.tmp"
mv "$PLIST.tmp" "$PLIST"
echo "[deploy] installed $PLIST"

# Only log lines written after this point count as evidence of the new release.
out_marker=0; err_marker=0
[[ -f "$STDOUT" ]] && out_marker="$(wc -l < "$STDOUT" | tr -d ' ')"
[[ -f "$STDERR" ]] && err_marker="$(wc -l < "$STDERR" | tr -d ' ')"
new_out() { tail -n "+$((out_marker + 1))" "$STDOUT" 2> /dev/null || true; }
new_err() { tail -n "+$((err_marker + 1))" "$STDERR" 2> /dev/null || true; }

if launchctl print "$TARGET" > /dev/null 2>&1; then
  echo "[deploy] bootout $TARGET (SIGTERM; the conversation runtimes drain before exit)"
  launchctl bootout "$TARGET" || true
  for _ in $(seq 1 60); do
    launchctl print "$TARGET" > /dev/null 2>&1 || break
    sleep 0.5
  done
  new_out | grep -E '"msg":"(signal received|conversation runtime stopped|alert runtime stopped)"' | sed 's/^/[deploy] /' || true
fi

echo "[deploy] bootstrap $TARGET"
launchctl bootstrap "gui/$(id -u)" "$PLIST"

echo "[deploy] waiting for boot"
booted=0
for _ in $(seq 1 120); do
  if new_out | grep -q '"msg":"gary booted"'; then booted=1; break; fi
  if { new_out; new_err; } | grep -q 'readonly_release_mismatch\|"msg":"fatal"'; then
    echo "[deploy] FAILED: startup rejected the release or crashed" >&2
    { new_out; new_err; } | tail -n 20 >&2
    exit 1
  fi
  sleep 1
done
if [[ "$booted" -eq 0 ]]; then
  echo "[deploy] FAILED: no 'gary booted' line within 120s" >&2
  { new_out; new_err; } | tail -n 20 >&2
  exit 1
fi

new_out | grep -E '"msg":"(alert runtime ready|conversation runtime ready|shared conversation unavailable|gary booted)"' | sed 's/^/[deploy] /'
if new_out | grep -q '"msg":"shared conversation unavailable"'; then
  echo "[deploy] FAILED: the shared-channel conversation did not come up (config fingerprint or budget); see the line above" >&2
  exit 1
fi
pid="$(launchctl print "$TARGET" 2> /dev/null | awk '/^[[:space:]]+pid = /{print $3; exit}')"
echo "[deploy] done: $release running as $TARGET (pid ${pid:-unknown})"
