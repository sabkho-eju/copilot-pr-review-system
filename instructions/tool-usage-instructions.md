---
title: Tool usage instructions
priority: HIGH
when: Before every tool call.
why: Avoids malformed requests, rate-limit bans and unreadable comments.
targetAudience: pr-review-agent
---

# Tool usage instructions

## Mandatory parameters

| Tool | Required parameters |
| --- | --- |
| `github_get_pr` | `owner`, `repo`, `pr_number` |
| `github_get_pr_diff` | `owner`, `repo`, `pr_number` |
| `github_get_issue` | `owner`, `repo`, `issue_number` |
| `github_get_check_runs` | `owner`, `repo`, `pr_number` |
| `github_create_comment` | `owner`, `repo`, `pr_number`, `body` |
| `github_create_review` | `owner`, `repo`, `pr_number`, `review` |
| `get_file_content` | `owner`, `repo`, `path` (`ref` optional) |
| `get_file_history` | `owner`, `repo`, `path` |
| `compare_files` | `owner`, `repo`, `path`, `ref1`, `ref2` |
| `analyze_diff` | `diff` |
| `detect_security_issues` | `diff` |
| `analyze_test_coverage` | `diff` |
| `assess_risk_level` | `changes` |

## GitHub API defaults

- Header `X-GitHub-Api-Version: 2022-11-28` on every request.
- `Accept: application/vnd.github+json`, except for diffs which require
  `application/vnd.github.v3.diff`.
- Pagination: `per_page=30`, stop after `pagination.maxPages` pages.

## Rate limits

- Authenticated budget: 5000 requests/hour.
- When `x-ratelimit-remaining` drops below
  `rateLimit.minRemainingBeforeThrottle`, only issue calls required by the
  current step.
- On HTTP 429 or 403 with `retry-after`, wait for the advertised delay.

## Error shapes

Every tool returns:

```json
{ "success": false, "data": null, "error": "GitHub API responded 404 Not Found", "metadata": { "durationMs": 42 } }
```

Always check `success` before reading `data`.

## Comment format

```markdown
### Summary
…

### Core changes
- `tools/analysis-tools.ts:118` — …

### Merge readiness
**Changes requested** — the `build` check fails.
```

Keep the body under 65 000 characters; split into follow-up comments otherwise.

## Authentication

- The token is read from the `GITHUB_TOKEN` environment variable only.
- Required scopes: `repo` (private repositories) or `public_repo`.
- Never log the token, never embed it in a comment body or a commit.
