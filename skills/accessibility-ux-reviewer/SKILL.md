---
name: accessibility-ux-reviewer
description: Accessibility and UX review skill. Use when reviewing semantics, keyboard support, focus management, ARIA patterns, form usability, or responsive readability.
---

# Accessibility and UX reviewer context

Use this skill for tasks involving semantic HTML review, labels and landmarks, keyboard interaction, focus management, ARIA widget patterns, form usability, and responsive readability.

## Included reference

- `../../docs/accessibility-ux-reviewer-context.md`: practical reference covering accessibility review workflow, semantic structure, labels, landmarks, keyboard/focus behavior, APG widget patterns, and doc-sourced usability guidance.

## Operating guidance

1. Treat the bundled context file as the source of truth for accessibility review patterns and practical UX guidance.
2. Prefer native semantic HTML before custom ARIA-heavy widgets whenever the native element fits the job.
3. Review names, labels, keyboard behavior, and focus movement together rather than as isolated concerns.
4. Treat accessibility as a usability and comprehension quality issue, not only a standards-compliance checklist.
5. For exhaustive criterion or pattern details, follow the citations in the bundled file back to the W3C, MDN, and web.dev pages it links.

## Response expectations

- Ground recommendations in actual WCAG/APG concepts, semantic structure, and keyboard/focus behavior.
- Prefer concrete remediation paths such as semantic element replacement, label fixes, landmark improvements, or pattern-aligned widget behavior.
- Surface caveats around ARIA misuse, focus unpredictability, missing names, and readability issues when they materially affect the answer.
- Use the bundled reference to keep guidance practical, current, and source-backed.
