---
name: pr-reviewer
version: 1.0.0
description: Six-step methodology to produce a complete, actionable pull request review.
dependencies:
  - pr-understanding
---

# Skill: PR Reviewer

Use this skill once `pr-understanding` has produced a factual picture of the pull
request. It turns that picture into a structured review comment.

## Step 1 — Summary

**Goal:** explain, in three sentences maximum, what the PR does and why.

Data points:

- PR title, description and linked issues
- Number of commits, files changed, additions/deletions
- Target branch and release impact

**Output:** a short paragraph a reviewer can read in 15 seconds.

## Step 2 — Core changes

**Goal:** describe the changes that carry the intent of the PR.

Data points:

- Files with the highest churn (`analyze_diff` findings ordered by severity)
- New or modified public APIs, exported symbols, database schemas
- Behavioural changes visible to users

**Output:** one bullet per meaningful change, each linking to `path:line`.

## Step 3 — Other changes

**Goal:** acknowledge the rest without drowning the reader.

Data points:

- Renames, formatting, dependency bumps, generated files
- Test-only or documentation-only files

**Output:** a compact list, grouped by category.

## Step 4 — Merge readiness

**Goal:** state whether the PR can be merged as is.

Data points:

- `github_get_check_runs`: failing, pending or successful checks
- `assess_risk_level`: low / medium / high with reasons
- `analyze_test_coverage`: changed source files without tests

**Output:** a verdict (`ready`, `ready with nits`, `changes requested`) plus the
blocking items, if any.

## Step 5 — Possible improvements

**Goal:** offer optional, concrete suggestions.

Data points:

- Quality findings that are not blocking (`no-console`, `no-any`, long functions)
- Duplication or missing abstractions spotted while reading the diff
- Performance or accessibility remarks

**Output:** at most five suggestions, each with a rationale.

## Step 6 — Want me to…

**Goal:** propose the next actions.

**Output:** exactly three offers, for example:

1. Write the missing unit tests for `tools/analysis-tools.ts`.
2. Draft inline comments for the security findings.
3. Summarise the PR for the release notes.

## Evaluation criteria

| Criterion | Pass condition |
| --- | --- |
| Accuracy | Every claim maps to a file, line or check run |
| Actionability | Each blocking item states what to change |
| Concision | The review fits on one screen |
| Tone | Descriptive, never judgemental |

## Success metrics

- No factual error reported by the PR author.
- Blocking items are fixed in the next push.
- The review is produced in fewer than `maxIterations` agent iterations.
