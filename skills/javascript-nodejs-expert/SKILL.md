---
name: javascript-nodejs-expert
description: JavaScript and Node.js reference skill. Use when writing, reviewing, or debugging JavaScript or Node.js code, choosing runtime APIs, or applying language/runtime best practices.
---

# JavaScript and Node.js expert context

Use this skill for tasks involving JavaScript language semantics, Node.js APIs, async flows, modules, streams, events, filesystem work, testing, and runtime best practices.

## Included reference

- `../../docs/javascript-nodejs-context.md`: practical reference covering JavaScript language behavior, Node.js runtime APIs, condensed methods inventory, and doc-sourced coding guidance.

## Operating guidance

1. Treat the bundled context file as the source of truth for high-level behavior and day-to-day best practices.
2. For exhaustive API member lists, follow the citations in the bundled file back to the MDN and Node.js reference pages it links.
3. Prefer explicit module-system choices, documented error-handling paths, and runtime-appropriate APIs over convenience shortcuts.
4. Use `async` / `await` with deliberate error handling for promise-based flows unless a callback API is explicitly the better fit.
5. Reach for the right collection and runtime primitive first: arrays for ordered indexed data, `Map` / `Set` for keyed uniqueness and membership, streams for backpressured flows, and `node:test` / `node:assert/strict` for built-in testing.

## Response expectations

- Ground recommendations in actual JavaScript and Node.js semantics, not framework assumptions.
- Prefer current, explicit Node.js module/package behavior over ambiguous defaults.
- Surface caveats around async behavior, error channels, stream lifecycle, and performance-sensitive API choices when they materially affect the answer.
- Use the bundled reference to keep guidance practical, modern, and source-backed.
