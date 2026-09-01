/**
 * PR review agent: loads its configuration, its skills and its instructions,
 * then orchestrates the tools exposed by the MCP registry to produce a review.
 *
 * Run it with:
 *   npm run build && node dist/agents/pr-review-agent.js owner/repo 42
 * Add `--dry-run` (default when GITHUB_TOKEN is missing) to print the review
 * instead of publishing it.
 */
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { AgentState, type Agent, type AgentConfig, type AgentContext, type AgentDecision, type AgentRunResult, type PullRequestRef } from "../types/Agent.js";
import type { Skill, SkillResult, SkillStep } from "../types/Skill.js";
import type { Instruction } from "../types/Instruction.js";
import { InstructionPriority } from "../types/Instruction.js";
import type { Tool, ToolResult } from "../types/Tool.js";
import { fromProjectRoot, projectRoot } from "../tools/paths.js";
import { toolRegistry } from "../mcp/mcp-server.js";
import { createPullRequestReview, type PullRequestData, type CheckRunResult } from "../tools/github-tools.js";
import {
  analyzeCodeQuality,
  analyzeTestCoverage,
  assessRiskLevel,
  detectSecurityIssues,
  summarizeChanges,
  type CodeQualityReport,
  type RiskAssessment,
  type SecurityReport,
  type TestCoverageReport
} from "../tools/analysis-tools.js";

const repoRoot = projectRoot;

/** Parses the YAML-ish front matter of a markdown file. */
function parseFrontMatter(markdown: string): { attributes: Record<string, string | string[]>; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(markdown);
  if (!match?.[1]) {
    return { attributes: {}, body: markdown };
  }

  const attributes: Record<string, string | string[]> = {};
  let currentListKey: string | null = null;

  for (const line of match[1].split("\n")) {
    const listItem = /^\s*-\s+(.*)$/.exec(line);
    if (listItem?.[1] && currentListKey) {
      (attributes[currentListKey] as string[]).push(listItem[1].trim());
      continue;
    }
    const pair = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (pair?.[1] !== undefined) {
      const key = pair[1];
      const value = (pair[2] ?? "").trim();
      if (value === "" || value === "[]") {
        attributes[key] = [];
        currentListKey = value === "" ? key : null;
        if (value === "[]") {
          currentListKey = null;
        }
      } else {
        attributes[key] = value;
        currentListKey = null;
      }
    }
  }

  return { attributes, body: markdown.slice(match[0].length) };
}

function asString(value: string | string[] | undefined, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function asArray(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.length > 0) return [value];
  return [];
}

