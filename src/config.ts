export const DEFAULT_JIRA_BASE_URL = "https://jira.dev.upenn.edu";
export const DEFAULT_JIRA_ASSIGNEE = "diegodel";
export const DEFAULT_RELEASE_LABEL_START_MONTH = "2026-06";
export const DEFAULT_RELEASE_LABEL_WINDOW_SIZE = 2;
export const TECHDEBT_SYNC_KEY = "techdebtStoriesSync";

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export const DEFAULT_JIRA_JQL = buildDefaultJiraJql();

export type JiraJqlOptions = {
  assignee?: string;
  releaseLabelStartMonth?: string;
  releaseLabelWindowSize?: number;
};

export function jiraJqlFromEnv(): string {
  const explicitJql = process.env.JIRA_JQL?.trim();
  if (explicitJql) {
    return explicitJql;
  }

  return buildDefaultJiraJql({
    assignee: optionalEnv("JIRA_ASSIGNEE", DEFAULT_JIRA_ASSIGNEE),
    releaseLabelStartMonth: optionalEnv(
      "RELEASE_LABEL_START_MONTH",
      DEFAULT_RELEASE_LABEL_START_MONTH,
    ),
    releaseLabelWindowSize: Number.parseInt(
      optionalEnv("RELEASE_LABEL_WINDOW_SIZE", String(DEFAULT_RELEASE_LABEL_WINDOW_SIZE)),
      10,
    ),
  });
}

export function buildDefaultJiraJql(options: JiraJqlOptions = {}): string {
  const assignee = options.assignee?.trim() || DEFAULT_JIRA_ASSIGNEE;
  const labels = compassReleaseLabels({
    startMonth: options.releaseLabelStartMonth ?? DEFAULT_RELEASE_LABEL_START_MONTH,
    count: options.releaseLabelWindowSize ?? DEFAULT_RELEASE_LABEL_WINDOW_SIZE,
  });

  return [
    `assignee = ${assignee}`,
    '"Epic Link" is not EMPTY',
    "project is not EMPTY",
    `labels in (${labels.join(", ")})`,
  ].join(" AND ");
}

export function compassReleaseLabels(options: {
  startMonth: string;
  count: number;
}): string[] {
  if (!/^\d{4}-\d{2}$/.test(options.startMonth)) {
    throw new Error("RELEASE_LABEL_START_MONTH must use YYYY-MM format");
  }
  if (!Number.isInteger(options.count) || options.count < 1) {
    throw new Error("RELEASE_LABEL_WINDOW_SIZE must be a positive integer");
  }

  const [yearText, monthText] = options.startMonth.split("-");
  const year = Number.parseInt(yearText, 10);
  const monthIndex = Number.parseInt(monthText, 10) - 1;

  if (monthIndex < 0 || monthIndex > 11) {
    throw new Error("RELEASE_LABEL_START_MONTH month must be between 01 and 12");
  }

  return Array.from({ length: options.count }, (_, offset) => {
    const date = new Date(Date.UTC(year, monthIndex + offset, 1));
    return `${MONTH_NAMES[date.getUTCMonth()]}_${date.getUTCFullYear()}_Compass_Release`;
  });
}

export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value.trim();
}

export function optionalEnv(name: string, fallback: string): string {
  const value = process.env[name];
  return value?.trim() || fallback;
}
