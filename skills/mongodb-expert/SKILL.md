---
name: mongodb-expert
description: MongoDB reference skill. Use when designing schemas, writing queries or aggregations, choosing indexes, or applying MongoDB data-modeling and transaction best practices.
---

# MongoDB expert context

Use this skill for tasks involving MongoDB document modeling, CRUD operations, MQL predicates and updates, aggregation pipelines, index strategy, write semantics, and transaction-aware design.

## Included reference

- `../../docs/mongodb-expert-context.md`: practical reference covering MongoDB document modeling, CRUD and MQL behavior, aggregation, index guidance, and doc-sourced best practices.

## Operating guidance

1. Treat the bundled context file as the source of truth for MongoDB-specific behavior and day-to-day design guidance.
2. Start with access patterns and document boundaries before proposing indexes, joins, or transactions.
3. Prefer single-document designs and embedding where they satisfy the read/write pattern cleanly; reach for transactions when requirements truly cross document boundaries.
4. Distinguish clearly between driver-level application guidance and mongosh/admin examples.
5. For exhaustive operators, methods, or command details, follow the citations in the bundled file back to the MongoDB Manual and reference pages it links.

## Response expectations

- Ground recommendations in actual MongoDB document-model, query, aggregation, and index behavior.
- Prefer practical schema and query advice tied to access patterns, write semantics, and performance tradeoffs.
- Call out caveats around transaction need, concurrent updates, and read-vs-write index costs when they materially affect the answer.
- Use the bundled reference to keep guidance practical, current, and source-backed.
