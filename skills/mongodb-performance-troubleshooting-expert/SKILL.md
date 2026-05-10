---
name: mongodb-performance-troubleshooting-expert
description: MongoDB performance and troubleshooting skill. Use when diagnosing slow queries, explain plans, index usage, lock contention, profiler output, or Atlas performance tooling.
---

# MongoDB performance and troubleshooting context

Use this skill for tasks involving MongoDB latency investigation, query-plan analysis, index-use debugging, profiler interpretation, lock/concurrency diagnosis, server health inspection, and Atlas performance tooling.

## Included reference

- `../../docs/mongodb-performance-troubleshooting-context.md`: practical reference covering MongoDB performance investigation workflow, explain/plan-cache behavior, index analysis, profiling, runtime diagnostics, and doc-sourced troubleshooting guidance.

## Operating guidance

1. Start by classifying the problem: query shape, index mismatch, schema design, lock contention, connection pressure, or capacity issue.
2. Prefer the least invasive diagnostic surface that answers the question: explain first, targeted metrics next, profiler last when necessary.
3. Treat `explain` results, plan-cache behavior, and runtime metrics as related but distinct signals; do not conflate them.
4. Distinguish Atlas-native tools from self-hosted/server-command workflows, and note availability constraints when they matter.
5. For exhaustive command or stage details, follow the citations in the bundled file back to the MongoDB and Atlas reference pages it links.

## Response expectations

- Ground recommendations in actual MongoDB diagnostic surfaces such as explain, `$indexStats`, profiler data, `serverStatus`, and `$currentOp`.
- Prefer practical triage sequences and clear hypotheses over generic “optimize indexes” advice.
- Surface caveats around profiler overhead, plan-cache interpretation, version-sensitive explain output, and Atlas feature availability when they materially affect the answer.
- Use the bundled reference to keep troubleshooting guidance practical, current, and source-backed.
