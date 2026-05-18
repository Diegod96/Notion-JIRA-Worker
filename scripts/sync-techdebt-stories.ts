import {
  DEFAULT_JIRA_BASE_URL,
  DEFAULT_JIRA_JQL,
  optionalEnv,
  requiredEnv,
} from "../src/config.js";
import {
  JiraClient,
  issueAssignee,
  issueEpicLink,
  issueStatus,
  issueSummary,
  jiraIssueUrl,
} from "../src/jira.js";
import type { JiraIssue } from "../src/jira.js";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const NOTION_VERSION = "2026-03-11";
const PROJECT_DIR = "/Users/diegodelgado/Developer/Personal/Notion-JIRA-Techdebt-Worker";
const VPN_FAILURE_MARKER = join(PROJECT_DIR, "logs", "vpn-reactivation-needed.json");
const VPN_FAILURE_PROMPT = join(PROJECT_DIR, "logs", "vpn-reactivation-needed.md");
const CODEX_GLOBALPROTECT_PROMPT =
  "Use Computer Use to open GlobalProtect, reconnect/reactivate the VPN, wait until GlobalProtect reports Connected, then rerun npm run sync:local in /Users/diegodelgado/Developer/Personal/Notion-JIRA-Techdebt-Worker.";

type JsonObject = Record<string, unknown>;

type NotionPage = {
  id: string;
  properties: Record<string, JsonObject>;
};

type PendingStatusChange = {
  page: NotionPage;
  issueKey: string;
  requestedStatus: string;
  syncedJiraStatus: string;
  syncedUpdated: string;
};

type LogLevel = "info" | "warn" | "error";
type WritebackResult = {
  issueKey: string;
  syncError: string;
};

async function main() {
  const env = loadConfig();
  const logger = createLogger();
  const jira = new JiraClient({ baseUrl: env.jiraBaseUrl, pat: env.jiraPat });
  const notion = new NotionClient(env.notionApiToken);

  logger.info("starting techdebt sync bridge", { dataSourceId: env.notionDataSourceId });

  try {
    await jira.myself();
  } catch (error) {
    await writeVpnFailureSignal({ error, jiraBaseUrl: env.jiraBaseUrl });
    logger.error("jira unreachable; stopping before Notion mutation", {
      action: "reactivate_globalprotect",
      codexPrompt: CODEX_GLOBALPROTECT_PROMPT,
      markerPath: VPN_FAILURE_MARKER,
      error: errorMessage(error),
    });
    process.exitCode = 2;
    return;
  }

  await clearVpnFailureSignal();

  const pages = await notion.queryAllDataSourcePages(env.notionDataSourceId);
  const changes = pages.map(toPendingStatusChange).filter(isPresent);
  logger.info("found pending Notion status changes", { count: changes.length });

  const writebackResults = new Map<string, string>();

  for (const change of changes) {
    const result = await processStatusChange({ change, jira, notion, logger });
    writebackResults.set(result.issueKey, result.syncError);
  }

  const issues = await jira.searchAllIssues({ jql: env.jiraJql });
  await notion.syncEditableJiraStatusMirror({
    existingPages: pages,
    issues,
    writebackResults,
    logger,
  });

  logger.info("finished techdebt sync bridge");
}

function loadConfig() {
  return {
    jiraBaseUrl: optionalEnv("JIRA_BASE_URL", DEFAULT_JIRA_BASE_URL),
    jiraPat: requiredEnv("JIRA_PAT"),
    jiraJql: optionalEnv("JIRA_JQL", DEFAULT_JIRA_JQL),
    notionApiToken: requiredEnv("NOTION_API_TOKEN"),
    notionDataSourceId: requiredEnv("NOTION_TECHDEBT_DATA_SOURCE_ID"),
  };
}

async function processStatusChange(options: {
  change: PendingStatusChange;
  jira: JiraClient;
  notion: NotionClient;
  logger: ReturnType<typeof createLogger>;
}): Promise<WritebackResult> {
  const { change, jira, notion, logger } = options;
  const issue = await jira.getIssue(change.issueKey);
  const currentUpdated = issue.fields.updated ?? "";

  if (currentUpdated !== change.syncedUpdated) {
    const message = `Stale Notion edit: Jira updated at ${currentUpdated || "unknown"} after row synced at ${change.syncedUpdated || "unknown"}.`;
    await notion.updateSyncError(change.page.id, message);
    logger.warn("skipped stale Notion status change", {
      issueKey: change.issueKey,
      requestedStatus: change.requestedStatus,
    });
    return { issueKey: change.issueKey, syncError: message };
  }

  if (normalizeStatus(issueStatus(issue)) === normalizeStatus(change.requestedStatus)) {
    await notion.updateSyncError(change.page.id, "");
    logger.info("status already matches Jira", { issueKey: change.issueKey });
    return { issueKey: change.issueKey, syncError: "" };
  }

  const transitions = await jira.getTransitions(change.issueKey);
  const matchingTransition = transitions.find(
    (transition) =>
      normalizeStatus(transition.to?.name ?? transition.name) ===
      normalizeStatus(change.requestedStatus),
  );

  if (!matchingTransition) {
    const targets = transitions.map((transition) => transition.to?.name ?? transition.name).join(", ");
    const message = `Invalid Jira transition target "${change.requestedStatus}". Available targets: ${targets || "none"}.`;
    await notion.updateSyncError(change.page.id, message);
    logger.warn("skipped invalid Jira transition", {
      issueKey: change.issueKey,
      requestedStatus: change.requestedStatus,
    });
    return { issueKey: change.issueKey, syncError: message };
  }

  await jira.transitionIssue(change.issueKey, matchingTransition.id);
  await notion.updateSyncError(change.page.id, "");
  logger.info("transitioned Jira issue", {
    issueKey: change.issueKey,
    requestedStatus: change.requestedStatus,
    transitionId: matchingTransition.id,
  });
  return { issueKey: change.issueKey, syncError: "" };
}

