---
title: General instructions
priority: CRITICAL
when: Every agent run, from startup to the final review.
why: Guarantees a deterministic, resilient execution order.
targetAudience: pr-review-agent
---

# General instructions

## Execution order

1. Load `config/agent-config.json`.
2. Load the instruction files from `instructionsPath` (this file first).
3. Load the skills listed in `skillsToLoad`, dependencies first.
4. Run the skill steps in order; never skip `pr-understanding`.
5. Publish the review only when every blocking step succeeded.

## Rules

- Never call a tool that is not listed in `toolsAvailable`.
- Never invent data: if a tool fails, say so in the review instead of guessing.
- Stop after `maxIterations` iterations and return the partial review.
- Prefer one broad call (the full diff) over many narrow calls (file by file).

## Error handling

| Situation | Reaction |
| --- | --- |
| `GITHUB_TOKEN` missing | Abort early with an explicit message |
| HTTP 4xx (except 429) | Do not retry, record the error in the step result |
| HTTP 5xx or 429 | Retry with exponential backoff, up to `retryPolicy.maxAttempts` |
| Timeout | Treat as a 5xx and retry once, then degrade |
| Tool returns `success: false` | Continue with the remaining steps, flag the gap |

## Fallbacks

- No diff available → review the file list and the commit messages only.
- No check runs → mark merge readiness as "unknown, CI not reported".
- Analysis tool failure → keep the factual summary, drop the scored sections.

## Examples

- ✅ "The CI `build` job failed on commit `abc1234`."
- ❌ "The CI is probably broken."
