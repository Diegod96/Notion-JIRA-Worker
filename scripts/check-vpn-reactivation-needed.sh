#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="/Users/diegodelgado/Developer/Work/Notion Workers/Notion-JIRA-Techdebt-Worker"
MARKER="$PROJECT_DIR/logs/vpn-reactivation-needed.json"
PROMPT="$PROJECT_DIR/logs/vpn-reactivation-needed.md"

if [ ! -f "$MARKER" ]; then
  echo "VPN reactivation marker not present."
  exit 0
fi

echo "VPN reactivation marker present: $MARKER"
if [ -f "$PROMPT" ]; then
  cat "$PROMPT"
else
  cat "$MARKER"
fi
exit 2