export function toPendingStatusChange(page: NotionPage): PendingStatusChange | null {
  const issueKey = richTextValue(page.properties["Issue Key"]);
  const requestedStatus =
    richTextValue(page.properties["Board Status"]) || richTextValue(page.properties.Status);
  const syncedJiraStatus = richTextValue(page.properties["Jira Status"]);
  const syncedUpdated = dateValue(page.properties.Updated);

  if (!issueKey || !requestedStatus || normalizeStatus(requestedStatus) === normalizeStatus(syncedJiraStatus)) {
    return null;
  }

  return {
    page,
    issueKey,
    requestedStatus,
    syncedJiraStatus,
    syncedUpdated,
  };
}

export function normalizeStatus(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

export async function writeVpnFailureSignal(options: {
  error: unknown;
  jiraBaseUrl: string;
}): Promise<void> {
  const payload = {
    ts: new Date().toISOString(),
    reason: "jira_unreachable",
    action: "reactivate_globalprotect",
    jiraBaseUrl: options.jiraBaseUrl,
    error: errorMessage(options.error),
    codexPrompt: CODEX_GLOBALPROTECT_PROMPT,
  };

  await mkdir(dirname(VPN_FAILURE_MARKER), { recursive: true });
  await writeFile(VPN_FAILURE_MARKER, `${JSON.stringify(payload, null, 2)}\n`);
  await writeFile(
    VPN_FAILURE_PROMPT,
    [
      "# VPN Reactivation Needed",
      "",
      CODEX_GLOBALPROTECT_PROMPT,
      "",
      `Last failure: ${payload.ts}`,
      `Jira base URL: ${payload.jiraBaseUrl}`,
      `Error: ${payload.error}`,
      "",
    ].join("\n"),
  );
}

export async function clearVpnFailureSignal(): Promise<void> {
  await rm(VPN_FAILURE_MARKER, { force: true });
  await rm(VPN_FAILURE_PROMPT, { force: true });
}

class NotionClient {
  constructor(private readonly token: string, private readonly fetchImpl: typeof fetch = fetch) {}

  async queryAllDataSourcePages(dataSourceId: string): Promise<NotionPage[]> {
    const pages: NotionPage[] = [];
    let startCursor: string | undefined;

    do {
      const response = await this.request(`/v1/data_sources/${encodeURIComponent(dataSourceId)}/query`, {
        method: "POST",
        body: JSON.stringify({
          page_size: 100,
          result_type: "page",
          ...(startCursor ? { start_cursor: startCursor } : {}),
        }),
      });
      const results = Array.isArray(response.results) ? response.results : [];
      pages.push(...(results as NotionPage[]));
      startCursor = response.has_more ? String(response.next_cursor) : undefined;
    } while (startCursor);

    return pages;
  }

  async updateSyncError(pageId: string, message: string): Promise<void> {
    await this.request(`/v1/pages/${encodeURIComponent(pageId)}`, {
      method: "PATCH",
      body: JSON.stringify({
        properties: {
          "Writeback Error": {
            rich_text: message
              ? [{ type: "text", text: { content: message.slice(0, 1900) } }]
              : [],
          },
        },
      }),
    });
  }

  async syncEditableJiraStatusMirror(options: {
    existingPages: NotionPage[];
    issues: JiraIssue[];
    writebackResults: Map<string, string>;
    logger: ReturnType<typeof createLogger>;
  }): Promise<void> {
    const { existingPages, issues, writebackResults, logger } = options;
    const pageByIssueKey = new Map(
      existingPages
        .map((page) => [richTextValue(page.properties["Issue Key"]), page] as const)
        .filter(([issueKey]) => issueKey),
    );
    let updated = 0;
    let missingFromNotion = 0;

    for (const issue of issues) {
      const page = pageByIssueKey.get(issue.key);

      if (page) {
        await this.updatePageProperties(page.id, editableMirrorPropertiesForIssue({
          issue,
          syncError: writebackResults.get(issue.key) ?? "",
        }));
        updated += 1;
      } else {
        missingFromNotion += 1;
      }
    }

    logger.info("synced editable Jira status mirror to Notion", {
      jiraIssues: issues.length,
      updated,
      missingFromNotion,
    });
  }

  private async updatePageProperties(pageId: string, properties: JsonObject): Promise<void> {
    await this.request(`/v1/pages/${encodeURIComponent(pageId)}`, {
      method: "PATCH",
      body: JSON.stringify({ properties }),
    });
  }

  private async request(path: string, init: RequestInit): Promise<JsonObject> {
    const response = await this.fetchImpl(`https://api.notion.com${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        "Notion-Version": NOTION_VERSION,
        ...init.headers,
      },
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Notion ${response.status} ${response.statusText}: ${text.slice(0, 500)}`);
    }

    return (await response.json()) as JsonObject;
  }
}

