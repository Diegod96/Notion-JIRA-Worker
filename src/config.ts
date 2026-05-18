export const DEFAULT_JIRA_BASE_URL = "https://jira.dev.upenn.edu";
export const DEFAULT_JIRA_JQL =
  'assignee = diegodel AND "Epic Link" in (SYSM-1, TECHDEBT-4)';
export const TECHDEBT_SYNC_KEY = "techdebtStoriesSync";

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
