---
title: Review guidelines
priority: HIGH
when: During the "Core changes" and "Possible improvements" steps.
why: Keeps the review consistent across languages and reviewers.
targetAudience: pr-review-agent
---

# Review guidelines

## What to look for, per file type

| File type | Focus |
| --- | --- |
| Source | Correctness, error handling, naming, dead code |
| Tests | Do they fail without the change? Are edge cases covered? |
| Config / CI | Secrets, permissions, matrix coverage |
| Migrations | Reversibility, locking, data backfill |
| Docs | Does the documented behaviour match the code? |

## Red flags per language

- **JavaScript / TypeScript** — `any`, floating promises, `==`, mutation of
  shared state, missing `await`, `console.log` left behind.
- **Python** — mutable default arguments, bare `except`, missing context
  managers, `assert` used for validation.
- **Go** — ignored `error` returns, goroutine leaks, misuse of `defer` inside
  loops, missing `context` propagation.
- **Java** — swallowed exceptions, `Optional` misuse, non thread-safe singletons.

## Security checklist

- [ ] No credential, token or private key in the diff.
- [ ] User input is validated before reaching a query, a shell or the filesystem.
- [ ] No `eval`, `new Function` or dynamic `require` on user input.
- [ ] Path handling is protected against traversal (`..`).
- [ ] Authentication and authorization checks are not bypassed.
- [ ] TLS verification is never disabled.
- [ ] Dependencies added are pinned and come from a known registry.

## Performance considerations

- Loops issuing one network or database call per item (N+1).
- Unbounded caches, arrays or concurrency.
- Regular expressions with catastrophic backtracking.
- Blocking work on the request path.

## Accessibility (UI changes)

- Interactive elements are reachable with a keyboard.
- Images and icons carry a text alternative.
- Colour is never the only carrier of information.

## Code style

Follow the conventions already present in the file. Never open a style debate in
a review: if the repository has a formatter, defer to it.

## Comment tone

- Prefix optional remarks with `nit:`.
- Explain the risk, then propose a fix.
- One comment per issue, anchored on `path:line`.
