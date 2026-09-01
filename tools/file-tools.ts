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
 * Computes a line based diff using the classic LCS dynamic programming table.
 * Returns the diff body without the `---`/`+++` header.
 */
function lineDiff(beforeLines: string[], afterLines: string[]): { lines: string[]; added: number; removed: number } {
  const rows = beforeLines.length;
  const columns = afterLines.length;

  // The DP table is O(rows * columns); above that budget the payload is not a
  // reviewable text file anymore, so we report the change without the details.
  if ((rows + 1) * (columns + 1) > 4_000_000) {
    return {
      lines: [`@@ file too large for a line diff (${rows} -> ${columns} lines) @@`],
      added: columns,
      removed: rows
    };
  }

  const width = columns + 1;
  const lcs = new Uint32Array((rows + 1) * width);
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = columns - 1; j >= 0; j -= 1) {
      lcs[i * width + j] =
        beforeLines[i] === afterLines[j]
          ? (lcs[(i + 1) * width + (j + 1)] ?? 0) + 1
          : Math.max(lcs[(i + 1) * width + j] ?? 0, lcs[i * width + (j + 1)] ?? 0);
    }
  }

  const lines: string[] = [];
  let added = 0;
  let removed = 0;
  let i = 0;
  let j = 0;

  while (i < rows && j < columns) {
    if (beforeLines[i] === afterLines[j]) {
      lines.push(` ${beforeLines[i] ?? ""}`);
      i += 1;
      j += 1;
    } else if ((lcs[(i + 1) * width + j] ?? 0) >= (lcs[i * width + (j + 1)] ?? 0)) {
      lines.push(`-${beforeLines[i] ?? ""}`);
      removed += 1;
      i += 1;
    } else {
      lines.push(`+${afterLines[j] ?? ""}`);
      added += 1;
      j += 1;
    }
  }
  for (; i < rows; i += 1) {
    lines.push(`-${beforeLines[i] ?? ""}`);
    removed += 1;
  }
  for (; j < columns; j += 1) {
    lines.push(`+${afterLines[j] ?? ""}`);
    added += 1;
  }

  return { lines, added, removed };
}

/** Compares a file between two refs and produces a line based unified diff. */
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

  const { lines, added: addedLines, removed: removedLines } = lineDiff(
    before.data.content.split("\n"),
    after.data.content.split("\n")
  );
  const diffLines = [`--- ${filePath}@${ref1}`, `+++ ${filePath}@${ref2}`, ...lines];

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
