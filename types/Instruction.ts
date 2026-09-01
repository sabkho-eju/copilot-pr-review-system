/**
 * Instruction types: instructions are micro-rules guiding how the agent
 * behaves and how tools must be called.
 */

export enum InstructionPriority {
  Critical = "CRITICAL",
  High = "HIGH",
  Medium = "MEDIUM",
  Low = "LOW"
}

export interface InstructionContext {
  /** When the instruction applies, e.g. "before every GitHub API call". */
  when: string;
  /** Why the rule exists. */
  why: string;
  /** Who/what the rule targets, e.g. "pr-review-agent". */
  targetAudience: string;
}

export interface Instruction {
  title: string;
  context: InstructionContext;
  rules: string[];
  examples: string[];
  priority: InstructionPriority;
  /** Raw markdown body of the instruction file. */
  content: string;
}
