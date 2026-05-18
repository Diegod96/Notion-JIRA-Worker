# Notion Jira Techdebt Worker

This project defines a Notion Worker-managed database named `Techdebt Stories` and a Mac-local bridge for Jira writeback.

Jira is VPN-bound, so the local bridge is the operational sync path. It runs on the Mac, verifies Jira is reachable, handles guarded Notion-to-Jira status transitions, and mirrors Jira status back to Notion's editable `Board Status` property.

The Worker-managed Jira snapshot properties are read-only to the regular Notion API. Use `Board Status` for Notion-requested Jira transitions and `Writeback Error` for bridge-visible failures.

## Setup

```bash
npm install --cache .npm-cache
cp .env.example .env
```

Fill in `.env`:

```bash
JIRA_BASE_URL=https://jira.dev.upenn.edu
JIRA_PAT=<jira-personal-access-token>
JIRA_JQL=assignee = diegodel AND "Epic Link" in (SYSM-1, TECHDEBT-4)
NOTION_API_TOKEN=<notion-token-with-database-access>
NOTION_TECHDEBT_DATA_SOURCE_ID=<data-source-id-after-first-deploy>
```

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

## Local Bridge

Run once:

```bash
npm run sync:local
```

The bridge:

- Calls Jira `/rest/api/2/myself` first and exits before Notion mutation if Jira is unreachable.
- Finds Notion rows where editable `Board Status` differs from `Jira Status`.
- Fetches each Jira issue and compares Jira `updated` to the row's synced `Updated`.
- Applies only valid Jira transitions.
- Writes stale or invalid transition messages to `Writeback Error`.
- Mirrors Jira's current status back to editable `Board Status` for every existing matching Notion row.

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
