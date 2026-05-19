import {
  DEFAULT_JIRA_BASE_URL,
  jiraJqlFromEnv,
  optionalEnv,
  requiredEnv,
} from "../src/config.js";
import {
  JiraComment,
  JiraClient,
  issueAssignee,
  issueEpicLink,
  issueProject,
  issueStatus,
  issueSummary,
  jiraIssueUrl,
} from "../src/jira.js";
import type { JiraIssue } from "../src/jira.js";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const NOTION_VERSION = "2026-03-11";
const PROJECT_DIR = process.cwd();
const VPN_FAILURE_MARKER = join(PROJECT_DIR, "logs", "vpn-reactivation-needed.json");
const VPN_FAILURE_PROMPT = join(PROJECT_DIR, "logs", "vpn-reactivation-needed.md");
const CODEX_GLOBALPROTECT_PROMPT =
  `Use Computer Use to open GlobalProtect, reconnect/reactivate the VPN, wait until GlobalProtect reports Connected, then rerun npm run sync:local in ${PROJECT_DIR}.`;

type JsonObject = Record<string, unknown>;

type NotionPage = {
  id: string;
  properties: Record<string, JsonObject>;
};

type PendingIssueChange = {
  page: NotionPage;
  issueKey: string;
  syncedUpdated: string;
};

type LogLevel = "info" | "warn" | "error";
type WritebackResult = {
  issueKey: string;
  syncError: string;
  commentSyncError: string;
  clearNewJiraComment: boolean;
  applied: boolean;
};

async function main() {
  const env = loadConfig();
  const logger = createLogger();
  const jira = new JiraClient({ baseUrl: env.jiraBaseUrl, pat: env.jiraPat });
  const notion = new NotionClient(env.notionApiToken);

  logger.info("starting techdebt sync bridge", {
    mirrorDataSourceId: env.notionMirrorDataSourceId,
    boardDataSourceId: env.notionBoardDataSourceId,
  });

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

  const boardPages = await notion.queryAllDataSourcePages(env.notionBoardDataSourceId);
  const changes = boardPages.map(toPendingIssueChange).filter(isPresent);
  logger.info("found editable Notion rows to reconcile", { count: changes.length });

  const writebackResults = new Map<string, WritebackResult>();

  for (const change of changes) {
    const result = await processIssueChange({ change, jira, notion, logger });
    writebackResults.set(result.issueKey, result);
  }

  const issues = await jira.searchAllIssues({ jql: env.jiraJql });
  await notion.syncEditableBoard({
    boardDataSourceId: env.notionBoardDataSourceId,
    existingPages: boardPages,
    issues,
    jira,
    jiraBaseUrl: env.jiraBaseUrl,
    writebackResults,
    logger,
  });

  logger.info("finished techdebt sync bridge");
}

function loadConfig() {
  return {
    jiraBaseUrl: optionalEnv("JIRA_BASE_URL", DEFAULT_JIRA_BASE_URL),
    jiraPat: requiredEnv("JIRA_PAT"),
    jiraJql: jiraJqlFromEnv(),
    notionApiToken: requiredEnv("NOTION_API_TOKEN"),
    notionMirrorDataSourceId: requiredEnv("NOTION_TECHDEBT_DATA_SOURCE_ID"),
    notionBoardDataSourceId: requiredEnv("NOTION_TECHDEBT_BOARD_DATA_SOURCE_ID"),
  };
}

