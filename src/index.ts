import { Worker } from "@notionhq/workers";
import * as Builder from "@notionhq/workers/builder";
import * as Schema from "@notionhq/workers/schema";
import {
  DEFAULT_JIRA_BASE_URL,
  TECHDEBT_SYNC_KEY,
  jiraJqlFromEnv,
  optionalEnv,
  requiredEnv,
} from "./config.js";
import {
  JiraClient,
  issueAssignee,
  issueEpicLink,
  issueProject,
  issueStatus,
  issueSummary,
  jiraIssueUrl,
} from "./jira.js";
import type { JiraIssue } from "./jira.js";

type SyncState = {
  startAt?: number;
};

const worker = new Worker();
export default worker;

const techdebtStories = worker.database("techdebtStories", {
  type: "managed",
  initialTitle: "Techdebt Stories",
  primaryKeyProperty: "Issue Key",
  schema: {
    properties: {
      Name: Schema.title(),
      "Issue Key": Schema.richText(),
      "Jira Link": Schema.url(),
      Status: Schema.richText(),
      "Jira Status": Schema.richText(),
      Priority: Schema.richText(),
      "Issue Type": Schema.richText(),
      "Epic Link": Schema.richText(),
      Project: Schema.richText(),
      Assignee: Schema.richText(),
      Updated: Schema.date(),
      Created: Schema.date(),
      "Due Date": Schema.date(),
      Labels: Schema.multiSelect([]),
      "Last Synced At": Schema.date(),
      "Sync Error": Schema.richText(),
    },
  },
});

worker.sync(TECHDEBT_SYNC_KEY, {
  database: techdebtStories,
  mode: "replace",
  schedule: "manual",
  execute: async (state: SyncState | undefined) => {
    const baseUrl = optionalEnv("JIRA_BASE_URL", DEFAULT_JIRA_BASE_URL);
    const jql = jiraJqlFromEnv();
    const jira = new JiraClient({
      baseUrl,
      pat: requiredEnv("JIRA_PAT"),
    });

    const startAt = state?.startAt ?? 0;
    const page = await jira.searchIssues({ jql, startAt, maxResults: 50 });
    const nextStartAt = page.startAt + page.issues.length;
    const hasMore = nextStartAt < page.total;

    return {
      changes: page.issues.map((issue) => ({
        type: "upsert" as const,
        key: issue.key,
        upstreamUpdatedAt: issue.fields.updated ?? undefined,
        properties: toWorkerProperties(issue, baseUrl),
      })),
      hasMore,
      nextState: hasMore ? { startAt: nextStartAt } : undefined,
    };
  },
});

export function toWorkerProperties(issue: JiraIssue, baseUrl: string) {
  const syncedAt = new Date().toISOString();
  const status = issueStatus(issue);

  return {
    Name: Builder.title(issueSummary(issue)),
    "Issue Key": Builder.richText(issue.key),
    "Jira Link": Builder.url(jiraIssueUrl(baseUrl, issue.key)),
    Status: Builder.richText(status),
    "Jira Status": Builder.richText(status),
    Priority: Builder.richText(issue.fields.priority?.name ?? ""),
    "Issue Type": Builder.richText(issue.fields.issuetype?.name ?? ""),
    "Epic Link": Builder.richText(issueEpicLink(issue)),
    Project: Builder.richText(issueProject(issue)),
    Assignee: Builder.richText(issueAssignee(issue)),
    Updated: dateTimeOrBlank(issue.fields.updated),
    Created: dateTimeOrBlank(issue.fields.created),
    "Due Date": dateOrBlank(issue.fields.duedate),
    Labels: Builder.multiSelect(...(issue.fields.labels ?? [])),
    "Last Synced At": Builder.dateTime(syncedAt),
    "Sync Error": Builder.richText(""),
  };
}

function dateTimeOrBlank(value: string | null | undefined) {
  return value ? Builder.dateTime(value) : [];
}

function dateOrBlank(value: string | null | undefined) {
  return value ? Builder.date(value) : [];
}
