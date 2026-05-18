import assert from "node:assert/strict";
import test from "node:test";
import { toWorkerProperties } from "../src/index.js";
import type { JiraIssue } from "../src/jira.js";

test("toWorkerProperties maps Jira issue fields into worker properties", () => {
  const issue: JiraIssue = {
    id: "10001",
    key: "TECHDEBT-1",
    fields: {
      summary: "Fix old flow",
      status: { name: "In Progress" },
      priority: { name: "Medium" },
      issuetype: { name: "Story" },
      assignee: { displayName: "Diego Delgado" },
      updated: "2026-05-15T13:00:00.000-0400",
      created: "2026-05-14T10:00:00.000-0400",
      duedate: "2026-05-20",
      labels: ["techdebt", "flow"],
      customfield_10008: "TECHDEBT-4",
    },
  };

  const properties = toWorkerProperties(issue, "https://jira.dev.upenn.edu");

  assert.deepEqual(properties.Name, [["Fix old flow"]]);
  assert.deepEqual(properties["Issue Key"], [["TECHDEBT-1"]]);
  assert.deepEqual(properties.Status, [["In Progress"]]);
  assert.deepEqual(properties["Jira Status"], [["In Progress"]]);
  assert.deepEqual(properties["Jira Link"], [["https://jira.dev.upenn.edu/browse/TECHDEBT-1"]]);
  assert.deepEqual(properties.Labels, [["techdebt,flow"]]);
});