function richTextValue(property: JsonObject | undefined): string {
  if (!property) {
    return "";
  }

  const type = property?.type;
  if (type === "title" && Array.isArray(property.title)) {
    return property.title.map(textItemValue).join("").trim();
  }
  if (type === "rich_text" && Array.isArray(property.rich_text)) {
    return property.rich_text.map(textItemValue).join("").trim();
  }
  if (type === "select" && isObject(property.select)) {
    return stringValue(property.select.name);
  }
  if (type === "status" && isObject(property.status)) {
    return stringValue(property.status.name);
  }
  return "";
}

function dateValue(property: JsonObject | undefined): string {
  if (property?.type !== "date" || !isObject(property.date)) {
    return "";
  }
  return stringValue(property.date.start);
}

function textItemValue(item: unknown): string {
  if (!isObject(item)) {
    return "";
  }
  if (typeof item.plain_text === "string") {
    return item.plain_text;
  }
  if (isObject(item.text) && typeof item.text.content === "string") {
    return item.text.content;
  }
  return "";
}

export function notionPropertiesForIssue(options: {
  issue: JiraIssue;
  jiraBaseUrl: string;
  syncError: string;
}): JsonObject {
  const { issue, jiraBaseUrl, syncError } = options;
  const status = issueStatus(issue);

  return {
    Name: titleProperty(issueSummary(issue)),
    "Issue Key": richTextProperty(issue.key),
    "Jira Link": urlProperty(jiraIssueUrl(jiraBaseUrl, issue.key)),
    Status: richTextProperty(status),
    "Jira Status": richTextProperty(status),
    Priority: richTextProperty(issue.fields.priority?.name ?? ""),
    "Issue Type": richTextProperty(issue.fields.issuetype?.name ?? ""),
    "Epic Link": richTextProperty(issueEpicLink(issue)),
    Assignee: richTextProperty(issueAssignee(issue)),
    Updated: dateProperty(issue.fields.updated),
    Created: dateProperty(issue.fields.created),
    "Due Date": dateProperty(issue.fields.duedate),
    Labels: multiSelectProperty(issue.fields.labels ?? []),
    "Last Synced At": dateProperty(new Date().toISOString()),
    "Sync Error": richTextProperty(syncError),
  };
}

export function editableMirrorPropertiesForIssue(options: {
  issue: JiraIssue;
  syncError: string;
}): JsonObject {
  return {
    "Board Status": selectProperty(issueStatus(options.issue)),
    "Writeback Error": richTextProperty(options.syncError),
  };
}

function titleProperty(content: string): JsonObject {
  return {
    title: content ? [{ type: "text", text: { content } }] : [],
  };
}

function richTextProperty(content: string): JsonObject {
  return {
    rich_text: content ? [{ type: "text", text: { content } }] : [],
  };
}

function urlProperty(url: string): JsonObject {
  return { url };
}

function selectProperty(name: string): JsonObject {
  return {
    select: name ? { name } : null,
  };
}

function dateProperty(value: string | null | undefined): JsonObject {
  const normalized = normalizeNotionDate(value);
  return { date: normalized ? { start: normalized } : null };
}

function multiSelectProperty(values: string[]): JsonObject {
  return {
    multi_select: values.map((name) => ({ name })),
  };
}

export function normalizeNotionDate(value: string | null | undefined): string {
  if (!value) {
    return "";
  }

  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString();
  }

  return value;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null;
}

function isPresent<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

function createLogger() {
  const log = (level: LogLevel, message: string, data: JsonObject = {}) => {
    const payload = {
      ts: new Date().toISOString(),
      level,
      message,
      ...data,
    };
    console.log(JSON.stringify(payload));
  };

  return {
    info: (message: string, data?: JsonObject) => log("info", message, data),
    warn: (message: string, data?: JsonObject) => log("warn", message, data),
    error: (message: string, data?: JsonObject) => log("error", message, data),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (require.main === module) {
  main().catch((error) => {
    createLogger().error("sync bridge failed", { error: errorMessage(error) });
    process.exitCode = 1;
  });
}
