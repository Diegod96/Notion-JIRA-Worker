import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDefaultJiraJql,
  compassReleaseLabels,
  jiraJqlFromEnv,
} from "../src/config.js";

test("compassReleaseLabels builds a rolling release label window", () => {
  assert.deepEqual(
    compassReleaseLabels({ startMonth: "2026-06", count: 2 }),
    ["June_2026_Compass_Release", "July_2026_Compass_Release"],
  );
});

test("compassReleaseLabels rolls across year boundaries", () => {
  assert.deepEqual(
    compassReleaseLabels({ startMonth: "2026-12", count: 2 }),
    ["December_2026_Compass_Release", "January_2027_Compass_Release"],
  );
});

test("buildDefaultJiraJql keeps assignee applied to every release label", () => {
  assert.equal(
    buildDefaultJiraJql({
      assignee: "diegodel",
      releaseLabelStartMonth: "2026-06",
      releaseLabelWindowSize: 2,
    }),
    'assignee = diegodel AND "Epic Link" is not EMPTY AND project is not EMPTY AND labels in (June_2026_Compass_Release, July_2026_Compass_Release)',
  );
});

test("jiraJqlFromEnv lets explicit JIRA_JQL override generated release JQL", () => {
  const originalJql = process.env.JIRA_JQL;
  process.env.JIRA_JQL = "project = TEST";

  try {
    assert.equal(jiraJqlFromEnv(), "project = TEST");
  } finally {
    restoreEnv("JIRA_JQL", originalJql);
  }
});

test("jiraJqlFromEnv uses release env vars when JIRA_JQL is not set", () => {
  const originalJql = process.env.JIRA_JQL;
  const originalAssignee = process.env.JIRA_ASSIGNEE;
  const originalStartMonth = process.env.RELEASE_LABEL_START_MONTH;
  const originalWindowSize = process.env.RELEASE_LABEL_WINDOW_SIZE;

  delete process.env.JIRA_JQL;
  process.env.JIRA_ASSIGNEE = "diegodel";
  process.env.RELEASE_LABEL_START_MONTH = "2026-07";
  process.env.RELEASE_LABEL_WINDOW_SIZE = "2";

  try {
    assert.equal(
      jiraJqlFromEnv(),
      'assignee = diegodel AND "Epic Link" is not EMPTY AND project is not EMPTY AND labels in (July_2026_Compass_Release, August_2026_Compass_Release)',
    );
  } finally {
    restoreEnv("JIRA_JQL", originalJql);
    restoreEnv("JIRA_ASSIGNEE", originalAssignee);
    restoreEnv("RELEASE_LABEL_START_MONTH", originalStartMonth);
    restoreEnv("RELEASE_LABEL_WINDOW_SIZE", originalWindowSize);
  }
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