/** Extracts `## Step N — Title` sections as skill steps. */
function parseSkillSteps(body: string): SkillStep[] {
  const steps: SkillStep[] = [];
  const sections = body.split(/^## /m).slice(1);

  for (const section of sections) {
    const [heading = "", ...rest] = section.split("\n");
    if (!/^Step\s/i.test(heading)) {
      continue;
    }
    const content = rest.join("\n");
    const goal = /\*\*Goal:\*\*\s*(.+)/.exec(content)?.[1] ?? heading.trim();
    const dataPoints = content
      .split("\n")
      .filter((line) => /^\s*-\s+/.test(line))
      .map((line) => line.replace(/^\s*-\s+/, "").trim());

    steps.push({ name: heading.trim(), description: goal.trim(), dataPoints });
  }

  return steps;
}

export async function loadAgentConfig(configPath?: string): Promise<AgentConfig> {
  const resolved = configPath ?? fromProjectRoot("config", "agent-config.json");
  return JSON.parse(await readFile(resolved, "utf8")) as AgentConfig;
}

export async function loadSkill(skillsDir: string, name: string): Promise<Skill> {
  const markdown = await readFile(path.join(skillsDir, `${name}.md`), "utf8");
  const { attributes, body } = parseFrontMatter(markdown);

  return {
    name: asString(attributes["name"], name),
    description: asString(attributes["description"], ""),
    version: asString(attributes["version"], "1.0.0"),
    dependencies: asArray(attributes["dependencies"]),
    steps: parseSkillSteps(body),
    content: body
  };
}

/** Loads the requested skills, dependencies first and without duplicates. */
export async function loadSkills(skillsDir: string, names: string[]): Promise<Skill[]> {
  const loaded = new Map<string, Skill>();

  const loadRecursively = async (name: string): Promise<void> => {
    if (loaded.has(name)) {
      return;
    }
    const skill = await loadSkill(skillsDir, name);
    // Mark as loaded before recursing to tolerate cyclic declarations.
    loaded.set(name, skill);
    for (const dependency of skill.dependencies) {
      await loadRecursively(dependency);
    }
    loaded.delete(name);
    loaded.set(name, skill);
  };

  for (const name of names) {
    await loadRecursively(name);
  }

  return [...loaded.values()];
}

export async function loadInstructions(instructionsDir: string): Promise<Instruction[]> {
  const entries = (await readdir(instructionsDir)).filter((entry) => entry.endsWith(".md")).sort();
  const instructions: Instruction[] = [];

  for (const entry of entries) {
    const markdown = await readFile(path.join(instructionsDir, entry), "utf8");
    const { attributes, body } = parseFrontMatter(markdown);
    const priority = asString(attributes["priority"], "MEDIUM").toUpperCase();

    instructions.push({
      title: asString(attributes["title"], entry.replace(/\.md$/, "")),
      context: {
        when: asString(attributes["when"], "always"),
        why: asString(attributes["why"], ""),
        targetAudience: asString(attributes["targetAudience"], "pr-review-agent")
      },
      rules: body
        .split("\n")
        .filter((line) => /^\s*[-*]\s+/.test(line))
        .map((line) => line.replace(/^\s*[-*]\s+/, "").trim()),
      examples: body
        .split("\n")
        .filter((line) => line.includes("✅") || line.includes("❌"))
        .map((line) => line.replace(/^\s*[-*]\s+/, "").trim()),
      priority:
        (Object.values(InstructionPriority) as string[]).includes(priority)
          ? (priority as InstructionPriority)
          : InstructionPriority.Medium,
      content: body
    });
  }

  return instructions;
}

export interface AgentOptions {
  config: AgentConfig;
  skills: Skill[];
  instructions: Instruction[];
  tools?: Array<Tool<Record<string, unknown>, unknown>>;
  /** When true the review is printed instead of being published on GitHub. */
  dryRun?: boolean;
}

export class PullRequestReviewAgent implements Agent {
  readonly name: string;
  readonly modelId: string;
  readonly skills: Skill[];
  readonly instructions: Instruction[];
  readonly tools: Array<Tool<Record<string, unknown>, unknown>>;

  private readonly config: AgentConfig;
  private readonly dryRun: boolean;

  constructor(options: AgentOptions) {
    this.config = options.config;
    this.name = options.config.agentName;
    this.modelId = options.config.modelId;
    this.skills = options.skills;
    this.instructions = options.instructions;
    this.dryRun = options.dryRun ?? true;
    this.tools = (options.tools ?? toolRegistry).filter((tool) =>
      options.config.toolsAvailable.includes(tool.name)
    );
  }

  /** Calls a tool by name, enforcing the `toolsAvailable` allow-list. */
  async callTool(name: string, params: Record<string, unknown>): Promise<ToolResult<unknown>> {
    const tool = this.tools.find((candidate) => candidate.name === name);
    if (!tool) {
      return { success: false, data: null, error: `tool ${name} is not available to ${this.name}`, metadata: {} };
    }
    try {
      return await tool.execute(params);
    } catch (error) {
      return {
        success: false,
        data: null,
        error: error instanceof Error ? error.message : String(error),
        metadata: {}
      };
    }
  }

  /** Chooses the next action from the current context. */
  decide(context: AgentContext): AgentDecision {
    const { owner, repo, pullNumber } = context.pullRequest;

    if (context.collected["pullRequest"] === undefined) {
      return {
        action: "call_tool",
        toolToCall: "github_get_pr",
        params: { owner, repo, pr_number: pullNumber },
        reasoning: "The metadata of the PR is required by every skill step."
      };
    }
    if (context.collected["diff"] === undefined) {
      return {
        action: "call_tool",
        toolToCall: "github_get_pr_diff",
        params: { owner, repo, pr_number: pullNumber },
        reasoning: "The diff drives the core changes and analysis steps."
      };
    }
    if (context.collected["checkRuns"] === undefined) {
      return {
        action: "call_tool",
        toolToCall: "github_get_check_runs",
        params: { owner, repo, pr_number: pullNumber },
        reasoning: "Merge readiness depends on the CI status."
      };
    }
    if (context.results.length < this.skillSteps().length) {
      return { action: "run_step", reasoning: "Some skill steps have not been executed yet." };
    }
    return { action: "finish", reasoning: "Every step produced a result." };
  }

  private skillSteps(): SkillStep[] {
    return this.skills.flatMap((skill) => (skill.name === "pr-reviewer" ? skill.steps : []));
  }

  async run(pullRequest: PullRequestRef): Promise<AgentRunResult> {
    const context: AgentContext = {
      pullRequest,
      collected: {},
      results: [],
      iteration: 0,
      state: AgentState.Initializing
    };

    while (context.iteration < this.config.maxIterations) {
      context.iteration += 1;
      const decision = this.decide(context);

      if (decision.action === "finish") {
        context.state = AgentState.Complete;
        break;
      }

      if (decision.action === "call_tool" && decision.toolToCall) {
        context.state = AgentState.Analyzing;
        const result = await this.callTool(decision.toolToCall, decision.params ?? {});
        const key =
          decision.toolToCall === "github_get_pr"
            ? "pullRequest"
            : decision.toolToCall === "github_get_pr_diff"
              ? "diff"
              : "checkRuns";
        // Store `null` on failure so the loop makes progress instead of retrying forever.
        context.collected[key] = result.success ? result.data : null;
        if (!result.success) {
          context.results.push({
            stepName: decision.toolToCall,
            output: "",
            isSuccessful: false,
            error: result.error ?? "unknown error"
          });
        }
        continue;
      }

      context.state = AgentState.Reviewing;
      context.results.push(...this.runSkillSteps(context));
    }

    if (context.state !== AgentState.Complete) {
      context.state = AgentState.Complete;
    }

    const reviewBody = renderReview(context);

    if (!this.dryRun) {
      const published = await createPullRequestReview(
        pullRequest.owner,
        pullRequest.repo,
        pullRequest.pullNumber,
        { body: reviewBody, event: "COMMENT" }
      );
      if (!published.success) {
        context.results.push({
          stepName: "publish",
          output: "",
          isSuccessful: false,
          error: published.error ?? "unable to publish the review"
        });
        context.state = AgentState.Failed;
      }
    }

    return {
      state: context.state,
      reviewBody,
      results: context.results,
      iterations: context.iteration
    };
  }

  /** Executes the analysis behind each step of the `pr-reviewer` skill. */
  private runSkillSteps(context: AgentContext): SkillResult[] {
    const diff = typeof context.collected["diff"] === "string" ? (context.collected["diff"] as string) : "";
    const quality = analyzeCodeQuality(diff).data;
    const security = detectSecurityIssues(diff).data;
    const coverage = analyzeTestCoverage(diff).data;
    const risk = assessRiskLevel(summarizeChanges(diff)).data;

    context.collected["quality"] = quality;
    context.collected["security"] = security;
    context.collected["coverage"] = coverage;
    context.collected["risk"] = risk;

    return this.skillSteps().map((step) => ({
      stepName: step.name,
      output: step.description,
      isSuccessful: true
    }));
  }
}

/** Renders the markdown review from everything the agent collected. */
export function renderReview(context: AgentContext): string {
  const pullRequest = context.collected["pullRequest"] as PullRequestData | null | undefined;
  const checkRuns = (context.collected["checkRuns"] as CheckRunResult[] | null | undefined) ?? [];
  const quality = context.collected["quality"] as CodeQualityReport | undefined;
  const security = context.collected["security"] as SecurityReport | undefined;
  const coverage = context.collected["coverage"] as TestCoverageReport | undefined;
  const risk = context.collected["risk"] as RiskAssessment | undefined;

  const failingChecks = checkRuns.filter((run) => run.conclusion === "failure");
  const lines: string[] = [];

  lines.push("### Summary");
  lines.push(
    pullRequest
      ? `**${pullRequest.title}** by @${pullRequest.user?.login ?? "unknown"} — ${pullRequest.changed_files} file(s), +${pullRequest.additions}/-${pullRequest.deletions} targeting \`${pullRequest.base.ref}\`.`
      : "PR metadata could not be retrieved; the review below is based on the available data only."
  );

  lines.push("", "### Core changes");
  if (quality && quality.filesChanged > 0) {
    lines.push(`Detected language: \`${quality.language}\` — quality score ${quality.score}/100.`);
    const notable = quality.findings.slice(0, 5);
    if (notable.length > 0) {
      for (const finding of notable) {
        lines.push(`- \`${finding.file}:${finding.line}\` — ${finding.message} (\`${finding.rule}\`)`);
      }
    } else {
      lines.push("- No lexical issue detected in the added lines.");
    }
  } else {
    lines.push("- The diff was not available, core changes could not be analysed.");
  }

  lines.push("", "### Security");
  if (security && security.findings.length > 0) {
    for (const finding of security.findings.slice(0, 5)) {
      lines.push(`- **${finding.severity}** \`${finding.file}:${finding.line}\` — ${finding.message}`);
    }
  } else {
    lines.push("- No security anti-pattern detected by the static heuristics.");
  }

  lines.push("", "### Merge readiness");
  lines.push(
    checkRuns.length === 0
      ? "- CI status unknown (no check run reported)."
      : failingChecks.length > 0
        ? `- Failing checks: ${failingChecks.map((run) => `\`${run.name}\``).join(", ")}.`
        : "- All reported checks are green."
  );
  if (risk) {
    lines.push(`- Risk level: **${risk.level}** (${risk.score}/100).`);
    for (const reason of risk.reasons) {
      lines.push(`  - ${reason}`);
    }
  }
  if (coverage) {
    lines.push(
      coverage.untestedFiles.length === 0
        ? "- Every changed source file has an associated test file."
        : `- Files without tests: ${coverage.untestedFiles.map((file) => `\`${file}\``).join(", ")}.`
    );
  }

  lines.push("", "### Possible improvements");
  const improvements = (quality?.findings ?? []).filter((finding) => finding.severity === "info" || finding.severity === "low");
  if (improvements.length === 0) {
    lines.push("- Nothing blocking; the change reads well.");
  } else {
    for (const finding of improvements.slice(0, 5)) {
      lines.push(`- nit: \`${finding.file}:${finding.line}\` — ${finding.message}`);
    }
  }

  lines.push("", "### Want me to…");
  lines.push("1. Draft inline comments for the findings above?");
  lines.push("2. Write the missing tests for the untested files?");
  lines.push("3. Summarise this pull request for the release notes?");

  const failures = context.results.filter((result) => !result.isSuccessful);
  if (failures.length > 0) {
    lines.push("", "> Some steps failed and were skipped:");
    for (const failure of failures) {
      lines.push(`> - \`${failure.stepName}\`: ${failure.error ?? "unknown error"}`);
    }
  }

  return lines.join("\n");
}

