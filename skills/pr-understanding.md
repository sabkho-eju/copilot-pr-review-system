---
name: pr-understanding
version: 1.0.0
description: How to build a factual, deep understanding of a pull request before reviewing it.
dependencies: []
---

# Skill: PR Understanding

This skill is loaded **before** `pr-reviewer`. It only gathers facts; it never
formulates an opinion.

## Step 1 — Collect metadata

Call `github_get_pr` and record:

- title, body, author, draft state
- base and head refs (and their SHAs)
- additions, deletions, changed files count

If the body references `#123`, call `github_get_issue` to load the intent behind
the change.

## Step 2 — Read the diff

Call `github_get_pr_diff` and split the result per file. For each file, classify
it as:

- **core** — implements the intent of the PR
- **support** — types, configuration, wiring
- **noise** — formatting, generated files, lockfiles

## Step 3 — Explore dependencies

For every core file, use `get_file_content` on the base ref to understand the
previous behaviour, and `get_file_history` when the change touches code with a
history of regressions. Use `compare_files` when the unified diff hides context.

## Step 4 — Map the connections

Build a small mental graph:

- which modules import the changed symbols
- which tests exercise them
- which configuration keys they read

## Step 5 — Check the signals

Call `github_get_check_runs` and note which checks are failing, pending or
skipped. A failing lint job changes what is worth commenting on.

## Output contract

The skill produces a JSON-like context consumed by `pr-reviewer`:

```json
{
  "intent": "why the PR exists",
  "coreFiles": ["src/a.ts"],
  "supportFiles": ["types/A.ts"],
  "noiseFiles": ["package-lock.json"],
  "openQuestions": ["is the migration reversible?"],
  "checks": { "failing": [], "pending": [] }
}
```

## Stop conditions

- All core files have been read at both refs, **or**
- the iteration budget from `config/agent-config.json` is exhausted.
