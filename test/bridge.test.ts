import assert from "node:assert/strict";
import test from "node:test";
import {
  editableMirrorPropertiesForIssue,
  clearVpnFailureSignal,
  normalizeNotionDate,
  normalizeStatus,
  notionPropertiesForIssue,
  toPendingStatusChange,
  writeVpnFailureSignal,
} from "../scripts/sync-techdebt-stories.js";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import type { JiraIssue } from "../src/jira.js";

test("normalizeStatus trims, collapses whitespace, and ignores case", () => {
  assert.equal(normalizeStatus("  In   Progress "), "in progress");
});

test("toPendingStatusChange returns null when Notion status matches Jira status", () => {
  const change = toPendingStatusChange({
    id: "page-1",
    properties: {
      "Issue Key": richText("TECHDEBT-1"),
      Status: richText("In Progress"),
      "Jira Status": richText(" in progress "),
      Updated: date("2026-05-15T13:00:00.000-0400"),
    },
  });

  assert.equal(change, null);
});

test("toPendingStatusChange returns a requested transition when statuses differ", () => {
  const change = toPendingStatusChange({
    id: "page-1",
    properties: {
      "Issue Key": richText("TECHDEBT-1"),
      Status: richText("Done"),
      "Jira Status": richText("In Progress"),
      Updated: date("2026-05-15T13:00:00.000-0400"),
    },
  });

  assert.deepEqual(change && {
    issueKey: change.issueKey,
    requestedStatus: change.requestedStatus,
    syncedJiraStatus: change.syncedJiraStatus,
    syncedUpdated: change.syncedUpdated,
  }, {
    issueKey: "TECHDEBT-1",
    requestedStatus: "Done",
    syncedJiraStatus: "In Progress",
    syncedUpdated: "2026-05-15T13:00:00.000-0400",
  });
});

test("toPendingStatusChange prefers editable Board Status over read-only Status", () => {
  const change = toPendingStatusChange({
    id: "page-1",
    properties: {
      "Issue Key": richText("TECHDEBT-1"),
      "Board Status": select("Ready for QA"),
      Status: richText("In Progress"),
      "Jira Status": richText("In Progress"),
      Updated: date("2026-05-15T13:00:00.000-0400"),
    },
  });

  assert.equal(change?.requestedStatus, "Ready for QA");
});

test("notionPropertiesForIssue maps Jira issue into Notion REST properties", () => {
  const issue: JiraIssue = {
    id: "10001",
    key: "TECHDEBT-1",
    fields: {
      summary: "Fix old flow",
      status: { name: "Ready for QA" },
      priority: { name: "Minor" },
      issuetype: { name: "Story" },
      assignee: { displayName: "Diego Delgado" },
      updated: "2026-05-15T13:00:00.000-0400",
      created: "2026-05-14T10:00:00.000-0400",
      duedate: "2026-05-20",
      labels: ["June_2026_Compass_Release"],
      customfield_10008: "TECHDEBT-4",
    },
  };

  const properties = notionPropertiesForIssue({
    issue,
    jiraBaseUrl: "https://jira.dev.upenn.edu",
    syncError: "Example error",
  });

  assert.deepEqual(properties.Name, {
    title: [{ type: "text", text: { content: "Fix old flow" } }],
  });
  assert.deepEqual(properties.Status, {
    rich_text: [{ type: "text", text: { content: "Ready for QA" } }],
  });
  assert.deepEqual(properties["Jira Link"], {
    url: "https://jira.dev.upenn.edu/browse/TECHDEBT-1",
  });
  assert.deepEqual(properties.Labels, {
    multi_select: [{ name: "June_2026_Compass_Release" }],
  });
  assert.deepEqual(properties["Sync Error"], {
    rich_text: [{ type: "text", text: { content: "Example error" } }],
  });
});

test("normalizeNotionDate converts Jira timestamps to ISO timestamps", () => {
  assert.equal(
    normalizeNotionDate("2026-05-15T13:00:00.000-0400"),
    "2026-05-15T17:00:00.000Z",
  );
});

test("editableMirrorPropertiesForIssue only writes editable bridge fields", () => {
  const issue: JiraIssue = {
    id: "10001",
    key: "TECHDEBT-1",
    fields: {
      status: { name: "Ready" },
    },
  };

  assert.deepEqual(editableMirrorPropertiesForIssue({ issue, syncError: "" }), {
    "Board Status": { select: { name: "Ready" } },
    "Writeback Error": { rich_text: [] },
  });
});

test("writeVpnFailureSignal creates a Codex-readable remediation marker", async () => {
  await writeVpnFailureSignal({
    jiraBaseUrl: "https://jira.dev.upenn.edu",
    error: new Error("connect ETIMEDOUT"),
  });

  const marker = await readFile(
    "/Users/diegodelgado/Developer/Personal/Notion-JIRA-Techdebt-Worker/logs/vpn-reactivation-needed.json",
    "utf8",
  );
  const prompt = await readFile(
    "/Users/diegodelgado/Developer/Personal/Notion-JIRA-Techdebt-Worker/logs/vpn-reactivation-needed.md",
    "utf8",
  );

  assert.match(marker, /reactivate_globalprotect/);
  assert.match(prompt, /Use Computer Use to open GlobalProtect/);

  await clearVpnFailureSignal();
  await assert.rejects(
    access(
      "/Users/diegodelgado/Developer/Personal/Notion-JIRA-Techdebt-Worker/logs/vpn-reactivation-needed.json",
      constants.F_OK,
    ),
  );
});

function richText(content: string) {
  return {
    type: "rich_text",
    rich_text: [{ plain_text: content }],
  };
}

function date(start: string) {
  return {
    type: "date",
    date: { start },
  };
}

function select(name: string) {
  return {
    type: "select",
    select: { name },
  };
}
