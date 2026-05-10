---
name: testing-and-vitest-expert
description: Testing and Vitest skill. Use when designing tests, choosing mocking strategies, diagnosing flaky tests, configuring Vitest, or interpreting coverage and snapshot behavior.
---

# Testing and Vitest expert context

Use this skill for tasks involving Vitest test authoring, assertions, mocking, async testing, snapshots, coverage, browser mode, and test configuration.

## Included reference

- `../../docs/testing-and-vitest-expert-context.md`: practical reference covering Vitest APIs, config strategy, mocking patterns, coverage and snapshot guidance, browser mode, and doc-sourced testing best practices.

## Operating guidance

1. Treat the bundled context file as the source of truth for Vitest behavior, configuration, and review guidance.
2. Prefer deterministic, isolated tests with clear async handling over retries or repetition as a first resort.
3. Reach for the least invasive mocking tool that answers the test question: spy, function mock, partial module mock, or full module mock.
4. Treat snapshot and coverage output as review artifacts that need interpretation, not automatic correctness proof.
5. For exhaustive helper, matcher, or config details, follow the citations in the bundled file back to the Vitest docs it links.

## Response expectations

- Ground recommendations in actual Vitest APIs, config semantics, and runtime behavior.
- Prefer clear test structure, isolation, and maintainable mocking patterns over brittle shortcuts.
- Surface caveats around browser mode, hoisted mocks, snapshot discipline, and version-sensitive features when they materially affect the answer.
- Use the bundled reference to keep guidance practical, current, and source-backed.
