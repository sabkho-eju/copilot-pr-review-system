/**
 * GitHub tools: thin, typed wrappers around the GitHub REST API used by the
 * PR review agent. Every function returns a `ToolResult` so callers never have
 * to deal with exceptions.
 *
 * The token is read lazily from `GITHUB_TOKEN` so nothing secret is required
 * at compile time; without a token the tools degrade to an explicit error.
 */
import { readFile } from "node:fs/promises";

import { fail, ok, type Tool, type ToolResult } from "../types/Tool.js";
import { fromProjectRoot } from "./paths.js";

export interface GitHubApiConfig {
  apiVersion: string;
  baseUrl: string;
  userAgent: string;
  timeout: number;
  retryPolicy: { maxAttempts: number; backoff: "exponential" | "linear"; initialDelayMs: number };
  rateLimit: { requestsPerHour: number; minRemainingBeforeThrottle: number };
  pagination: { perPage: number; maxPages: number };
}

let cachedConfig: GitHubApiConfig | null = null;

/** Loads (and memoises) `config/github-api-config.json`. */
export async function loadGitHubApiConfig(configPath?: string): Promise<GitHubApiConfig> {
  if (cachedConfig && !configPath) {
    return cachedConfig;
  }
  const resolved = configPath ?? fromProjectRoot("config", "github-api-config.json");
  const raw = await readFile(resolved, "utf8");
  const parsed = JSON.parse(raw) as GitHubApiConfig;
  if (!configPath) {
    cachedConfig = parsed;
  }
  return parsed;
}

export interface PullRequestData {
  number: number;
  title: string;
  body: string | null;
  state: string;
  draft: boolean;
  user: { login: string } | null;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  additions: number;
  deletions: number;
  changed_files: number;
  html_url: string;
}

export interface IssueData {
  number: number;
  title: string;
  body: string | null;
  state: string;
  labels: Array<{ name: string }>;
}

export interface CheckRunResult {
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: "success" | "failure" | "neutral" | "cancelled" | "timed_out" | "action_required" | null;
  detailsUrl: string | null;
}

export type ReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

export interface ReviewComment {
  path: string;
  line: number;
  body: string;
}

export interface ReviewInput {
  body: string;
  event: ReviewEvent;
  comments?: ReviewComment[];
}

export interface CreatedReview {
  id: number;
  state: string;
  html_url: string;
}

export interface CreatedComment {
  id: number;
  html_url: string;
}

/** Builds the authorization header value for the GitHub API. */
function authorizationHeader(token: string): string {
  return ["Bearer", token].join(" ");
}

interface RequestOptions {
  method?: "GET" | "POST";
  body?: unknown;
  accept?: string;
  raw?: boolean;
}

/**
 * Performs an authenticated request against the GitHub REST API.
 * Retries are applied according to the configured retry policy.
 */
