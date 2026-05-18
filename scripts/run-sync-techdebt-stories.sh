#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="/Users/diegodelgado/Developer/Personal/Notion-JIRA-Techdebt-Worker"
LOG_DIR="$PROJECT_DIR/logs"

mkdir -p "$LOG_DIR"
cd "$PROJECT_DIR"

if [ -f "$PROJECT_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$PROJECT_DIR/.env"
  set +a
fi

npm run sync:local -- --quiet >> "$LOG_DIR/techdebt-sync.log" 2>&1
