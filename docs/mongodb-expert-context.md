# MongoDB expert context

## How to use this context

Use this file as a **practical MongoDB reference** when designing schemas, writing queries, reviewing data-access code, or debugging performance issues. Treat the **MongoDB Manual** and **driver docs** as the primary operational/application references, and use the **MQL, operator, command, and method reference pages** for exact behavior and syntax details ([MongoDB Manual](https://www.mongodb.com/docs/manual/), [MongoDB Drivers](https://www.mongodb.com/docs/drivers/), [MQL reference](https://www.mongodb.com/docs/manual/reference/mql/), [mongosh methods](https://www.mongodb.com/docs/manual/reference/method/)).

## Source scope

- **Platform overview:** MongoDB docs home and Manual ([MongoDB docs](https://www.mongodb.com/docs/), [MongoDB Manual](https://www.mongodb.com/docs/manual/)).
- **Application-facing usage:** official MongoDB driver docs ([MongoDB Drivers](https://www.mongodb.com/docs/drivers/)).
- **Exact language behavior:** MongoDB Query Language reference, CRUD command reference, query predicate operators, update operators, projection operators, aggregation docs, and aggregation operator reference ([MQL reference](https://www.mongodb.com/docs/manual/reference/mql/), [CRUD commands](https://www.mongodb.com/docs/manual/reference/mql/crud-commands/), [Query operators](https://www.mongodb.com/docs/manual/reference/operator/query/), [Update operators](https://www.mongodb.com/docs/manual/reference/mql/update/), [Projection operators](https://www.mongodb.com/docs/manual/reference/mql/projection/), [Aggregation](https://www.mongodb.com/docs/manual/aggregation/), [Aggregation operators](https://www.mongodb.com/docs/manual/reference/operator/aggregation/)).
- **Shell-specific usage:** mongosh method reference ([mongosh methods](https://www.mongodb.com/docs/manual/reference/method/)).
- **Design and performance guidance:** data modeling, indexes, write atomicity, and transactions docs ([Data modeling](https://www.mongodb.com/docs/manual/data-modeling/), [Indexes](https://www.mongodb.com/docs/manual/indexes/), [Write atomicity](https://www.mongodb.com/docs/manual/core/write-operations-atomicity/), [Transactions](https://www.mongodb.com/docs/manual/core/transactions/)).
- These sources are **MongoDB-specific references and practices**, not a general application architecture style guide. Where they do not prescribe naming, repository structure, or language-specific code style, defer to project-local conventions ([MongoDB Manual](https://www.mongodb.com/docs/manual/), [MongoDB Drivers](https://www.mongodb.com/docs/drivers/)).

## Quick rules

1. Model data around **access patterns**; data accessed together should generally be stored together ([Data modeling](https://www.mongodb.com/docs/manual/data-modeling/)).
2. Prefer **embedding** when it lets you satisfy common reads in a single-document fetch; MongoDB explicitly highlights document structures as a way to avoid unnecessary multi-document transactions ([Data modeling](https://www.mongodb.com/docs/manual/data-modeling/), [Transactions](https://www.mongodb.com/docs/manual/core/transactions/)).
3. Remember that write operations are **atomic at the single-document level**, but multi-document operations are not atomic as a whole unless you use transactions ([CRUD](https://www.mongodb.com/docs/manual/crud/), [Write atomicity](https://www.mongodb.com/docs/manual/core/write-operations-atomicity/), [Transactions](https://www.mongodb.com/docs/manual/core/transactions/)).
4. Create indexes for repeatedly queried fields, but remember every index has a **write cost** ([Indexes](https://www.mongodb.com/docs/manual/indexes/)).
5. Prefer **aggregation pipelines** for aggregations; MongoDB calls them the preferred aggregation method ([Aggregation](https://www.mongodb.com/docs/manual/aggregation/)).
6. Use the **driver** in applications; the MongoDB docs explicitly note that most interactions use an idiomatic driver rather than JavaScript shell methods ([mongosh methods](https://www.mongodb.com/docs/manual/reference/method/), [MongoDB Drivers](https://www.mongodb.com/docs/drivers/)).
7. When concurrent updates matter, include the **expected current value in the filter** or use operators like `$inc` to avoid accidental lost updates ([Write atomicity](https://www.mongodb.com/docs/manual/core/write-operations-atomicity/)).
8. Use transactions only when you truly need multi-document atomicity; many use cases can be modeled to avoid them ([Transactions](https://www.mongodb.com/docs/manual/core/transactions/), [Data modeling](https://www.mongodb.com/docs/manual/data-modeling/)).
9. Treat MQL as more than simple find filters: it includes query predicates, projections, updates, expressions, and aggregation stages/operators ([MQL reference](https://www.mongodb.com/docs/manual/reference/mql/)).
10. Separate **driver usage** from **mongosh usage** in your mental model; shell methods are reference and tooling conveniences, not the main application API surface ([mongosh methods](https://www.mongodb.com/docs/manual/reference/method/), [MongoDB Drivers](https://www.mongodb.com/docs/drivers/)).

## Core MongoDB model

### Document model and collections

- MongoDB is a **document-oriented operational database** that stores rich JSON-like documents which map naturally to application objects ([MongoDB docs](https://www.mongodb.com/docs/)).
- The document data model is **flexible**: documents in the same collection do not need identical fields, and a field’s type can differ between documents in the same collection ([MongoDB Manual](https://www.mongodb.com/docs/manual/), [Data modeling](https://www.mongodb.com/docs/manual/data-modeling/)).
- Collections group documents; insert operations target a single collection and create it if it does not exist ([CRUD](https://www.mongodb.com/docs/manual/crud/)).

### MQL and how to think about it

- MongoDB Query Language (MQL) includes **query predicates, aggregation pipelines, expressions, projections, accumulators, update operators, and CRUD commands** ([MQL reference](https://www.mongodb.com/docs/manual/reference/mql/)).
- Query predicates are boolean expressions that determine whether a document matches a query ([Query operators](https://www.mongodb.com/docs/manual/reference/operator/query/)).
- Aggregation expressions are **stateless** and resolve to a value without mutating their inputs ([Aggregation operators](https://www.mongodb.com/docs/manual/reference/operator/aggregation/)).

## CRUD and write semantics

### CRUD basics

- CRUD covers **create, read, update, and delete** of documents ([CRUD](https://www.mongodb.com/docs/manual/crud/)).
- MongoDB provides collection-level methods such as `insertOne()` and `insertMany()` for insert operations ([CRUD](https://www.mongodb.com/docs/manual/crud/)).
- At the command layer, CRUD includes commands such as `find`, `insert`, `update`, `delete`, `distinct`, `aggregate`, `findAndModify`, `count`, and `bulkWrite` ([CRUD commands](https://www.mongodb.com/docs/manual/reference/mql/crud-commands/)).

### Atomicity and concurrent updates

- All write operations are atomic at the **single-document level**, even if they modify multiple values inside that document ([CRUD](https://www.mongodb.com/docs/manual/crud/), [Write atomicity](https://www.mongodb.com/docs/manual/core/write-operations-atomicity/)).
- A multi-document update operation modifies each individual document atomically, but the operation as a whole is **not** atomic ([Write atomicity](https://www.mongodb.com/docs/manual/core/write-operations-atomicity/)).
- To avoid conflicts in concurrent updates, include the expected current value in the update filter; filtering only by `_id` while setting a value can cause the second update to overwrite the first silently ([Write atomicity](https://www.mongodb.com/docs/manual/core/write-operations-atomicity/)).
- `$inc` is specifically called out as a safer concurrent pattern than naive overwrite-based `$set` in some conflict scenarios ([Write atomicity](https://www.mongodb.com/docs/manual/core/write-operations-atomicity/)).

## Transactions

- Single-document operations are atomic, and MongoDB explicitly notes that embedded documents and arrays often remove the need for multi-document transactions ([Transactions](https://www.mongodb.com/docs/manual/core/transactions/)).
- MongoDB supports transactions across **multiple operations, collections, databases, documents, and shards** when true multi-document atomicity is required ([Transactions](https://www.mongodb.com/docs/manual/core/transactions/)).
- The callback transaction API starts a transaction, executes operations, and commits or ends it on error; it also incorporates retry logic for some errors such as `TransientTransactionError` and `UnknownTransactionCommitResult` ([Transactions](https://www.mongodb.com/docs/manual/core/transactions/)).
- There are version-sensitive transaction caveats, including explicit notes in the docs about changed retry behavior in newer server versions ([Transactions](https://www.mongodb.com/docs/manual/core/transactions/)).

## Data modeling and schema design guidance

### Core design principle

- A core MongoDB modeling principle is that **data accessed together should be stored together** ([Data modeling](https://www.mongodb.com/docs/manual/data-modeling/)).
- Structure the model according to actual **application data access patterns** to optimize performance ([Data modeling](https://www.mongodb.com/docs/manual/data-modeling/)).

### Embedding vs referencing

- MongoDB’s examples explicitly favor embedding when related data is commonly returned together in a single query, such as department info embedded in employee records ([Data modeling](https://www.mongodb.com/docs/manual/data-modeling/)).
- Referencing or separating collections makes sense when some related data is accessed much less frequently, such as older product reviews stored separately from the hot product-page subset ([Data modeling](https://www.mongodb.com/docs/manual/data-modeling/)).
- Because documents can be polymorphic, a single collection can support differently shaped items when that matches the application’s model ([Data modeling](https://www.mongodb.com/docs/manual/data-modeling/)).

## Indexes and performance

- Indexes allow MongoDB to avoid scanning every document in a collection for supported queries ([Indexes](https://www.mongodb.com/docs/manual/indexes/)).
- Without an appropriate index, MongoDB must scan every document to return results ([Indexes](https://www.mongodb.com/docs/manual/indexes/)).
- Indexes improve read/query performance but add negative performance impact to writes because inserts and updates must also maintain indexes ([Indexes](https://www.mongodb.com/docs/manual/indexes/)).
- If your application repeatedly runs queries on the same fields, MongoDB explicitly recommends creating indexes on those fields ([Indexes](https://www.mongodb.com/docs/manual/indexes/)).

## Aggregation

- Aggregation processes multiple documents and returns computed results, including grouping values, analyzing changes over time, and querying the latest form of data ([Aggregation](https://www.mongodb.com/docs/manual/aggregation/)).
- MongoDB calls **aggregation pipelines** the preferred aggregation method ([Aggregation](https://www.mongodb.com/docs/manual/aggregation/)).
- A pipeline is made of one or more stages, each of which transforms or filters documents before passing them to the next stage ([Aggregation](https://www.mongodb.com/docs/manual/aggregation/)).
- Aggregation expressions can be used in stages like `$project`, `$addFields`, and `$group`, in `$expr` predicates, and in projections ([Aggregation operators](https://www.mongodb.com/docs/manual/reference/operator/aggregation/)).

## Driver vs mongosh guidance

- Most real application interaction with MongoDB uses an **idiomatic driver**, not JavaScript shell methods ([mongosh methods](https://www.mongodb.com/docs/manual/reference/method/), [MongoDB Drivers](https://www.mongodb.com/docs/drivers/)).
- The mongosh method reference is specifically about shell methods and notes that these are functional replacements for legacy shell APIs, not exact replacements in every detail ([mongosh methods](https://www.mongodb.com/docs/manual/reference/method/)).
- Application code should primarily think in terms of the official driver for its language/runtime, while keeping the shell reference available for exploration, debugging, and administrative workflows ([MongoDB Drivers](https://www.mongodb.com/docs/drivers/), [mongosh methods](https://www.mongodb.com/docs/manual/reference/method/)).

## Methods, operators, and APIs inventory

This is a **condensed high-value inventory**, not a verbatim dump of every MongoDB operator or method.

### CRUD methods and commands

| API | Purpose | Key args/params | Return/effect | Typical usage | Caveats |
|---|---|---|---|---|---|
| `db.collection.insertOne()` | Insert one document ([CRUD](https://www.mongodb.com/docs/manual/crud/)) | document | Adds one document to a collection | Single-document creation | Targets one collection; creates collection if needed |
| `db.collection.insertMany()` | Insert multiple documents ([CRUD](https://www.mongodb.com/docs/manual/crud/)) | array of documents | Adds many documents | Batch creation | Still collection-scoped |
| `find` command / `db.collection.find()` | Select documents from a collection or view ([CRUD commands](https://www.mongodb.com/docs/manual/reference/mql/crud-commands/)) | query filter, projection, options | Returns matching documents/cursor semantics depending API | Reads by predicate | Behavior differs slightly by driver/shell surface |
| `update` command / update methods | Update one or more documents ([CRUD commands](https://www.mongodb.com/docs/manual/reference/mql/crud-commands/)) | filter, update document/operators, options | Modifies matched docs | Targeted updates | Single-doc atomicity only |
| `delete` command / delete methods | Delete one or more documents ([CRUD commands](https://www.mongodb.com/docs/manual/reference/mql/crud-commands/)) | filter | Removes matched docs | Cleanup or lifecycle deletion | Multi-doc deletions are not atomic as a whole |
| `findAndModify` | Modify and return a single document ([CRUD commands](https://www.mongodb.com/docs/manual/reference/mql/crud-commands/)) | filter, modification, options | Returns/modifies one document | Read-modify-write workflows | Single-document oriented |
| `aggregate` | Run aggregation pipeline on collection or view ([CRUD commands](https://www.mongodb.com/docs/manual/reference/mql/crud-commands/), [Aggregation](https://www.mongodb.com/docs/manual/aggregation/)) | pipeline stages, options | Computed result set | Analytics, reshaping, derived results | Prefer pipelines over older/simpler aggregation approaches |
| `distinct` | Return distinct values for a field ([CRUD commands](https://www.mongodb.com/docs/manual/reference/mql/crud-commands/)) | field, filter/options | Unique values | Faceting-style retrieval | Index support matters for performance |
| `bulkWrite` | Perform many write ops in one request ([CRUD commands](https://www.mongodb.com/docs/manual/reference/mql/crud-commands/)) | batched operations | Many inserts/updates/deletes | High-throughput batch write workflows | Command-level semantics are version-sensitive; docs note it is new in 8.0 |

### Query, projection, and update operators

| API | Purpose | Key args/params | Return/effect | Typical usage | Caveats |
|---|---|---|---|---|---|
| Query predicates | Boolean document matching expressions ([Query operators](https://www.mongodb.com/docs/manual/reference/operator/query/)) | field/operator/value expressions | Match or reject documents | Filtering in reads and updates | Operator category matters: array, comparison, logical, geospatial, etc. |
| `$eq` and other comparison operators | Compare field values in predicates ([Query operators](https://www.mongodb.com/docs/manual/reference/operator/query/)) | field comparisons | Match docs by comparison | Standard filtered reads | Use the right operator family for the predicate |
| `$expr` | Use expressions inside query predicates ([Aggregation operators](https://www.mongodb.com/docs/manual/reference/operator/aggregation/)) | expression tree | Boolean match behavior in query context | Computed predicate logic | Pulls expression semantics into query matching |
| `$` projection operator | Project first array element matching query condition ([Projection operators](https://www.mongodb.com/docs/manual/reference/mql/projection/)) | projection syntax | Limits returned array content | Array-focused reads | Not supported on view `find()` operations |
| `$elemMatch` projection | Project first array element matching explicit condition ([Projection operators](https://www.mongodb.com/docs/manual/reference/mql/projection/)) | `$elemMatch` projection condition | Limits returned array content | Focused array projections | Not supported on view `find()` operations |
| `$slice` projection | Limit number of projected array elements ([Projection operators](https://www.mongodb.com/docs/manual/reference/mql/projection/)) | skip/limit slice args | Returns subset of array | Smaller array payloads | Not supported on view `find()` operations |
| `$set` | Set field value in document ([Update operators](https://www.mongodb.com/docs/manual/reference/mql/update/)) | field/value map | Overwrites target field values | Standard updates | Can clobber concurrent overwrite-based updates |
| `$inc` | Increment numeric field by amount ([Update operators](https://www.mongodb.com/docs/manual/reference/mql/update/), [Write atomicity](https://www.mongodb.com/docs/manual/core/write-operations-atomicity/)) | field/amount map | Adds delta | Counters, safer concurrent increments | Preferred in some concurrent update scenarios |
| `$currentDate` | Set field to current date or timestamp ([Update operators](https://www.mongodb.com/docs/manual/reference/mql/update/)) | field spec | Writes current temporal value | Updated-at style fields | Field ordering behavior is version-sensitive |
| `$setOnInsert` | Set field only on upsert-insert path ([Update operators](https://www.mongodb.com/docs/manual/reference/mql/update/)) | field/value map | Applies only when upsert inserts | Default values on upsert | No effect on plain matched update |

### Aggregation building blocks

| API | Purpose | Key args/params | Return/effect | Typical usage | Caveats |
|---|---|---|---|---|---|
| Aggregation pipeline | Preferred aggregation flow ([Aggregation](https://www.mongodb.com/docs/manual/aggregation/)) | ordered list of stages | Transforms/aggregates documents | Reporting, reshaping, analytics | Stage order matters |
| `$project` | Reshape/project fields ([Aggregation operators](https://www.mongodb.com/docs/manual/reference/operator/aggregation/)) | projection expression | New document shape | Output shaping | Expression-driven, stateless logic |
| `$addFields` | Add computed fields ([Aggregation operators](https://www.mongodb.com/docs/manual/reference/operator/aggregation/)) | field/expression mapping | Augmented document | Derived values mid-pipeline | Watch pipeline complexity |
| `$group` | Group documents and compute accumulated values ([Aggregation](https://www.mongodb.com/docs/manual/aggregation/), [Aggregation operators](https://www.mongodb.com/docs/manual/reference/operator/aggregation/)) | grouping key plus accumulators | Grouped aggregate output | Rollups and metrics | Requires accumulator semantics |
| Expressions such as `$add` | Compute values from constants, operators, and field paths ([Aggregation operators](https://www.mongodb.com/docs/manual/reference/operator/aggregation/)) | operator plus operands | Value result | Arithmetic, transforms, computed projections | Expressions are stateless |

## Coding standards and best practices from the docs

### Schema and data modeling

- Design schemas from **application access patterns**, not from generic normalization habits alone ([Data modeling](https://www.mongodb.com/docs/manual/data-modeling/)).
- Use the flexible document model intentionally; polymorphic collections are valid when they match application needs ([Data modeling](https://www.mongodb.com/docs/manual/data-modeling/)).

### Collection design

- Keep data that is accessed together together, often in the same document ([Data modeling](https://www.mongodb.com/docs/manual/data-modeling/)).
- Use separate collections when data is colder or accessed on a different cadence than the hot path ([Data modeling](https://www.mongodb.com/docs/manual/data-modeling/)).

### Embedding vs referencing

- Prefer embedding for closely related, co-read data ([Data modeling](https://www.mongodb.com/docs/manual/data-modeling/)).
- Prefer referencing/separation when data has different access frequency or lifecycle characteristics ([Data modeling](https://www.mongodb.com/docs/manual/data-modeling/)).

### Query design

- Understand the operator category you need: comparison, logical, array, data type, and specialized predicate families are distinct tools ([Query operators](https://www.mongodb.com/docs/manual/reference/operator/query/)).
- Use projections deliberately to reduce payload and focus reads, especially for arrays and metadata-heavy results ([Projection operators](https://www.mongodb.com/docs/manual/reference/mql/projection/)).

### Index strategy

- Add indexes for repeated query patterns, but account for the write cost of each index ([Indexes](https://www.mongodb.com/docs/manual/indexes/)).
- Use indexes to avoid unnecessary collection scans; lack of a supporting index forces broader scans ([Indexes](https://www.mongodb.com/docs/manual/indexes/)).

### Aggregation usage

- Prefer aggregation pipelines over older or more limited aggregation mechanisms ([Aggregation](https://www.mongodb.com/docs/manual/aggregation/)).
- Keep pipeline stages purposeful and ordered to progressively narrow, enrich, or reshape data ([Aggregation](https://www.mongodb.com/docs/manual/aggregation/)).

### Update patterns

- Prefer update filters that encode expected current state in concurrent workflows ([Write atomicity](https://www.mongodb.com/docs/manual/core/write-operations-atomicity/)).
- Use arithmetic or intent-specific operators like `$inc` instead of read-modify-overwrite patterns when concurrency matters ([Write atomicity](https://www.mongodb.com/docs/manual/core/write-operations-atomicity/), [Update operators](https://www.mongodb.com/docs/manual/reference/mql/update/)).

### Transaction usage

- Do not default to transactions for everything; MongoDB explicitly notes many practical use cases can avoid them through document design ([Transactions](https://www.mongodb.com/docs/manual/core/transactions/)).
- Use transactions when you genuinely need multi-document, multi-collection, or cross-shard atomicity ([Transactions](https://www.mongodb.com/docs/manual/core/transactions/)).

### Driver usage vs shell usage

- In application code, prefer the official driver for the language/runtime you are using ([MongoDB Drivers](https://www.mongodb.com/docs/drivers/)).
- Treat mongosh methods as shell/documentation/admin tooling, not as the main application API model ([mongosh methods](https://www.mongodb.com/docs/manual/reference/method/)).

### Maintainability and performance

- Favor data layouts that satisfy common reads efficiently and avoid unnecessary joins/workarounds in application code ([Data modeling](https://www.mongodb.com/docs/manual/data-modeling/)).
- Balance read optimization with write costs when designing indexes and update patterns ([Indexes](https://www.mongodb.com/docs/manual/indexes/), [Write atomicity](https://www.mongodb.com/docs/manual/core/write-operations-atomicity/)).

## Practical defaults for future coding tasks

- Start schema design by listing the most important read and write paths, then shape documents around them ([Data modeling](https://www.mongodb.com/docs/manual/data-modeling/)).
- Start performance work by checking query/index fit before reaching for broader architectural changes ([Indexes](https://www.mongodb.com/docs/manual/indexes/)).
- Prefer driver-level APIs in production code and keep shell snippets clearly separated as examples or admin workflows ([MongoDB Drivers](https://www.mongodb.com/docs/drivers/), [mongosh methods](https://www.mongodb.com/docs/manual/reference/method/)).
- Prefer single-document designs and single-document atomic operations where possible; add transactions only when requirements genuinely cross document boundaries ([Write atomicity](https://www.mongodb.com/docs/manual/core/write-operations-atomicity/), [Transactions](https://www.mongodb.com/docs/manual/core/transactions/)).

## Known ambiguities / version-sensitive notes

- The MongoDB docs site is a **living docs system**; exact behavior can vary by server version, driver version, and API surface, so record the relevant version when precision matters ([MongoDB docs](https://www.mongodb.com/docs/), [MongoDB Drivers](https://www.mongodb.com/docs/drivers/)).
- Some command and transaction behaviors are explicitly version-sensitive in the docs, such as `bulkWrite` being marked new in 8.0 and transaction retry caveats changing in newer versions ([CRUD commands](https://www.mongodb.com/docs/manual/reference/mql/crud-commands/), [Transactions](https://www.mongodb.com/docs/manual/core/transactions/)).
- The mongosh method reference is **not** a universal application API reference; it is shell-specific and explicitly distinguished from idiomatic driver usage ([mongosh methods](https://www.mongodb.com/docs/manual/reference/method/), [MongoDB Drivers](https://www.mongodb.com/docs/drivers/)).
- This file is intentionally condensed. For exhaustive operators, stages, and commands, use the referenced MQL, operator, command, and method index pages directly ([MQL reference](https://www.mongodb.com/docs/manual/reference/mql/), [Query operators](https://www.mongodb.com/docs/manual/reference/operator/query/), [Aggregation operators](https://www.mongodb.com/docs/manual/reference/operator/aggregation/), [mongosh methods](https://www.mongodb.com/docs/manual/reference/method/)).
