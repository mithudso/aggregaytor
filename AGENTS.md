# AGENTS.md — repo-local agent & skill assets

This repository ships its own Claude Code skills under `skills/`. Each skill is a
directory containing a `SKILL.md` (frontmatter: `name`, `description`). Several
skills have a longer companion context file under `docs/*-context.md` (the
`chrome-dev-context` companion lives at the repo root as `chrome-dev-context.md`).

Start with `CLAUDE.md` and `docs/ARCHITECTURE.md` for orientation; the skills
below are specialist lenses layered on top.

## Skill catalog

| Name | Scope | When to use |
|------|-------|-------------|
| `accessibility-ux-reviewer` | A11y / UX review | Reviewing semantics, keyboard support, focus management, ARIA patterns, form usability, responsive readability |
| `chrome-dev-context` | Chrome MV3 + DevTools MCP | Working on Chrome extensions, choosing `chrome.*` APIs, debugging MV3 context boundaries, automating Chrome with DevTools MCP |
| `code-reviewer` | Code review | Reviewing PRs or whole codebases for correctness, maintainability, security, reviewability |
| `html-css-expert` | HTML/CSS reference | Authoring or reviewing markup and styles, semantic elements, cascade and layout best practices |
| `javascript-nodejs-expert` | JS / Node.js reference | Writing, reviewing, or debugging JavaScript/Node.js, choosing runtime APIs |
| `mongodb-expert` | MongoDB reference | Designing schemas, writing queries/aggregations, choosing indexes, data-modeling and transactions |
| `mongodb-performance-troubleshooting-expert` | MongoDB performance | Diagnosing slow queries, explain plans, index usage, lock contention, profiler output, Atlas perf tooling |
| `performance-profiling-expert` | Performance profiling | Diagnosing load/runtime slowness, Lighthouse/PageSpeed output, browser traces, Node.js bottlenecks |
| `security-reviewer` | Security review | Reviewing code or architecture for web-app risks, privacy issues, CSP/boundary mistakes, least-privilege gaps, extension security |
| `software-architect` | Architecture | Designing or reviewing system structure, boundaries, architecture docs, quality-attribute tradeoffs, ADRs |
| `testing-and-vitest-expert` | Testing / Vitest | Designing tests, mocking strategies, flaky tests, Vitest config, coverage and snapshots |
| `typescript-expert` | TypeScript reference | Designing types, reviewing public APIs, compiler options, type-safety best practices |

## Companion context files

Deep-dive companions for the skills above live in `docs/`:

- `docs/accessibility-ux-reviewer-context.md`
- `docs/code-reviewer-context.md`
- `docs/html-css-context.md`
- `docs/javascript-nodejs-context.md`
- `docs/mongodb-expert-context.md`
- `docs/mongodb-performance-troubleshooting-context.md`
- `docs/performance-profiling-expert-context.md`
- `docs/security-reviewer-context.md`
- `docs/software-architect-context.md`
- `docs/testing-and-vitest-expert-context.md`
- `docs/typescript-expert-context.md`
- `chrome-dev-context.md` (repo root) — companion for `chrome-dev-context`

## Conventions for agents

- Commands, invariants, and gotchas: see `CLAUDE.md` (canonical) and
  `.github/copilot-instructions.md` (Copilot mirror).
- Workflow logging: append prompts to `prompts.md`, keep `memory.md` current,
  bump the patch version in `extensions/aggregaytor/manifest.json` on every
  change — see "Workflow log rule" in `CLAUDE.md`.
