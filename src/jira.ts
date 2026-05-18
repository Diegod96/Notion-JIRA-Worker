import { DEFAULT_JIRA_BASE_URL, DEFAULT_JIRA_JQL } from "./config.js";

export type JiraIssue = {
  id: string;
  key: string;
  fields: {
    summary?: string | null;
    status?: { name?: string | null } | null;
    priority?: { name?: string | null } | null;
    issuetype?: { name?: string | null } | null;
    assignee?: { displayName?: string | null; name?: string | null; emailAddress?: string | null } | null;
    updated?: string | null;
    created?: string | null;
    duedate?: string | null;
    labels?: string[] | null;
    customfield_10008?: string | null;
    [key: string]: unknown;
  };
};

export type JiraSearchPage = {
  issues: JiraIssue[];
  startAt: number;
  maxResults: number;
  total: number;
};

export type JiraTransition = {
  id: string;
  name: string;
  to?: { name?: string | null } | null;
};

export type JiraIssueFieldsUpdate = Record<string, unknown>;

export type JiraClientOptions = {
  baseUrl?: string;
  pat: string;
  fetchImpl?: typeof fetch;
};

export class JiraClient {
  private readonly baseUrl: string;
  private readonly pat: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: JiraClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_JIRA_BASE_URL);
    this.pat = options.pat;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async myself(): Promise<unknown> {
    return this.request("/rest/api/2/myself");
  }

  async searchIssues(options: {
    jql?: string;
    startAt?: number;
    maxResults?: number;
  } = {}): Promise<JiraSearchPage> {
    const body = {
      jql: options.jql ?? DEFAULT_JIRA_JQL,
      startAt: options.startAt ?? 0,
      maxResults: options.maxResults ?? 50,
      fields: [
        "summary",
        "status",
        "priority",
        "issuetype",
        "assignee",
        "updated",
        "created",
        "duedate",
        "labels",
        "customfield_10008",
      ],
    };

    return this.request("/rest/api/2/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }) as Promise<JiraSearchPage>;
  }

  async searchAllIssues(options: {
    jql?: string;
    maxResults?: number;
  } = {}): Promise<JiraIssue[]> {
    const maxResults = options.maxResults ?? 50;
    const issues: JiraIssue[] = [];
    let startAt = 0;

    while (true) {
      const page = await this.searchIssues({
        jql: options.jql,
        startAt,
        maxResults,
      });
      issues.push(...page.issues);
      startAt = page.startAt + page.issues.length;

      if (startAt >= page.total || page.issues.length === 0) {
        return issues;
      }
    }
  }

  async getIssue(issueKey: string): Promise<JiraIssue> {
    return this.request(`/rest/api/2/issue/${encodeURIComponent(issueKey)}`, {
      method: "GET",
    }) as Promise<JiraIssue>;
  }

  async getTransitions(issueKey: string): Promise<JiraTransition[]> {
    const data = (await this.request(
      `/rest/api/2/issue/${encodeURIComponent(issueKey)}/transitions`,
    )) as { transitions?: JiraTransition[] };
    return data.transitions ?? [];
  }

  async transitionIssue(issueKey: string, transitionId: string): Promise<void> {
    await this.request(`/rest/api/2/issue/${encodeURIComponent(issueKey)}/transitions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transition: { id: transitionId } }),
      expectJson: false,
    });
  }

  async updateIssueFields(issueKey: string, fields: JiraIssueFieldsUpdate): Promise<void> {
    await this.request(`/rest/api/2/issue/${encodeURIComponent(issueKey)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fields }),
      expectJson: false,
    });
  }

  private async request(path: string, init: RequestInit & { expectJson?: boolean } = {}) {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.pat}`,
        Accept: "application/json",
        ...init.headers,
      },
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Jira ${response.status} ${response.statusText}: ${text.slice(0, 500)}`);
    }

    if (init.expectJson === false || response.status === 204) {
      return undefined;
    }

    return response.json();
  }
}

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

export function jiraIssueUrl(baseUrl: string, issueKey: string): string {
  return `${normalizeBaseUrl(baseUrl)}/browse/${encodeURIComponent(issueKey)}`;
}

export function issueSummary(issue: JiraIssue): string {
  return issue.fields.summary?.trim() || issue.key;
}

export function issueStatus(issue: JiraIssue): string {
  return issue.fields.status?.name?.trim() || "";
}

export function issueAssignee(issue: JiraIssue): string {
  const assignee = issue.fields.assignee;
  return assignee?.displayName || assignee?.emailAddress || assignee?.name || "";
}

export function issueEpicLink(issue: JiraIssue): string {
  const epic = issue.fields.customfield_10008;
  return typeof epic === "string" ? epic : "";
}
