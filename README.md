# copilot-pr-review-system

Complete PR Review System: **Agents**, **Skills**, **Tools**, **Instructions** and **MCP** — a runnable
TypeScript scaffold showing how those five layers fit together.

## The five layers

| Layer | Role | Where |
| --- | --- | --- |
| **Instructions** | Micro-rules (how to call a tool, how to handle errors) | `instructions/*.md` |
| **Skills** | Reusable, multi-step know-how loaded on demand | `skills/*.md` |
| **Tools** | Callable functions performing one concrete action | `tools/*.ts` |
| **MCP** | Standard protocol exposing tools and resources | `mcp/*` |
| **Agent** | Autonomous orchestrator that decides and iterates | `agents/pr-review-agent.ts` |

```
AGENT ──┬─→ calls TOOLS            (github, file, analysis)
        ├─→ loads SKILLS           (pr-understanding → pr-reviewer)
        ├─→ follows INSTRUCTIONS   (general, review, tool usage)
        └─→ speaks MCP             (tools/list, tools/call, resources/read)
```

## Repository layout

```
agents/pr-review-agent.ts        Orchestration loop, review rendering, CLI entry point
skills/pr-understanding.md       Gather the facts of a PR
skills/pr-reviewer.md            Six-step review methodology
tools/github-tools.ts            GitHub REST API wrappers (PR, diff, issues, checks, reviews)
tools/file-tools.ts              Contents API: read, history, compare
tools/analysis-tools.ts          Offline diff heuristics: quality, security, coverage, risk
tools/paths.ts                   Project root resolution (works from sources and from dist/)
instructions/*.md                Execution order, review guidelines, tool usage rules
mcp/mcp-server.ts                MCP server: tool + resource registries, transports
mcp/tools-mcp.json               JSON schema of every exposed tool
mcp/resources-mcp.json           Skills, instructions and configs exposed as resources
mcp/transport-config.json        stdio / http / websocket transport settings
config/agent-config.json         Skills to load, tool allow-list, iteration budget
config/mcp-client-config.json    How a client connects to the MCP server
config/github-api-config.json    Base URL, API version, retry and pagination policies
types/*.ts                       Agent, Skill, Tool, Instruction and MCP interfaces
```

## Requirements

- Node.js >= 20 (the tools use the built-in `fetch`)
- A `GITHUB_TOKEN` environment variable **only** to hit the real GitHub API.
  Without it the agent still runs and reports the missing data explicitly.

## Install and build

```bash
npm install
npm run build      # tsc -> dist/
npm run typecheck  # type-check without emitting
```

## Example usage

### 1. Run the agent (dry run, nothing is published)

```bash
npm run build
node dist/agents/pr-review-agent.js octocat/hello-world 42 --dry-run
```

With a token, drop `--dry-run` to publish the review on the pull request:

```bash
export GITHUB_TOKEN=...   # a token with the `repo` or `public_repo` scope
node dist/agents/pr-review-agent.js octocat/hello-world 42
```

### 2. Use the agent programmatically

```ts
import { createPullRequestReviewAgent } from "./dist/agents/pr-review-agent.js";

const agent = await createPullRequestReviewAgent(/* dryRun */ true);
const result = await agent.run({ owner: "octocat", repo: "hello-world", pullNumber: 42 });

console.log(result.state, result.iterations);
console.log(result.reviewBody);
```

### 3. Talk to the MCP server

The server speaks newline-delimited JSON on stdio by default:

```bash
npm run build
printf '{"id":1,"method":"tools/list"}\n' | node dist/mcp/mcp-server.js
printf '{"id":2,"method":"resources/read","params":{"uri":"skill://pr-reviewer"}}\n' | node dist/mcp/mcp-server.js
```

Calling a tool:

```bash
printf '{"id":3,"method":"tools/call","params":{"name":"detect_security_issues","arguments":{"diff":"--- a/a.ts\\n+++ b/a.ts\\n@@ -1 +1,2 @@\\n+const x = eval(input);\\n"}}}\n' \
  | node dist/mcp/mcp-server.js
```

```json
{"id":3,"result":{"success":true,"data":{"language":"typescript","findings":[{"file":"a.ts","line":1,"severity":"high","rule":"dangerous-eval","message":"Dynamic code evaluation."}],"hasBlockingIssue":true},"metadata":{}}}
```

Switch to HTTP by setting `"default": "http"` in `mcp/transport-config.json`, then POST the same
payloads to `http://127.0.0.1:3000`.

## Execution flow

1. Load `config/agent-config.json`, the instructions and the skills (dependencies first).
2. `github_get_pr` -> PR metadata.
3. `github_get_pr_diff` -> unified diff.
4. `github_get_check_runs` -> CI status.
5. Run the `pr-reviewer` steps, feeding the diff into `analyze_diff`,
   `detect_security_issues`, `analyze_test_coverage` and `assess_risk_level`.
6. Render the markdown review and, unless in dry run, publish it with
   `github_create_review`.

Every tool returns a `ToolResult` (`success`, `data`, `error`, `metadata`), so a failing step
degrades the review instead of crashing the run.

## Extending the scaffold

- **New tool** — export a function plus a `Tool` descriptor in `tools/`, add it to the registry
  imported by `mcp/mcp-server.ts` and to `toolsAvailable` in `config/agent-config.json`.
- **New skill** — drop a markdown file in `skills/` with front matter (`name`, `version`,
  `description`, `dependencies`) and `## Step N — …` sections; the agent parses them.
- **New instruction** — drop a markdown file in `instructions/` with `title`/`priority` front
  matter; it is loaded automatically.

Tool implementations marked with `TODO` are deliberate extension points (real diff algorithm,
AST-based linting, WebSocket transport).