/** Builds an agent from the repository configuration. */
export async function createPullRequestReviewAgent(dryRun = true): Promise<PullRequestReviewAgent> {
  const config = await loadAgentConfig();
  const skillsDir = path.resolve(repoRoot, config.skillsPath);
  const instructionsDir = path.resolve(repoRoot, config.instructionsPath);
  const [skills, instructions] = await Promise.all([
    loadSkills(skillsDir, config.skillsToLoad),
    loadInstructions(instructionsDir)
  ]);

  return new PullRequestReviewAgent({ config, skills, instructions, dryRun });
}

function parseArguments(argv: string[]): { ref: PullRequestRef; dryRun: boolean } | null {
  const positional = argv.filter((argument) => !argument.startsWith("--"));
  const slug = positional[0];
  const pullNumber = Number(positional[1]);
  if (!slug || !slug.includes("/") || !Number.isInteger(pullNumber)) {
    return null;
  }
  const [owner = "", repo = ""] = slug.split("/");
  const dryRun = argv.includes("--dry-run") || process.env["GITHUB_TOKEN"] === undefined;
  return { ref: { owner, repo, pullNumber }, dryRun };
}

const isEntryPoint = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntryPoint) {
  const parsed = parseArguments(process.argv.slice(2));
  if (!parsed) {
    process.stderr.write("usage: node dist/agents/pr-review-agent.js <owner>/<repo> <pr_number> [--dry-run]\n");
    process.exitCode = 1;
  } else {
    const agent = await createPullRequestReviewAgent(parsed.dryRun);
    const result = await agent.run(parsed.ref);
    process.stdout.write(`${result.reviewBody}\n`);
    process.stderr.write(`[agent] state=${result.state} iterations=${result.iterations}\n`);
  }
}