async function processIssueChange(options: {
  change: PendingIssueChange;
  jira: JiraClient;
  notion: NotionClient;
  logger: ReturnType<typeof createLogger>;
}): Promise<WritebackResult> {
  const { change, jira, notion, logger } = options;
  const issue = await jira.getIssue(change.issueKey);
  const requestedComment = requestedJiraComment(change.page);
  let commentSyncError = "";
  let clearNewJiraComment = false;

  if (requestedComment) {
    try {
      await jira.addIssueComment(change.issueKey, requestedComment);
      clearNewJiraComment = true;
    } catch (error) {
      commentSyncError = errorMessage(error);
      await notion.updateCommentSyncError(change.page.id, commentSyncError);
      logger.warn("failed Jira comment writeback", {
        issueKey: change.issueKey,
        error: commentSyncError,
      });
    }
  }

  const currentUpdated = normalizeNotionDate(issue.fields.updated);
  const syncedUpdated = normalizeNotionDate(change.syncedUpdated);
  const requested = requestedJiraChanges(change.page, issue);

  if (!requested.hasChanges) {
    if (clearNewJiraComment && !commentSyncError) {
      await notion.updateCommentSyncError(change.page.id, "");
    }
    return {
      issueKey: change.issueKey,
      syncError: "",
      commentSyncError,
      clearNewJiraComment,
      applied: true,
    };
  }

  if (!sameSyncedMinute(currentUpdated, syncedUpdated)) {
    const message = `Stale Notion edit: Jira updated at ${currentUpdated || "unknown"} after row synced at ${syncedUpdated || "unknown"}.`;
    await notion.updateSyncError(change.page.id, message);
    logger.warn("skipped stale Notion issue change", {
      issueKey: change.issueKey,
      changedFields: requested.changedFields,
    });
    if (clearNewJiraComment && !commentSyncError) {
      await notion.updateCommentSyncError(change.page.id, "");
    }
    return {
      issueKey: change.issueKey,
      syncError: message,
      commentSyncError,
      clearNewJiraComment,
      applied: false,
    };
  }

  try {
    if (requested.status) {
      const transitions = await jira.getTransitions(change.issueKey);
      const matchingTransition = transitions.find(
        (transition) =>
          normalizeStatus(transition.to?.name ?? transition.name) ===
          normalizeStatus(requested.status ?? ""),
      );

      if (!matchingTransition) {
        const targets = transitions.map((transition) => transition.to?.name ?? transition.name).join(", ");
        throw new Error(`Invalid Jira transition target "${requested.status}". Available targets: ${targets || "none"}.`);
      }

      await jira.transitionIssue(change.issueKey, matchingTransition.id);
    }

    if (Object.keys(requested.fields).length > 0) {
      await jira.updateIssueFields(change.issueKey, requested.fields);
    }
  } catch (error) {
    const message = errorMessage(error);
    await notion.updateSyncError(change.page.id, message);
    logger.warn("skipped invalid Jira issue update", {
      issueKey: change.issueKey,
      changedFields: requested.changedFields,
      error: message,
    });
    return {
      issueKey: change.issueKey,
      syncError: message,
      commentSyncError,
      clearNewJiraComment,
      applied: false,
    };
  }

  await notion.updateSyncError(change.page.id, "");
  if (clearNewJiraComment && !commentSyncError) {
    await notion.updateCommentSyncError(change.page.id, "");
  }
  logger.info("updated Jira issue from Notion", {
    issueKey: change.issueKey,
    changedFields: requested.changedFields,
  });
  return {
    issueKey: change.issueKey,
    syncError: "",
    commentSyncError,
    clearNewJiraComment,
    applied: true,
  };
}

export function toPendingIssueChange(page: NotionPage): PendingIssueChange | null {
  const issueKey = richTextValue(page.properties["Issue Key"]);
  const syncedUpdated = dateValue(page.properties.Updated);

  if (!issueKey) {
    return null;
  }

  return {
    page,
    issueKey,
    syncedUpdated,
  };
}

export const toPendingStatusChange = toPendingIssueChange;

