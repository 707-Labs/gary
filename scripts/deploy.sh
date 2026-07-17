#!/usr/bin/env bash
# Deploy entrypoint that works from anywhere: runs deploy-mini.sh directly
# when already on the mini, otherwise over SSH. `bun run deploy` calls this.
set -euo pipefail

if [[ "$(hostname)" == mini.local || "$(scutil --get ComputerName 2>/dev/null)" == *"Mac mini"* ]]; then
  exec bash "$(cd "$(dirname "$0")" && pwd)/deploy-mini.sh"
fi

exec ssh mini 'bash -lc ~/Developer/gary/scripts/deploy-mini.sh'
