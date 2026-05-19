#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="/Users/diegodelgado/Developer/Work/Notion Workers/Notion-JIRA-Techdebt-Worker"
LOG_DIR="$PROJECT_DIR/logs"
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

mkdir -p "$LOG_DIR"
cd "$PROJECT_DIR"

if [ -f "$PROJECT_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$PROJECT_DIR/.env"
  set +a
fi

npm run sync:local -- --quiet >> "$LOG_DIR/techdebt-sync.log" 2>&1
