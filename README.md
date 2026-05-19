# Notion Jira Techdebt Worker

This project defines a Notion Worker-managed database named `Techdebt Stories`, a normal editable companion database named `Techdebt Board`, and a Mac-local bridge for Jira writeback.

Jira is VPN-bound, so the local bridge is the operational sync path. It runs on the Mac, verifies Jira is reachable, handles guarded Notion-to-Jira status transitions from `Techdebt Board`, and refreshes editable board rows from Jira.

The Worker-managed Jira snapshot properties in `Techdebt Stories` are read-only in the Notion UI. Edit `Techdebt Board` instead. Edits to Jira-backed fields on `Techdebt Board` are written back to Jira by the local bridge; `Writeback Error` shows validation, stale-row, or Jira API failures.

## Setup

```bash
npm install --cache .npm-cache
cp .env.example .env
```

Fill in `.env`:

```bash
JIRA_BASE_URL=https://jira.dev.upenn.edu
JIRA_PAT=<jira-personal-access-token>
JIRA_ASSIGNEE=diegodel
RELEASE_LABEL_START_MONTH=2026-06
RELEASE_LABEL_WINDOW_SIZE=2
JIRA_JQL=
NOTION_API_TOKEN=<notion-token-with-database-access>
NOTION_TECHDEBT_DATA_SOURCE_ID=<worker-managed-techdebt-stories-data-source-id>
NOTION_TECHDEBT_BOARD_DATA_SOURCE_ID=<editable-techdebt-board-data-source-id>
```

When `JIRA_JQL` is blank, the sync generates a rolling Compass release query from the release settings. With the defaults above, it syncs:

```jql
assignee = diegodel AND "Epic Link" is not EMPTY AND project is not EMPTY AND labels in (June_2026_Compass_Release, July_2026_Compass_Release)
```

After each monthly deployment cycle, advance `RELEASE_LABEL_START_MONTH` to the next release month. For example, after the June release, set `RELEASE_LABEL_START_MONTH=2026-07` to cover July and August. Set `JIRA_JQL` only when you need a full manual override.

## Worker

```bash
ntn doctor
ntn login
ntn workers deploy --name "Jira Techdebt Stories"
ntn workers sync state reset techdebtStoriesSync
ntn workers sync trigger techdebtStoriesSync --local
```

If `workers.json` already exists, update the existing Worker without `--name`:

```bash
ntn workers deploy --local-build --no-git
```

After the first deploy, capture the managed Notion data source ID and set `NOTION_TECHDEBT_DATA_SOURCE_ID` in `.env`.

## Editable Board

`Techdebt Board` is the human-editable Kanban. It is a normal Notion database, not Worker-managed.

Required fields:

- `Name`
- `Issue Key`
- `Board Status`
- `Jira Status`
- `Priority`
- `Assignee`
- `Project`
- `Issue Type`
- `Epic Link`
- `Updated`
- `Jira Link`
- `Last Synced At`
- `Writeback Error`
- `Jira Comments`
- `New Jira Comment`
- `Comment Sync Error`
- `Last Comment Synced At`
- `Notes`

The canonical board view should group by `Board Status`. Keep one board for all synced Jira projects, and add filtered Notion views by `Project` when you want project-specific Kanban or table views. The current editable board data source is:

```bash
NOTION_TECHDEBT_BOARD_DATA_SOURCE_ID=445459d1-be6d-495f-b594-0c1f24610e59
```

Database URL: https://www.notion.so/31e614b69a594ee39c69afa6de43cb63

## Local Bridge

Run once:

```bash
npm run sync:local
```

The bridge:

- Calls Jira `/rest/api/2/myself` first and exits before Notion mutation if Jira is unreachable.
- Finds editable board rows by `Issue Key`.
- Fetches each Jira issue and compares Jira `updated` to the row's synced `Updated` before applying Notion edits.
- Writes edited `Name`, `Priority`, `Assignee`, `Issue Type`, and `Epic Link` values back through Jira issue update.
- Applies `Board Status` through valid Jira transitions.
- Posts `New Jira Comment` into Jira issue comments and clears it after successful post.
- Writes stale, invalid transition, or Jira update failures to `Writeback Error`.
- Writes Jira comment post failures to `Comment Sync Error`.
- Refreshes `Jira Comments` and `Last Comment Synced At` from Jira on each sync.
- Upserts one editable board row per Jira issue using `Issue Key`.
- Refreshes editable board fields from Jira after successful writeback, and preserves pending human edits after stale or invalid writeback attempts.

## launchd

Install the 5-minute local scheduler:

```bash
mkdir -p logs
launchctl bootstrap "gui/$(id -u)" launchd/com.diegodelgado.notion-jira-techdebt-worker.plist
launchctl enable "gui/$(id -u)/com.diegodelgado.notion-jira-techdebt-worker"
```

Unload it:

```bash
launchctl bootout "gui/$(id -u)" launchd/com.diegodelgado.notion-jira-techdebt-worker.plist
```

Logs are written under `logs/`.

## VPN Recovery Signal

When Jira is unreachable, the bridge stops before mutating Notion and writes:

```bash
logs/vpn-reactivation-needed.json
logs/vpn-reactivation-needed.md
```

Check for that signal with:

```bash
npm run vpn:check
```

If present, Codex should use Computer Use to open GlobalProtect, reconnect/reactivate the VPN, wait until GlobalProtect reports Connected, then rerun `npm run sync:local`.

## Verification

```bash
npm run check
npm test
```
# Notion-JIRA-Worker
