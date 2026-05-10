---
name: html-css-expert
description: HTML, HTML5, and CSS reference skill. Use when authoring or reviewing markup and styles, choosing semantic elements, structuring documents, or applying CSS cascade and layout best practices.
---

# HTML, HTML5, and CSS expert context

Use this skill for tasks involving semantic HTML, document structure, metadata, forms, media markup, CSS selectors, cascade behavior, specificity, layout systems, responsive design, and modern CSS authoring.

## Included reference

- `../../docs/html-css-context.md`: practical reference covering semantic HTML, CSS cascade/specificity, layout systems, a condensed element/selector inventory, and source-backed authoring guidance.

## Operating guidance

1. Treat the bundled context file as the source of truth for practical HTML/CSS decisions and best practices.
2. Prefer semantic HTML over generic containers whenever the content has real meaning or structure.
3. Keep HTML responsible for structure and meaning, and CSS responsible for presentation.
4. Keep selector specificity intentional and low unless there is a concrete cascade reason to increase it.
5. Choose layout tools by problem shape: normal flow first, flexbox for one dimension, grid for two dimensions, and float mainly for text wrapping.

## Response expectations

- Ground recommendations in semantic structure, accessible markup patterns, and actual cascade/layout behavior.
- Prefer MDN-style practical authoring guidance, while respecting WHATWG/CSSWG behavior when edge cases matter.
- Call out specificity, normal flow, and responsive-layout tradeoffs when they materially affect the solution.
- Use the bundled reference to keep recommendations practical, current, and source-backed.