export function requestedJiraChanges(page: NotionPage, issue: JiraIssue) {
  const fields: Record<string, unknown> = {};
  const changedFields: string[] = [];

  const summary = richTextValue(page.properties.Name);
  if (summary && summary !== issueSummary(issue)) {
    fields.summary = summary;
    changedFields.push("Name");
  }

  const priority = richTextValue(page.properties.Priority);
  if (priority !== (issue.fields.priority?.name ?? "")) {
    fields.priority = priority ? { name: priority } : null;
    changedFields.push("Priority");
  }

  const assignee = richTextValue(page.properties.Assignee);
  if (assignee !== issueAssignee(issue)) {
    fields.assignee = assignee ? { name: assignee } : null;
    changedFields.push("Assignee");
  }

  const issueType = richTextValue(page.properties["Issue Type"]);
  if (issueType !== (issue.fields.issuetype?.name ?? "")) {
    fields.issuetype = issueType ? { name: issueType } : null;
    changedFields.push("Issue Type");
  }

  const epicLink = richTextValue(page.properties["Epic Link"]);
  if (epicLink !== issueEpicLink(issue)) {
    fields.customfield_10008 = epicLink || null;
    changedFields.push("Epic Link");
  }

  const status = richTextValue(page.properties["Board Status"]);
  const requestedStatus = status && normalizeStatus(status) !== normalizeStatus(issueStatus(issue))
    ? status
    : "";
  if (requestedStatus) {
    changedFields.push("Board Status");
  }

  return {
    fields,
    status: requestedStatus,
    changedFields,
    hasChanges: changedFields.length > 0,
  };
}

export function requestedJiraComment(page: NotionPage): string {
  return richTextValue(page.properties["New Jira Comment"]);
}

