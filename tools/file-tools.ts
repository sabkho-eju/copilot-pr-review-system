/**
 * File tools: read repository files at a given ref and compare two revisions.
 * They rely on the GitHub Contents API and reuse the shared configuration.
 */
import { fail, ok, type Tool, type ToolResult } from "../types/Tool.js";
import { loadGitHubApiConfig } from "./github-tools.js";

export interface FileContent {
  path: string;
  ref: string;
  content: string;
  sha: string;
  size: number;
}

export interface FileHistoryEntry {
  sha: string;
  message: string;
  author: string;
  date: string;
}

export interface FileComparison {
  path: string;
  ref1: string;
  ref2: string;
  identical: boolean;
  addedLines: number;
  removedLines: number;
  /** Unified diff between the two revisions. */
  diff: string;
}

interface ContentsResponse {
  content?: string;
  encoding?: string;
  sha: string;
  size: number;
}

interface CommitsResponse {
  sha: string;
  commit: { message: string; author: { name: string; date: string } | null };
}

async function contentsRequest<TData>(endpoint: string): Promise<ToolResult<TData>> {
  const token = process.env["GITHUB_TOKEN"];
  if (!token) {
    return fail<TData>("GITHUB_TOKEN is not set: cannot call the GitHub Contents API.", { source: endpoint });
  }

  const config = await loadGitHubApiConfig();
  const startedAt = Date.now();

  try {
    const response = await fetch(`${config.baseUrl}${endpoint}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: ["Bearer", token].join(" "),
        "X-GitHub-Api-Version": config.apiVersion,
        "User-Agent": config.userAgent
      },
      signal: AbortSignal.timeout(config.timeout)
    });

    const metadata = { durationMs: Date.now() - startedAt, source: endpoint };
    if (!response.ok) {
      return fail<TData>(`GitHub API responded ${response.status} ${response.statusText}`, metadata);
    }
    return ok<TData>((await response.json()) as TData, metadata);
  } catch (error) {
    return fail<TData>(error instanceof Error ? error.message : String(error), {
      durationMs: Date.now() - startedAt,
      source: endpoint
    });
  }
}

/** Returns the decoded content of a file at an optional ref (default branch otherwise). */
export async function getFileContent(
  owner: string,
  repo: string,
  filePath: string,
  ref?: string
): Promise<ToolResult<FileContent>> {
  const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  const response = await contentsRequest<ContentsResponse>(
    `/repos/${owner}/${repo}/contents/${encodeURI(filePath)}${query}`
  );
  if (!response.success || !response.data) {
    return fail<FileContent>(response.error ?? "unable to read the file", response.metadata);
  }

  const payload = response.data;
  if (payload.encoding !== "base64" || typeof payload.content !== "string") {
    return fail<FileContent>(`unsupported encoding for ${filePath}`, response.metadata);
  }

  return ok(
    {
      path: filePath,
      ref: ref ?? "HEAD",
      content: Buffer.from(payload.content, "base64").toString("utf8"),
      sha: payload.sha,
      size: payload.size
    },
    response.metadata
  );
}

/** Returns the commit history that touched a given file. */
export async function getFileHistory(
  owner: string,
  repo: string,
  filePath: string
): Promise<ToolResult<FileHistoryEntry[]>> {
  const config = await loadGitHubApiConfig();
  const response = await contentsRequest<CommitsResponse[]>(
    `/repos/${owner}/${repo}/commits?path=${encodeURIComponent(filePath)}&per_page=${config.pagination.perPage}`
  );
  if (!response.success || !response.data) {
    return fail<FileHistoryEntry[]>(response.error ?? "unable to read the file history", response.metadata);
  }

  const entries = response.data.map((commit) => ({
    sha: commit.sha,
    message: commit.commit.message,
    author: commit.commit.author?.name ?? "unknown",
    date: commit.commit.author?.date ?? ""
  }));

  return ok(entries, response.metadata);
}

/**
 * Compares a file between two refs and produces a minimal line based diff.
 * TODO: replace the naive line comparison by a proper Myers diff implementation.
 */
export async function compareFiles(
  owner: string,
  repo: string,
  filePath: string,
  ref1: string,
  ref2: string
): Promise<ToolResult<FileComparison>> {
  const [before, after] = await Promise.all([
    getFileContent(owner, repo, filePath, ref1),
    getFileContent(owner, repo, filePath, ref2)
  ]);

  if (!before.success || !before.data) {
    return fail<FileComparison>(before.error ?? `unable to read ${filePath}@${ref1}`, before.metadata);
  }
  if (!after.success || !after.data) {
    return fail<FileComparison>(after.error ?? `unable to read ${filePath}@${ref2}`, after.metadata);
  }

  const beforeLines = before.data.content.split("\n");
  const afterLines = after.data.content.split("\n");
  const diffLines: string[] = [`--- ${filePath}@${ref1}`, `+++ ${filePath}@${ref2}`];
  let addedLines = 0;
  let removedLines = 0;

  const maxLines = Math.max(beforeLines.length, afterLines.length);
  for (let index = 0; index < maxLines; index += 1) {
    const beforeLine = beforeLines[index];
    const afterLine = afterLines[index];
    if (beforeLine === afterLine) {
      continue;
    }
    if (beforeLine !== undefined) {
      diffLines.push(`-${beforeLine}`);
      removedLines += 1;
    }
    if (afterLine !== undefined) {
      diffLines.push(`+${afterLine}`);
      addedLines += 1;
    }
  }

  return ok(
    {
      path: filePath,
      ref1,
      ref2,
      identical: addedLines === 0 && removedLines === 0,
      addedLines,
      removedLines,
      diff: diffLines.join("\n")
    },
    { durationMs: (before.metadata.durationMs ?? 0) + (after.metadata.durationMs ?? 0) }
  );
}

/** MCP-facing tool descriptors backed by the functions above. */
export const fileTools: Array<Tool<Record<string, unknown>, unknown>> = [
  {
    name: "get_file_content",
    description: "Read a repository file at an optional ref.",
    parameters: [
      { name: "owner", type: "string", required: true, description: "Repository owner." },
      { name: "repo", type: "string", required: true, description: "Repository name." },
      { name: "path", type: "string", required: true, description: "File path inside the repository." },
      { name: "ref", type: "string", required: false, description: "Branch, tag or commit SHA." }
    ],
    execute: (input) =>
      getFileContent(
        String(input["owner"]),
        String(input["repo"]),
        String(input["path"]),
        input["ref"] === undefined ? undefined : String(input["ref"])
      )
  },
  {
    name: "get_file_history",
    description: "List the commits that touched a given file.",
    parameters: [
      { name: "owner", type: "string", required: true, description: "Repository owner." },
      { name: "repo", type: "string", required: true, description: "Repository name." },
      { name: "path", type: "string", required: true, description: "File path inside the repository." }
    ],
    execute: (input) => getFileHistory(String(input["owner"]), String(input["repo"]), String(input["path"]))
  },
  {
    name: "compare_files",
    description: "Compare a file between two refs and return a line based diff.",
    parameters: [
      { name: "owner", type: "string", required: true, description: "Repository owner." },
      { name: "repo", type: "string", required: true, description: "Repository name." },
      { name: "path", type: "string", required: true, description: "File path inside the repository." },
      { name: "ref1", type: "string", required: true, description: "Base ref." },
      { name: "ref2", type: "string", required: true, description: "Head ref." }
    ],
    execute: (input) =>
      compareFiles(
        String(input["owner"]),
        String(input["repo"]),
        String(input["path"]),
        String(input["ref1"]),
        String(input["ref2"])
      )
  }
];
