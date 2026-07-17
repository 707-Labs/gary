#!/usr/bin/env bash
# Tail gary's stdout — locally when on the mini, over SSH otherwise.
set -euo pipefail

LOG="$HOME/Library/Logs/gary/stdout.log"

if [[ "$(hostname)" == mini.local || "$(scutil --get ComputerName 2>/dev/null)" == *"Mac mini"* ]]; then
  exec tail -f "$LOG"
fi

exec ssh mini "tail -f ~/Library/Logs/gary/stdout.log"