export function normalizeStatus(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

export function sameSyncedMinute(left: string, right: string): boolean {
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);

  if (Number.isNaN(leftTime) || Number.isNaN(rightTime)) {
    return left === right;
  }

  return Math.floor(leftTime / 60000) === Math.floor(rightTime / 60000);
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

  async updateCommentSyncError(pageId: string, message: string): Promise<void> {
    await this.request(`/v1/pages/${encodeURIComponent(pageId)}`, {
      method: "PATCH",
      body: JSON.stringify({
        properties: {
          "Comment Sync Error": {
            rich_text: message
              ? [{ type: "text", text: { content: message.slice(0, 1900) } }]
              : [],
          },
        },
      }),
    });
  }

  async syncEditableBoard(options: {
    boardDataSourceId: string;
    existingPages: NotionPage[];
    issues: JiraIssue[];
    jira: JiraClient;
    jiraBaseUrl: string;
    writebackResults: Map<string, WritebackResult>;
    logger: ReturnType<typeof createLogger>;
  }): Promise<void> {
    const { boardDataSourceId, existingPages, issues, jiraBaseUrl, writebackResults, logger } = options;
    const pageByIssueKey = new Map(
      existingPages
        .map((page) => [richTextValue(page.properties["Issue Key"]), page] as const)
        .filter(([issueKey]) => issueKey),
    );
    let updated = 0;
    let created = 0;

    for (const issue of issues) {
      const page = pageByIssueKey.get(issue.key);
      const comments = await options.jira.getIssueComments(issue.key);
      const properties = editableBoardPropertiesForIssue({
        issue,
        comments,
        jiraBaseUrl,
        existingPage: page,
        writebackResult: writebackResults.get(issue.key),
      });

      if (page) {
        await this.updatePageProperties(page.id, properties);
        updated += 1;
      } else {
        await this.createDataSourcePage(boardDataSourceId, properties);
        created += 1;
      }
    }

    logger.info("synced editable board to Notion", {
      jiraIssues: issues.length,
      updated,
      created,
    });
  }

  private async createDataSourcePage(dataSourceId: string, properties: JsonObject): Promise<void> {
    await this.request("/v1/pages", {
      method: "POST",
      body: JSON.stringify({
        parent: { data_source_id: dataSourceId },
        properties,
      }),
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
  comments?: JiraComment[];
  jiraBaseUrl: string;
  syncError: string;
}): JsonObject {
  const { issue, comments = [], jiraBaseUrl, syncError } = options;
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
    Project: richTextProperty(issueProject(issue)),
    Updated: dateProperty(issue.fields.updated),
    Created: dateProperty(issue.fields.created),
    "Due Date": dateProperty(issue.fields.duedate),
    Labels: multiSelectProperty(issue.fields.labels ?? []),
    "Jira Comments": richTextProperty(formatJiraComments(comments)),
    "Last Comment Synced At": dateProperty(new Date().toISOString()),
    "Last Synced At": dateProperty(new Date().toISOString()),
    "Sync Error": richTextProperty(syncError),
  };
}

export function editableBoardPropertiesForIssue(options: {
  issue: JiraIssue;
  comments?: JiraComment[];
  jiraBaseUrl: string;
  existingPage?: NotionPage;
  writebackResult?: WritebackResult;
}): JsonObject {
  const { issue, comments = [], jiraBaseUrl, existingPage, writebackResult } = options;
  const pendingEditPage = existingPage && writebackResult && !writebackResult.applied
    ? existingPage
    : undefined;
  const preservePendingEdits = Boolean(pendingEditPage);
  const jiraStatus = issueStatus(issue);
  const existingBoardStatus = existingPage
    ? richTextValue(existingPage.properties["Board Status"])
    : "";
  const existingJiraStatus = existingPage
    ? richTextValue(existingPage.properties["Jira Status"])
    : "";
  const hasPendingHumanStatus =
    existingBoardStatus &&
    existingJiraStatus &&
    normalizeStatus(existingBoardStatus) !== normalizeStatus(existingJiraStatus);
  const preserveBoardStatus = hasPendingHumanStatus && preservePendingEdits;
  const boardStatus = preserveBoardStatus ? existingBoardStatus : jiraStatus;

  return {
    Name: titleProperty(pendingEditPage ? richTextValue(pendingEditPage.properties.Name) || issueSummary(issue) : issueSummary(issue)),
    "Issue Key": richTextProperty(issue.key),
    "Board Status": selectProperty(boardStatus),
    "Jira Status": richTextProperty(jiraStatus),
    Priority: richTextProperty(pendingEditPage ? richTextValue(pendingEditPage.properties.Priority) : issue.fields.priority?.name ?? ""),
    Assignee: richTextProperty(pendingEditPage ? richTextValue(pendingEditPage.properties.Assignee) : issueAssignee(issue)),
    Project: richTextProperty(issueProject(issue)),
    "Issue Type": richTextProperty(pendingEditPage ? richTextValue(pendingEditPage.properties["Issue Type"]) : issue.fields.issuetype?.name ?? ""),
    "Epic Link": richTextProperty(pendingEditPage ? richTextValue(pendingEditPage.properties["Epic Link"]) : issueEpicLink(issue)),
    Updated: dateProperty(issue.fields.updated),
    "Jira Link": urlProperty(jiraIssueUrl(jiraBaseUrl, issue.key)),
    "Jira Comments": richTextProperty(formatJiraComments(comments)),
    "New Jira Comment": richTextProperty(writebackResult?.clearNewJiraComment ? "" : richTextValue(existingPage?.properties["New Jira Comment"])),
    "Comment Sync Error": richTextProperty(writebackResult?.commentSyncError ?? richTextValue(existingPage?.properties["Comment Sync Error"])),
    "Last Comment Synced At": dateProperty(new Date().toISOString()),
    "Last Synced At": dateProperty(new Date().toISOString()),
    "Writeback Error": richTextProperty(writebackResult?.syncError ?? ""),
  };
}

export function formatJiraComments(comments: JiraComment[]): string {
  if (comments.length === 0) {
    return "";
  }

  return comments
    .map((comment) => {
      const created = normalizeNotionDate(comment.created);
      const when = created ? created.slice(0, 19).replace("T", " ") : "unknown time";
      const author = comment.author?.displayName?.trim() || "Unknown";
      const body = (comment.body ?? "").trim();
      return `[${when} - ${author}]\n${body}`;
    })
    .join("\n\n");
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
