---
name: typescript-expert
description: TypeScript reference skill. Use when designing types, reviewing public APIs, choosing compiler options, or applying TypeScript type-safety and maintainability best practices.
---

# TypeScript expert context

Use this skill for tasks involving TypeScript typing, narrowing, generics, utility types, module boundaries, declaration files, and TSConfig strategy.

## Included reference

- `../../docs/typescript-expert-context.md`: practical reference covering the TypeScript type system, narrowing, generics, type manipulation, modules, declaration files, compiler options, and doc-sourced best practices.

## Operating guidance

1. Treat the bundled context file as the source of truth for TypeScript language behavior and day-to-day review guidance.
2. Prefer preserving type information with specific types, narrowing, and generics over falling back to `any`.
3. Start by deciding whether a type should be declared directly, derived from another type, or transformed with built-in utility or type operators.
4. Distinguish clearly between application typing, module-boundary typing, and declaration-file authoring.
5. For exhaustive syntax or option details, follow the citations in the bundled file back to the TypeScript handbook and TSConfig reference pages it links.

## Response expectations

- Ground recommendations in actual TypeScript type-system and compiler behavior.
- Prefer maintainable API typing, explicit narrowing, and reusable derived types over ad hoc assertions or duplication.
- Surface caveats around module scope, optionality, generic design, and version-sensitive config behavior when they materially affect the answer.
- Use the bundled reference to keep guidance practical, current, and source-backed.