async function githubRequest<TData>(endpoint: string, options: RequestOptions = {}): Promise<ToolResult<TData>> {
  const token = process.env["GITHUB_TOKEN"];
  if (!token) {
    return fail<TData>("GITHUB_TOKEN is not set: cannot call the GitHub API.", { source: endpoint });
  }

  const config = await loadGitHubApiConfig();
  const startedAt = Date.now();
  let lastError = "unknown error";

  for (let attempt = 1; attempt <= config.retryPolicy.maxAttempts; attempt += 1) {
    try {
      const response = await fetch(`${config.baseUrl}${endpoint}`, {
        method: options.method ?? "GET",
        headers: {
          Accept: options.accept ?? "application/vnd.github+json",
          Authorization: authorizationHeader(token),
          "X-GitHub-Api-Version": config.apiVersion,
          "User-Agent": config.userAgent,
          ...(options.body ? { "Content-Type": "application/json" } : {})
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: AbortSignal.timeout(config.timeout)
      });

      const remainingHeader = response.headers.get("x-ratelimit-remaining");
      const metadata = {
        durationMs: Date.now() - startedAt,
        source: endpoint,
        ...(remainingHeader ? { rateLimitRemaining: Number(remainingHeader) } : {})
      };

      if (!response.ok) {
        lastError = `GitHub API responded ${response.status} ${response.statusText}`;
        // Only 5xx and secondary rate limits are worth retrying.
        if (response.status < 500 && response.status !== 429) {
          return fail<TData>(lastError, metadata);
        }
      } else {
        const data = options.raw ? ((await response.text()) as TData) : ((await response.json()) as TData);
        return ok<TData>(data, metadata);
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    if (attempt < config.retryPolicy.maxAttempts) {
      const delay =
        config.retryPolicy.backoff === "exponential"
          ? config.retryPolicy.initialDelayMs * 2 ** (attempt - 1)
          : config.retryPolicy.initialDelayMs * attempt;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  return fail<TData>(lastError, { durationMs: Date.now() - startedAt, source: endpoint });
}

export function getPullRequest(owner: string, repo: string, pullNumber: number): Promise<ToolResult<PullRequestData>> {
  return githubRequest<PullRequestData>(`/repos/${owner}/${repo}/pulls/${pullNumber}`);
}

export function getPullRequestDiff(owner: string, repo: string, pullNumber: number): Promise<ToolResult<string>> {
  return githubRequest<string>(`/repos/${owner}/${repo}/pulls/${pullNumber}`, {
    accept: "application/vnd.github.v3.diff",
    raw: true
  });
}

export function getIssueDetails(owner: string, repo: string, issueNumber: number): Promise<ToolResult<IssueData>> {
  return githubRequest<IssueData>(`/repos/${owner}/${repo}/issues/${issueNumber}`);
}

export function createPullRequestComment(
  owner: string,
  repo: string,
  pullNumber: number,
  body: string
): Promise<ToolResult<CreatedComment>> {
  return githubRequest<CreatedComment>(`/repos/${owner}/${repo}/issues/${pullNumber}/comments`, {
    method: "POST",
    body: { body }
  });
}

export function createPullRequestReview(
  owner: string,
  repo: string,
  pullNumber: number,
  review: ReviewInput
): Promise<ToolResult<CreatedReview>> {
  return githubRequest<CreatedReview>(`/repos/${owner}/${repo}/pulls/${pullNumber}/reviews`, {
    method: "POST",
    body: review
  });
}

/**
 * Returns the check runs attached to the head commit of a pull request.
 * TODO: paginate when a PR has more than `pagination.perPage` check runs.
 */
export async function getCheckRunResults(
  owner: string,
  repo: string,
  pullNumber: number
): Promise<ToolResult<CheckRunResult[]>> {
  const pullRequest = await getPullRequest(owner, repo, pullNumber);
  if (!pullRequest.success || !pullRequest.data) {
    return fail<CheckRunResult[]>(pullRequest.error ?? "unable to resolve the head SHA", pullRequest.metadata);
  }

  const response = await githubRequest<{ check_runs: Array<Record<string, unknown>> }>(
    `/repos/${owner}/${repo}/commits/${pullRequest.data.head.sha}/check-runs`
  );
  if (!response.success || !response.data) {
    return fail<CheckRunResult[]>(response.error ?? "unable to list check runs", response.metadata);
  }

  const checkRuns = response.data.check_runs.map((run) => ({
    name: String(run["name"] ?? "unknown"),
    status: (run["status"] ?? "completed") as CheckRunResult["status"],
    conclusion: (run["conclusion"] ?? null) as CheckRunResult["conclusion"],
    detailsUrl: (run["details_url"] ?? null) as string | null
  }));

  return ok(checkRuns, response.metadata);
}

/** MCP-facing tool descriptors backed by the functions above. */
export const githubTools: Array<Tool<Record<string, unknown>, unknown>> = [
  {
    name: "github_get_pr",
    description: "Fetch the metadata of a pull request (title, body, branches, stats).",
    parameters: [
      { name: "owner", type: "string", required: true, description: "Repository owner." },
      { name: "repo", type: "string", required: true, description: "Repository name." },
      { name: "pr_number", type: "number", required: true, description: "Pull request number." }
    ],
    execute: (input) =>
      getPullRequest(String(input["owner"]), String(input["repo"]), Number(input["pr_number"]))
  },
  {
    name: "github_get_pr_diff",
    description: "Fetch the unified diff of a pull request.",
    parameters: [
      { name: "owner", type: "string", required: true, description: "Repository owner." },
      { name: "repo", type: "string", required: true, description: "Repository name." },
      { name: "pr_number", type: "number", required: true, description: "Pull request number." }
    ],
    execute: (input) =>
      getPullRequestDiff(String(input["owner"]), String(input["repo"]), Number(input["pr_number"]))
  },
  {
    name: "github_get_issue",
    description: "Fetch an issue linked to the pull request under review.",
    parameters: [
      { name: "owner", type: "string", required: true, description: "Repository owner." },
      { name: "repo", type: "string", required: true, description: "Repository name." },
      { name: "issue_number", type: "number", required: true, description: "Issue number." }
    ],
    execute: (input) =>
      getIssueDetails(String(input["owner"]), String(input["repo"]), Number(input["issue_number"]))
  },
  {
    name: "github_get_check_runs",
    description: "List the check runs of the head commit of a pull request.",
    parameters: [
      { name: "owner", type: "string", required: true, description: "Repository owner." },
      { name: "repo", type: "string", required: true, description: "Repository name." },
      { name: "pr_number", type: "number", required: true, description: "Pull request number." }
    ],
    execute: (input) =>
      getCheckRunResults(String(input["owner"]), String(input["repo"]), Number(input["pr_number"]))
  },
  {
    name: "github_create_comment",
    description: "Post a comment on a pull request conversation.",
    parameters: [
      { name: "owner", type: "string", required: true, description: "Repository owner." },
      { name: "repo", type: "string", required: true, description: "Repository name." },
      { name: "pr_number", type: "number", required: true, description: "Pull request number." },
      { name: "body", type: "string", required: true, description: "Markdown body of the comment." }
    ],
    execute: (input) =>
      createPullRequestComment(
        String(input["owner"]),
        String(input["repo"]),
        Number(input["pr_number"]),
        String(input["body"])
      )
  },
  {
    name: "github_create_review",
    description: "Publish a full review (body, event and optional inline comments).",
    parameters: [
      { name: "owner", type: "string", required: true, description: "Repository owner." },
      { name: "repo", type: "string", required: true, description: "Repository name." },
      { name: "pr_number", type: "number", required: true, description: "Pull request number." },
      { name: "review", type: "object", required: true, description: "Review payload: body, event, comments." }
    ],
    execute: (input) =>
      createPullRequestReview(
        String(input["owner"]),
        String(input["repo"]),
        Number(input["pr_number"]),
        input["review"] as ReviewInput
      )
  }
];
