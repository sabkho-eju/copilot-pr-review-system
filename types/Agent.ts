/**
 * Core agent types: an agent is the autonomous orchestrator that loads skills,
 * follows instructions and calls tools until an objective is reached.
 */
import type { Skill, SkillResult } from "./Skill.js";
import type { Tool, ToolResult } from "./Tool.js";
import type { Instruction } from "./Instruction.js";

export enum AgentState {
  Initializing = "initializing",
  Analyzing = "analyzing",
  Reviewing = "reviewing",
  Deciding = "deciding",
  Complete = "complete",
  Failed = "failed"
}

export interface AgentConfig {
  agentName: string;
  modelId: string;
  skillsToLoad: string[];
  toolsAvailable: string[];
  instructionsPath: string;
  skillsPath: string;
  maxIterations: number;
}

export interface PullRequestRef {
  owner: string;
  repo: string;
  pullNumber: number;
}

export interface AgentContext {
  pullRequest: PullRequestRef;
  /** Raw data collected by tools, keyed by step or tool name. */
  collected: Record<string, unknown>;
  /** Results of the skill steps executed so far. */
  results: SkillResult[];
  iteration: number;
  state: AgentState;
}

export interface AgentDecision {
  action: "call_tool" | "run_step" | "finish";
  toolToCall?: string;
  params?: Record<string, unknown>;
  reasoning: string;
}

export interface AgentRunResult {
  state: AgentState;
  reviewBody: string;
  results: SkillResult[];
  iterations: number;
}

export interface Agent {
  readonly name: string;
  readonly modelId: string;
  readonly skills: Skill[];
  readonly tools: Tool[];
  readonly instructions: Instruction[];
  run(pullRequest: PullRequestRef): Promise<AgentRunResult>;
}

/** Convenience alias used by orchestration code handling heterogeneous outputs. */
export type AnyToolResult = ToolResult<unknown>;
