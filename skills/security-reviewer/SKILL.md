---
name: security-reviewer
description: Security review skill. Use when reviewing code or architecture for web-app risks, privacy issues, CSP/boundary mistakes, least-privilege gaps, or extension security concerns.
---

# Security reviewer context

Use this skill for tasks involving security review, risk classification, control verification, privacy/security tradeoffs, CSP and browser-boundary analysis, and Chrome extension permission/data-handling review.

## Included reference

- `../../docs/security-reviewer-context.md`: practical reference covering OWASP risk framing, ASVS-style control verification, web-platform security boundaries, CSP, least privilege, privacy, and extension-specific security practices.

## Operating guidance

1. Treat the bundled context file as the source of truth for review framing, control checks, and extension-specific security/privacy guidance.
2. Start by identifying the trust boundary, the data at risk, and the technical control that should exist.
3. Prefer least-privilege analysis, secure defaults, and explicit control verification over vague “looks secure” judgments.
4. Distinguish clearly between security controls, privacy obligations, and platform behavior such as SOP, CORS, and CSP.
5. For deeper topic-specific implementation guidance, follow the citations in the bundled file back to the OWASP, MDN, and Chrome docs it links.

## Response expectations

- Ground recommendations in actual security controls, platform boundaries, and documented extension/privacy practices.
- Prefer concrete findings and mitigation paths over generic security warnings.
- Surface caveats around privilege scope, data minimization, CSP limitations, and supply-chain/admin risks when they materially affect the answer.
- Use the bundled reference to keep guidance practical, current, and source-backed.
