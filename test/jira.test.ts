import assert from "node:assert/strict";
import test from "node:test";
import { JiraClient } from "../src/jira.js";

test("getIssueComments paginates until all comments are read", async () => {
  const requests: string[] = [];
  const fetchImpl: typeof fetch = (async (input) => {
    const url = String(input);
    requests.push(url);

    if (url.includes("startAt=0")) {
      return jsonResponse({
        startAt: 0,
        maxResults: 1,
        total: 2,
        comments: [{ id: "10000", body: "first" }],
      });
    }

    return jsonResponse({
      startAt: 1,
      maxResults: 1,
      total: 2,
      comments: [{ id: "10001", body: "second" }],
    });
  }) as typeof fetch;

  const jira = new JiraClient({
    baseUrl: "https://jira.dev.upenn.edu",
    pat: "token",
    fetchImpl,
  });

  const comments = await jira.getIssueComments("TECHDEBT-1", 1);

  assert.equal(requests.length, 2);
  assert.match(requests[0], /\/rest\/api\/2\/issue\/TECHDEBT-1\/comment\?startAt=0&maxResults=1/);
  assert.match(requests[1], /\/rest\/api\/2\/issue\/TECHDEBT-1\/comment\?startAt=1&maxResults=1/);
  assert.deepEqual(comments.map((comment) => comment.body), ["first", "second"]);
});

test("addIssueComment posts body to Jira comment endpoint", async () => {
  let capturedUrl = "";
  let capturedMethod = "";
  let capturedBody = "";

  const fetchImpl: typeof fetch = (async (input, init) => {
    capturedUrl = String(input);
    capturedMethod = init?.method ?? "";
    capturedBody = String(init?.body ?? "");

    return jsonResponse({
      id: "10002",
      body: "Looks good",
      author: { displayName: "Diego Delgado" },
    });
  }) as typeof fetch;

  const jira = new JiraClient({
    baseUrl: "https://jira.dev.upenn.edu",
    pat: "token",
    fetchImpl,
  });

  const comment = await jira.addIssueComment("TECHDEBT-2", "Looks good");

  assert.match(capturedUrl, /\/rest\/api\/2\/issue\/TECHDEBT-2\/comment$/);
  assert.equal(capturedMethod, "POST");
  assert.equal(capturedBody, JSON.stringify({ body: "Looks good" }));
  assert.equal(comment.id, "10002");
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
