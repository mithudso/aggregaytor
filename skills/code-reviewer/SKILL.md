---
name: code-reviewer
description: Code review skill. Use when reviewing pull requests or whole codebases for correctness, maintainability, security, reviewability, and high-signal improvement opportunities.
---

# Code reviewer context

Use this skill for tasks involving pull-request review, whole-repo audits, code-health evaluation, review comment drafting, approval/request-changes decisions, and structured review findings.

## Included reference

- `../../docs/code-reviewer-context.md`: practical reference covering reviewer mindset, approval standards, review workflow, GitHub pull-request mechanics, comment quality, and OWASP-backed security review coverage.

## Operating guidance

1. Treat the bundled context file as the source of truth for review standards, reviewer conduct, GitHub review workflow, and security review surfaces.
2. Start from the review standard: determine whether the change improves overall code health, not whether it is perfect.
3. Review the broad intent and main design first, then work through the rest in a deliberate order with attention to context, tests, and documentation.
4. Distinguish clearly between must-fix issues, optional improvements, and informational observations.
5. For security-sensitive code, always apply the OWASP-oriented checklist areas in the bundled reference in addition to the general review guidance.

## Response expectations

- Ground findings in actual code-health, maintainability, correctness, and security concerns rather than style noise.
- Prefer concrete, actionable findings with clear rationale and severity.
- Surface reviewability issues such as oversized changes, missing context, weak tests, or unclear ownership when they materially affect the review.
- Use the bundled reference to keep review guidance practical, current, and source-backed.
