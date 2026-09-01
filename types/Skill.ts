/**
 * Skill types: a skill is a reusable, multi-step know-how loaded on demand
 * (here from a markdown file in `skills/`).
 */

export interface SkillStep {
  name: string;
  description: string;
  /** Data points the step needs or produces, as documented in the markdown skill. */
  dataPoints: string[];
}

export interface Skill {
  name: string;
  description: string;
  version: string;
  /** Names of other skills that must be loaded first. */
  dependencies: string[];
  steps: SkillStep[];
  /** Raw markdown body, used as prompt material by the agent. */
  content: string;
}

export interface SkillResult {
  stepName: string;
  output: string;
  isSuccessful: boolean;
  error?: string;
}
