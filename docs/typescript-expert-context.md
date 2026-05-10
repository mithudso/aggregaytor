# TypeScript expert context

## How to use this context

Use this file as a **practical TypeScript reference** when designing types, reviewing APIs, tightening compiler settings, or debugging type errors. Treat the official **TypeScript Handbook** and **TSConfig reference** as the source of truth for language behavior, type-system features, declaration authoring, module rules, and compiler-option tradeoffs ([TypeScript intro](https://www.typescriptlang.org/docs/handbook/intro.html), [TSConfig reference](https://www.typescriptlang.org/tsconfig/)).

**Version note:** this file is based on the current rolling TypeScript documentation published on `typescriptlang.org` as accessed on **2026-05-10**; the “Creating Types from Types” page was last updated **2026-05-04**, which indicates the docs set is current rather than pinned to a legacy handbook edition ([Creating Types from Types](https://www.typescriptlang.org/docs/handbook/2/types-from-types.html)).

## Source scope

- **Language overview and motivation:** Handbook intro and docs home ([TypeScript intro](https://www.typescriptlang.org/docs/handbook/intro.html), [TypeScript docs](https://www.typescriptlang.org/docs/)).
- **Core language and type-system behavior:** everyday types, functions, objects, narrowing, generics, and type-manipulation docs ([Everyday Types](https://www.typescriptlang.org/docs/handbook/2/everyday-types.html), [More on Functions](https://www.typescriptlang.org/docs/handbook/2/functions.html), [More on Objects](https://www.typescriptlang.org/docs/handbook/2/objects.html), [Narrowing](https://www.typescriptlang.org/docs/handbook/2/narrowing.html), [Generics](https://www.typescriptlang.org/docs/handbook/2/generics.html), [Creating Types from Types](https://www.typescriptlang.org/docs/handbook/2/types-from-types.html)).
- **Reusable built-in helpers:** utility types reference ([Utility Types](https://www.typescriptlang.org/docs/handbook/utility-types.html)).
- **Code organization and interop:** modules and declaration files intro ([Modules](https://www.typescriptlang.org/docs/handbook/2/modules.html), [Declaration Files intro](https://www.typescriptlang.org/docs/handbook/declaration-files/introduction.html)).
- **Compiler and project strategy:** TSConfig reference ([TSConfig reference](https://www.typescriptlang.org/tsconfig/)).

## Quick rules

1. Prefer **specific types over `any`**; the Handbook explicitly frames TypeScript as a static typechecker meant to catch common type errors before runtime ([TypeScript intro](https://www.typescriptlang.org/docs/handbook/intro.html), [Everyday Types](https://www.typescriptlang.org/docs/handbook/2/everyday-types.html)).
2. Use primitive type names like **`string`**, **`number`**, and **`boolean`**, not boxed object types like `String` or `Number` ([Everyday Types](https://www.typescriptlang.org/docs/handbook/2/everyday-types.html)).
3. Narrow unions with **runtime checks** such as `typeof`, equality checks, truthiness checks, or other control-flow-supported guards before using member-specific operations ([Narrowing](https://www.typescriptlang.org/docs/handbook/2/narrowing.html)).
4. Prefer **generics** when the input and output types are related; using `any` throws away that relationship ([Generics](https://www.typescriptlang.org/docs/handbook/2/generics.html)).
5. Reuse and derive types with **`keyof`**, `typeof`, indexed access, conditional types, mapped types, and template literal types instead of duplicating shapes by hand ([Creating Types from Types](https://www.typescriptlang.org/docs/handbook/2/types-from-types.html)).
6. Treat modules deliberately: any file with a top-level `import` or `export` is a module; files without them are scripts in shared global scope unless you force module treatment ([Modules](https://www.typescriptlang.org/docs/handbook/2/modules.html)).
7. Use declaration files when typing libraries or packages without built-in types, and follow the declaration-file structure guidance instead of ad hoc `.d.ts` authoring ([Declaration Files intro](https://www.typescriptlang.org/docs/handbook/declaration-files/introduction.html)).
8. Prefer maintainable TSConfig choices that make issues explicit, such as strictness, strict mode emission, and unreachable-code detection when appropriate ([TSConfig reference](https://www.typescriptlang.org/tsconfig/)).

## What TypeScript is optimizing for

- TypeScript’s stated goal is to be a **static typechecker for JavaScript programs**, catching common type mistakes before runtime ([TypeScript intro](https://www.typescriptlang.org/docs/handbook/intro.html)).
- The Handbook frames type errors as arising from wrong assumptions about runtime behavior, API surfaces, or simple typos, so the practical value of TypeScript is in making those assumptions explicit and checkable ([TypeScript intro](https://www.typescriptlang.org/docs/handbook/intro.html)).

## Core type-system model

### Everyday types

- The core primitive types are `string`, `number`, and `boolean`, and TypeScript also models arrays via both `T[]` and `Array<T>` syntax ([Everyday Types](https://www.typescriptlang.org/docs/handbook/2/everyday-types.html)).
- `any` exists as an escape hatch, but using it means TypeScript stops checking that part of the program accurately, so it should be treated as a deliberate loosening of guarantees rather than a neutral default ([Everyday Types](https://www.typescriptlang.org/docs/handbook/2/everyday-types.html)).

### Object, interface, and alias modeling

- TypeScript represents grouped data through **object types**, which can be anonymous, named by `interface`, or named by `type` alias ([More on Objects](https://www.typescriptlang.org/docs/handbook/2/objects.html)).
- Object properties can be optional and can also carry write-related modifiers such as `readonly`, so object modeling is not just about shapes but also mutability expectations ([More on Objects](https://www.typescriptlang.org/docs/handbook/2/objects.html)).

### Functions and callable types

- Functions can be described through **function type expressions**, call signatures, construct signatures, and generic functions, depending on whether you only need callability or a callable value with properties/overloads ([More on Functions](https://www.typescriptlang.org/docs/handbook/2/functions.html)).
- Function parameter names matter in function type expressions: `(a: string) => void` is a function with a parameter named `a`, while `(string) => void` means a parameter literally named `string` with implicit `any` ([More on Functions](https://www.typescriptlang.org/docs/handbook/2/functions.html)).

## Control-flow analysis and narrowing

- TypeScript narrows union types based on reachable control flow; the docs demonstrate `typeof` checks as a foundational narrowing tool ([Narrowing](https://www.typescriptlang.org/docs/handbook/2/narrowing.html)).
- The important practical pattern is: if a value is a union, do the runtime check that proves which branch you are in, then let control-flow analysis carry the narrower type forward ([Narrowing](https://www.typescriptlang.org/docs/handbook/2/narrowing.html)).
- This makes narrowing both a **type-safety tool** and a **code-structure tool**: write runtime checks that reflect real program invariants, and the type system becomes more precise automatically ([Narrowing](https://www.typescriptlang.org/docs/handbook/2/narrowing.html)).

## Generics and reusable APIs

- Generics are the main TypeScript mechanism for building reusable components that preserve relationships between inputs and outputs ([Generics](https://www.typescriptlang.org/docs/handbook/2/generics.html)).
- The handbook’s identity-function example explicitly contrasts a generic function with the `any` version: generics preserve the type information while `any` discards it ([Generics](https://www.typescriptlang.org/docs/handbook/2/generics.html)).
- A good generic API captures the information the caller already has and returns that information with as little widening or loss as possible ([Generics](https://www.typescriptlang.org/docs/handbook/2/generics.html)).

## Creating types from types

- TypeScript’s type system is explicitly designed to express types **in terms of other types** using type operators and value-derived types ([Creating Types from Types](https://www.typescriptlang.org/docs/handbook/2/types-from-types.html)).
- The core “type manipulation” toolkit includes **generics, `keyof`, `typeof`, indexed access types, conditional types, mapped types, and template literal types** ([Creating Types from Types](https://www.typescriptlang.org/docs/handbook/2/types-from-types.html)).
- This means maintainable TypeScript often comes from deriving types instead of hand-copying shapes across APIs ([Creating Types from Types](https://www.typescriptlang.org/docs/handbook/2/types-from-types.html)).

## Modules, declaration files, and interop

### Modules

- TypeScript now centers practical module guidance on **ES Modules**, while still documenting CommonJS because it remains common in the ecosystem ([Modules](https://www.typescriptlang.org/docs/handbook/2/modules.html)).
- A file with top-level `import` or `export` is a module; without them, it is treated as a script whose declarations live in shared global scope ([Modules](https://www.typescriptlang.org/docs/handbook/2/modules.html)).
- This distinction matters for correctness: accidentally leaving a file as a script can leak names globally and create confusing cross-file interactions ([Modules](https://www.typescriptlang.org/docs/handbook/2/modules.html)).

### Declaration files

- The declaration-files section is explicitly about writing **high-quality `.d.ts` files** and assumes familiarity with basic TypeScript language concepts first ([Declaration Files intro](https://www.typescriptlang.org/docs/handbook/declaration-files/introduction.html)).
- The docs call out typing npm packages without built-in types as the most common reason to learn declaration-file authoring ([Declaration Files intro](https://www.typescriptlang.org/docs/handbook/declaration-files/introduction.html)).
- The declaration docs include templates, library-structure guidance, examples, and do’s/don’ts, which means declaration-file work should follow those patterns instead of improvised local conventions ([Declaration Files intro](https://www.typescriptlang.org/docs/handbook/declaration-files/introduction.html)).

## Utility types

- TypeScript provides globally available **utility types** for common type transformations ([Utility Types](https://www.typescriptlang.org/docs/handbook/utility-types.html)).
- Utilities like `Partial`, `Required`, `Readonly`, `Pick`, `Omit`, `Record`, `Exclude`, `Extract`, `NonNullable`, `Parameters`, `ReturnType`, and `Awaited` exist so common transformations stay readable and standardized rather than becoming bespoke mapped-type code every time ([Utility Types](https://www.typescriptlang.org/docs/handbook/utility-types.html)).

## TSConfig strategy

- The TSConfig reference is the main index for compiler options that shape type checking, module behavior, emit behavior, and project ergonomics ([TSConfig reference](https://www.typescriptlang.org/tsconfig/)).
- Options like `allowUnreachableCode`, `allowUnusedLabels`, and `alwaysStrict` demonstrate that TypeScript configuration is not only about syntax targets and modules, but also about enforcing maintainability and catching suspicious code patterns ([TSConfig reference](https://www.typescriptlang.org/tsconfig/)).
- The best practical reading of TSConfig is “policy for the codebase”: it encodes how strict, explicit, and interoperable you want the project to be ([TSConfig reference](https://www.typescriptlang.org/tsconfig/)).

## Language features, utilities, and config APIs inventory

This is a **condensed high-value inventory**, not an exhaustive dump of every handbook page or compiler option.

| Feature / API | Purpose | Key syntax / parameters | Effect on checking or emit | Typical usage | Caveats / tradeoffs |
|---|---|---|---|---|---|
| `string`, `number`, `boolean` | Core primitive typing ([Everyday Types](https://www.typescriptlang.org/docs/handbook/2/everyday-types.html)) | primitive type annotations | Basic static checking of common JS values | Ordinary value and parameter typing | Use lowercase primitives, not boxed object types |
| `T[]` / `Array<T>` | Array typing ([Everyday Types](https://www.typescriptlang.org/docs/handbook/2/everyday-types.html)) | `number[]`, `Array<string>` | Enforces element shape | Collections with consistent item types | `T[]` and `Array<T>` are equivalent in meaning |
| `any` | Escape hatch from strict checking ([Everyday Types](https://www.typescriptlang.org/docs/handbook/2/everyday-types.html)) | `any` | Disables meaningful checking for that value path | Interop, gradual migration, intentionally dynamic surfaces | Loses safety and information propagation |
| Function type expression | Describe callable shapes ([More on Functions](https://www.typescriptlang.org/docs/handbook/2/functions.html)) | `(a: string) => void` | Checks parameter and return compatibility | Callback and function-parameter typing | Parameter name is required syntactically |
| Call signature | Describe callable values with properties ([More on Functions](https://www.typescriptlang.org/docs/handbook/2/functions.html)) | object type with call signature | Models richer function objects | Functions that also carry metadata | More verbose than simple function type expressions |
| Object type / `interface` / `type` alias | Describe structured data ([More on Objects](https://www.typescriptlang.org/docs/handbook/2/objects.html)) | object literal type, `interface`, `type` alias | Checks object shape and members | Public contracts and data models | Choose reuse and clarity over style tribalism |
| Optional property `?` | Model partial presence of properties ([More on Objects](https://www.typescriptlang.org/docs/handbook/2/objects.html)) | `prop?: T` | Allows property omission | Config objects and partially supplied input | Callers and consumers must handle absence |
| Narrowing via `typeof` / control flow | Refine unions based on runtime checks ([Narrowing](https://www.typescriptlang.org/docs/handbook/2/narrowing.html)) | `typeof x === "number"` and similar | Narrows type in reachable branch | Safe union handling | Requires real runtime checks, not wishful assumptions |
| Generic type parameter | Preserve type relationships ([Generics](https://www.typescriptlang.org/docs/handbook/2/generics.html)) | `<T>`, `<Type>` | Keeps input/output linked | Reusable library and helper APIs | Overuse can make APIs harder to read |
| `keyof` | Build union of property names ([Creating Types from Types](https://www.typescriptlang.org/docs/handbook/2/types-from-types.html)) | `keyof T` | Enables property-driven typing | Reuse keys from existing models | Best when the source type is itself well-designed |
| `typeof` in type positions | Derive types from values ([Creating Types from Types](https://www.typescriptlang.org/docs/handbook/2/types-from-types.html)) | `typeof value` | Reuses runtime value shapes in types | Sync value constants and types | Must distinguish type-position `typeof` from runtime `typeof` |
| Indexed access types | Reuse property/member types ([Creating Types from Types](https://www.typescriptlang.org/docs/handbook/2/types-from-types.html)) | `T["a"]` | Extracts part of a type | Avoids re-declaring nested types | Depends on source-type accuracy |
| Conditional types | Type-level branching ([Creating Types from Types](https://www.typescriptlang.org/docs/handbook/2/types-from-types.html)) | `T extends U ? X : Y` | Adapts output type based on input type | Advanced helper types | Powerful but can become opaque |
| Mapped types | Transform all properties of a type ([Creating Types from Types](https://www.typescriptlang.org/docs/handbook/2/types-from-types.html)) | `{ [K in keyof T]: ... }` | Systematic property transformation | Reusable wrappers like readonly/optional transforms | Can hide complexity if overused |
| Template literal types | Build string-based types from patterns ([Creating Types from Types](https://www.typescriptlang.org/docs/handbook/2/types-from-types.html)) | `` `${A}-${B}` `` style | Expresses patterned string unions | Event names, key names, derived identifiers | Best for constrained string domains |
| `Partial<T>` | Make all properties optional ([Utility Types](https://www.typescriptlang.org/docs/handbook/utility-types.html)) | `Partial<T>` | Widens object shape to subsets | Patch/update APIs | Consumers must handle missing properties |
| `Required<T>` | Make all properties required ([Utility Types](https://www.typescriptlang.org/docs/handbook/utility-types.html)) | `Required<T>` | Tightens object shape | Normalize fully populated objects | Opposite of `Partial` |
| `Awaited<T>` | Recursively unwrap promise-like results ([Utility Types](https://www.typescriptlang.org/docs/handbook/utility-types.html)) | `Awaited<T>` | Mirrors `await` / `.then()` unwrapping | Async helper typing | Version-sensitive feature introduced in 4.5 |
| Module boundary | Distinguish module vs script files ([Modules](https://www.typescriptlang.org/docs/handbook/2/modules.html)) | top-level `import` / `export` | Changes scoping and module semantics | Normal application code organization | Missing import/export keeps file in global script mode |
| Declaration file `.d.ts` | Describe JS/library API surfaces ([Declaration Files intro](https://www.typescriptlang.org/docs/handbook/declaration-files/introduction.html)) | declaration syntax and templates | Adds type information without runtime emit | Typing libraries and packages | Should follow official templates and structure guidance |
| `allowUnreachableCode` | Control unreachable-code diagnostics ([TSConfig reference](https://www.typescriptlang.org/tsconfig/)) | `undefined`, `true`, `false` | Warning or error behavior in editors/compilation | Stricter maintainability policy | Only applies to provably unreachable syntax cases |
| `allowUnusedLabels` | Control unused-label diagnostics ([TSConfig reference](https://www.typescriptlang.org/tsconfig/)) | `undefined`, `true`, `false` | Warning or error behavior | Catch accidental label-like mistakes | Labels are rare; false positives often indicate a real bug |
| `alwaysStrict` | Parse in strict mode and emit `"use strict"` ([TSConfig reference](https://www.typescriptlang.org/tsconfig/)) | boolean | Affects parsing and emitted source files | Safer baseline JS semantics | Can expose latent non-strict assumptions |

## Coding standards and best practices from the docs

### Strictness settings

- Treat TSConfig as a source of codebase policy, not just transpilation plumbing ([TSConfig reference](https://www.typescriptlang.org/tsconfig/)).
- Prefer settings that surface suspicious code early, such as strict-mode parsing/emission and diagnostics for provably unreachable or mislabeled code ([TSConfig reference](https://www.typescriptlang.org/tsconfig/)).

### Public API typing

- Model APIs with specific parameter and return relationships instead of falling back to `any` ([Generics](https://www.typescriptlang.org/docs/handbook/2/generics.html), [Everyday Types](https://www.typescriptlang.org/docs/handbook/2/everyday-types.html)).
- Use interfaces, aliases, and function types deliberately to make public contracts readable and reusable ([More on Objects](https://www.typescriptlang.org/docs/handbook/2/objects.html), [More on Functions](https://www.typescriptlang.org/docs/handbook/2/functions.html)).

### Null / undefined and optionality handling

- Treat optional properties as genuinely absent-capable values; do not pretend `?` means “always there but ignored” ([More on Objects](https://www.typescriptlang.org/docs/handbook/2/objects.html)).
- Use narrowing and explicit checks to justify property/value use instead of type assertions as a first instinct ([Narrowing](https://www.typescriptlang.org/docs/handbook/2/narrowing.html)).

### Narrowing and guards

- Write runtime checks that express the program’s real invariants, then let control-flow analysis refine the type safely ([Narrowing](https://www.typescriptlang.org/docs/handbook/2/narrowing.html)).
- Prefer branch-local certainty over globally widened assumptions when working with unions ([Narrowing](https://www.typescriptlang.org/docs/handbook/2/narrowing.html)).

### Generics usage

- Use generics when they preserve meaningful relationships between values; do not replace a simple concrete type with a generic just because you can ([Generics](https://www.typescriptlang.org/docs/handbook/2/generics.html)).
- Avoid `any` where a type parameter would preserve useful information for callers ([Generics](https://www.typescriptlang.org/docs/handbook/2/generics.html)).

### Type reuse vs duplication

- Prefer deriving types from existing types and values using type operators and utility types instead of duplicating object or property definitions manually ([Creating Types from Types](https://www.typescriptlang.org/docs/handbook/2/types-from-types.html), [Utility Types](https://www.typescriptlang.org/docs/handbook/utility-types.html)).
- Utility types are the standard first stop for common transformations; custom mapped/conditional types should usually start only when built-ins are not enough ([Utility Types](https://www.typescriptlang.org/docs/handbook/utility-types.html)).

### Declaration file usage

- Use `.d.ts` authoring for packages or libraries that need type surfaces without runtime code changes ([Declaration Files intro](https://www.typescriptlang.org/docs/handbook/declaration-files/introduction.html)).
- Follow official templates, library-structure guidance, and do’s/don’ts for maintainable declaration files ([Declaration Files intro](https://www.typescriptlang.org/docs/handbook/declaration-files/introduction.html)).

### Config choices for maintainability

- Use module boundaries intentionally so files do not drift into implicit shared-global script mode ([Modules](https://www.typescriptlang.org/docs/handbook/2/modules.html)).
- Use compiler options to encode maintainability expectations and catch suspicious patterns consistently across the project ([TSConfig reference](https://www.typescriptlang.org/tsconfig/)).

## Practical defaults for future coding and review tasks

- Start reviews by checking whether `any` is truly necessary or whether generics, unions, object types, or utility types would preserve stronger guarantees ([Everyday Types](https://www.typescriptlang.org/docs/handbook/2/everyday-types.html), [Generics](https://www.typescriptlang.org/docs/handbook/2/generics.html)).
- Start type-design work by deciding whether the type should be **declared**, **derived**, or **transformed** from another type ([Creating Types from Types](https://www.typescriptlang.org/docs/handbook/2/types-from-types.html)).
- Treat narrowing code as part of API correctness, not merely as compiler appeasement ([Narrowing](https://www.typescriptlang.org/docs/handbook/2/narrowing.html)).
- When typing third-party JS, reach for proper declaration-file structure instead of sprinkling ad hoc ambient declarations across the codebase ([Declaration Files intro](https://www.typescriptlang.org/docs/handbook/declaration-files/introduction.html)).

## Known ambiguities / version-sensitive notes

- The TypeScript docs are a **rolling documentation set**, so pages may reflect features added in different releases rather than a single frozen handbook version; utility-type entries and TSConfig options often note their release versions explicitly ([Utility Types](https://www.typescriptlang.org/docs/handbook/utility-types.html), [TSConfig reference](https://www.typescriptlang.org/tsconfig/)).
- Module behavior is partly a TypeScript concern and partly a JavaScript-runtime/ecosystem concern; the modules handbook intentionally focuses on ES Modules and CommonJS rather than every historical module system ([Modules](https://www.typescriptlang.org/docs/handbook/2/modules.html)).
- Declaration files have their own authoring constraints and templates; library typing should not be treated as identical to normal application-code typing ([Declaration Files intro](https://www.typescriptlang.org/docs/handbook/declaration-files/introduction.html)).
- This file is intentionally condensed. For exhaustive details, follow the citations back to the specific handbook and TSConfig reference pages they point to ([TypeScript docs](https://www.typescriptlang.org/docs/), [TSConfig reference](https://www.typescriptlang.org/tsconfig/)).
