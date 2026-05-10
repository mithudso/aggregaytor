# MongoDB performance and troubleshooting context

## How to use this context

Use this file as a **practical performance and debugging reference** when investigating slow queries, poor index usage, lock contention, connection pressure, query-plan regressions, or transaction overhead. Treat the **MongoDB Manual** and **driver docs** as the primary operational/application references, and use the **query-plan, explain, profiler, `serverStatus`, `currentOp`, and operator references** for exact troubleshooting behavior and output semantics ([MongoDB Manual](https://www.mongodb.com/docs/manual/), [MongoDB Drivers](https://www.mongodb.com/docs/drivers/), [Query plans](https://www.mongodb.com/docs/manual/core/query-plans/), [Explain results](https://www.mongodb.com/docs/manual/reference/explain-results/), [Database profiler](https://www.mongodb.com/docs/manual/tutorial/manage-the-database-profiler/), [serverStatus](https://www.mongodb.com/docs/manual/reference/command/serverStatus/)).

## Source scope

- **General platform and operational guidance:** MongoDB docs home, Manual, and driver docs ([MongoDB docs](https://www.mongodb.com/docs/), [MongoDB Manual](https://www.mongodb.com/docs/manual/), [MongoDB Drivers](https://www.mongodb.com/docs/drivers/)).
- **Performance diagnosis:** analyzing performance, query plans, explain results, query-plan analysis tutorial, profiler docs, slow-query profiler tutorial, index-use measurement, indexes, data modeling, write atomicity, and transactions ([Analyzing performance](https://www.mongodb.com/docs/manual/administration/analyzing-mongodb-performance/), [Query plans](https://www.mongodb.com/docs/manual/core/query-plans/), [Explain results](https://www.mongodb.com/docs/manual/reference/explain-results/), [Analyze query plan](https://www.mongodb.com/docs/manual/tutorial/analyze-query-plan/), [Database profiler](https://www.mongodb.com/docs/manual/tutorial/manage-the-database-profiler/), [Find slow queries](https://www.mongodb.com/docs/manual/tutorial/find-slow-queries-with-database-profiler/), [Measure index use](https://www.mongodb.com/docs/manual/tutorial/measure-index-use/), [Indexes](https://www.mongodb.com/docs/manual/indexes/), [Data modeling](https://www.mongodb.com/docs/manual/data-modeling/), [Write atomicity](https://www.mongodb.com/docs/manual/core/write-operations-atomicity/), [Transactions](https://www.mongodb.com/docs/manual/core/transactions/)).
- **Runtime diagnostics:** `serverStatus`, `currentOp`, and mongosh method reference ([serverStatus](https://www.mongodb.com/docs/manual/reference/command/serverStatus/), [currentOp](https://www.mongodb.com/docs/manual/reference/command/currentOp/), [mongosh methods](https://www.mongodb.com/docs/manual/reference/method/)).
- **Query semantics:** MQL, query predicate operators, aggregation docs, aggregation operators ([MQL reference](https://www.mongodb.com/docs/manual/reference/mql/), [Query operators](https://www.mongodb.com/docs/manual/reference/operator/query/), [Aggregation](https://www.mongodb.com/docs/manual/aggregation/), [Aggregation operators](https://www.mongodb.com/docs/manual/reference/operator/aggregation/)).
- **Atlas-specific surfaces:** Atlas Query Profiler and Atlas Performance Advisor ([Atlas Query Profiler](https://www.mongodb.com/docs/atlas/tutorial/query-profiler/), [Atlas Performance Advisor](https://www.mongodb.com/docs/atlas/performance-advisor/)).

## Quick triage rules

1. Start by verifying whether the slowdown is caused by **query shape, indexing, schema design, connection pressure, locks, or capacity**, because MongoDB explicitly lists those as common performance drivers ([Analyzing performance](https://www.mongodb.com/docs/manual/administration/analyzing-mongodb-performance/)).
2. For a slow query, check **whether it used an index**, how many **documents and keys** it scanned, and how long it ran by using `explain()` in execution-stats mode ([Analyze query plan](https://www.mongodb.com/docs/manual/tutorial/analyze-query-plan/), [Measure index use](https://www.mongodb.com/docs/manual/tutorial/measure-index-use/)).
3. Remember that `explain` **ignores the plan cache** and prevents caching of the winning plan, so use it for diagnosis, not as a perfect picture of steady-state cache behavior ([Explain results](https://www.mongodb.com/docs/manual/reference/explain-results/), [Query plans](https://www.mongodb.com/docs/manual/core/query-plans/)).
4. If the same fields are queried repeatedly, add or refine **indexes**, but remember indexes improve reads at the cost of additional write overhead ([Indexes](https://www.mongodb.com/docs/manual/indexes/)).
5. Use **data modeling** to solve recurring performance issues before reaching for multi-document transactions; MongoDB explicitly notes that embedding often avoids the need for transactions ([Data modeling](https://www.mongodb.com/docs/manual/data-modeling/), [Transactions](https://www.mongodb.com/docs/manual/core/transactions/)).
6. Use the **database profiler cautiously** in production because it can degrade performance, increase disk usage, and expose query data ([Database profiler](https://www.mongodb.com/docs/manual/tutorial/manage-the-database-profiler/), [Find slow queries](https://www.mongodb.com/docs/manual/tutorial/find-slow-queries-with-database-profiler/)).
7. On Atlas, prefer **Query Profiler** and **Performance Advisor** first when available; the docs explicitly position them as lower-friction alternatives to the database profiler for many cases ([Database profiler](https://www.mongodb.com/docs/manual/tutorial/manage-the-database-profiler/), [Atlas Query Profiler](https://www.mongodb.com/docs/atlas/tutorial/query-profiler/), [Atlas Performance Advisor](https://www.mongodb.com/docs/atlas/performance-advisor/)).
8. For lock or concurrency issues, inspect `serverStatus` lock and queue fields and use `currentOp`/`$currentOp` to look at in-flight work ([Analyzing performance](https://www.mongodb.com/docs/manual/administration/analyzing-mongodb-performance/), [serverStatus](https://www.mongodb.com/docs/manual/reference/command/serverStatus/), [currentOp](https://www.mongodb.com/docs/manual/reference/command/currentOp/)).
9. Treat **driver usage** and **mongosh usage** separately: applications should use drivers, while shell commands and methods are diagnostic/admin tools ([MongoDB Drivers](https://www.mongodb.com/docs/drivers/), [mongosh methods](https://www.mongodb.com/docs/manual/reference/method/)).

## Diagnostic workflow

1. **Confirm the symptom.** Identify whether the issue is latency, throughput collapse, lock waits, connection saturation, or a specific slow query family ([Analyzing performance](https://www.mongodb.com/docs/manual/administration/analyzing-mongodb-performance/)).
2. **Check query behavior.** Use `explain("executionStats")` or `db.collection.explain()` to inspect index use, documents examined, keys examined, and execution characteristics ([Analyze query plan](https://www.mongodb.com/docs/manual/tutorial/analyze-query-plan/), [Measure index use](https://www.mongodb.com/docs/manual/tutorial/measure-index-use/)).
3. **Check plan behavior.** If results seem inconsistent across runs, review how the query planner chooses and caches plans, and remember `explain` bypasses the plan cache ([Query plans](https://www.mongodb.com/docs/manual/core/query-plans/), [Explain results](https://www.mongodb.com/docs/manual/reference/explain-results/)).
4. **Check index fit.** Use `$indexStats` and explain output to verify whether indexes are used and whether the current query shape aligns with available indexes ([Measure index use](https://www.mongodb.com/docs/manual/tutorial/measure-index-use/), [Indexes](https://www.mongodb.com/docs/manual/indexes/)).
5. **Profile slow operations carefully.** If needed, enable the database profiler at an appropriate level or use Atlas Query Profiler / Performance Advisor where available ([Database profiler](https://www.mongodb.com/docs/manual/tutorial/manage-the-database-profiler/), [Find slow queries](https://www.mongodb.com/docs/manual/tutorial/find-slow-queries-with-database-profiler/), [Atlas Query Profiler](https://www.mongodb.com/docs/atlas/tutorial/query-profiler/), [Atlas Performance Advisor](https://www.mongodb.com/docs/atlas/performance-advisor/)).
6. **Inspect server state.** Check `serverStatus` for locks, queues, and metrics; use `currentOp` or `$currentOp` for live operations ([Analyzing performance](https://www.mongodb.com/docs/manual/administration/analyzing-mongodb-performance/), [serverStatus](https://www.mongodb.com/docs/manual/reference/command/serverStatus/), [currentOp](https://www.mongodb.com/docs/manual/reference/command/currentOp/)).
7. **Check schema and write semantics.** Revisit data modeling, document boundaries, and transaction need if the issue is structural rather than query-local ([Data modeling](https://www.mongodb.com/docs/manual/data-modeling/), [Write atomicity](https://www.mongodb.com/docs/manual/core/write-operations-atomicity/), [Transactions](https://www.mongodb.com/docs/manual/core/transactions/)).

## What affects MongoDB performance

### Architecture and capacity factors

- MongoDB’s performance can degrade due to **database access strategies, hardware availability, and number of open database connections** ([Analyzing performance](https://www.mongodb.com/docs/manual/administration/analyzing-mongodb-performance/)).
- Inadequate or inappropriate **indexing strategies** and poor **schema design** are called out as common root causes ([Analyzing performance](https://www.mongodb.com/docs/manual/administration/analyzing-mongodb-performance/)).
- Performance issues can mean the database is at capacity; MongoDB specifically notes the application’s **working set should fit in available physical memory** ([Analyzing performance](https://www.mongodb.com/docs/manual/administration/analyzing-mongodb-performance/)).

### Locking and concurrency

- MongoDB uses locking to ensure consistency, and long-running operations or request queues can degrade performance while work waits for locks ([Analyzing performance](https://www.mongodb.com/docs/manual/administration/analyzing-mongodb-performance/)).
- `serverStatus` exposes lock and queue information, including `locks`, `globalLock`, and wait-related counters, which the docs explicitly recommend for diagnosing lock-related slowdowns ([Analyzing performance](https://www.mongodb.com/docs/manual/administration/analyzing-mongodb-performance/), [serverStatus](https://www.mongodb.com/docs/manual/reference/command/serverStatus/)).
- A consistently high `globalLock.currentQueue.total` suggests many requests waiting for a lock and possible concurrency issues ([Analyzing performance](https://www.mongodb.com/docs/manual/administration/analyzing-mongodb-performance/)).

## Query planning, plan cache, and explain

### Query planner behavior

- The query planner chooses and caches what it judges to be the most efficient plan among candidate plans based on available indexes ([Query plans](https://www.mongodb.com/docs/manual/core/query-plans/)).
- Candidate plans are evaluated during a trial period, and the winning plan is generally the one that returns the most results while performing the least work ([Query plans](https://www.mongodb.com/docs/manual/core/query-plans/)).
- The plan cache tracks query shapes through states such as **Missing**, **Inactive**, and active usage states for subsequent queries ([Query plans](https://www.mongodb.com/docs/manual/core/query-plans/)).

### Explain behavior

- `db.collection.explain()` and `cursor.explain()` provide query-plan and execution statistics ([Explain results](https://www.mongodb.com/docs/manual/reference/explain-results/)).
- `explain` results help determine query duration, whether an index was used, and how many documents/index keys were scanned ([Analyze query plan](https://www.mongodb.com/docs/manual/tutorial/analyze-query-plan/)).
- Explain output is stage-tree based and can differ between the classic query engine and the slot-based execution engine ([Explain results](https://www.mongodb.com/docs/manual/reference/explain-results/)).
- Important execution stages include `COLLSCAN`, `IXSCAN`, `FETCH`, `GROUP`, `SHARD_MERGE`, and others, which makes stage interpretation central to troubleshooting ([Explain results](https://www.mongodb.com/docs/manual/reference/explain-results/)).
- Explain output is explicitly subject to change between MongoDB versions ([Explain results](https://www.mongodb.com/docs/manual/reference/explain-results/), [Analyze query plan](https://www.mongodb.com/docs/manual/tutorial/analyze-query-plan/)).

## Indexing and index-use analysis

- Indexes let MongoDB avoid scanning every document in a collection for supported queries ([Indexes](https://www.mongodb.com/docs/manual/indexes/)).
- If the query workload repeatedly targets the same fields, MongoDB recommends indexing those fields ([Indexes](https://www.mongodb.com/docs/manual/indexes/)).
- Indexes increase read performance but add cost to inserts and updates because index entries must be maintained ([Indexes](https://www.mongodb.com/docs/manual/indexes/)).
- `$indexStats` returns index-usage statistics per collection, but the docs warn that the access metrics are only for the node where the query runs; cluster-wide assessment requires running it on each node ([Measure index use](https://www.mongodb.com/docs/manual/tutorial/measure-index-use/)).
- `hint()` can be used to force a specific index during investigation, but that is a diagnostic control, not a substitute for correct index/query design ([Measure index use](https://www.mongodb.com/docs/manual/tutorial/measure-index-use/)).

## Slow-query detection and profiling

- The database profiler identifies slow queries and other commands executed against a `mongod`, but it is off by default and can affect performance and disk use ([Database profiler](https://www.mongodb.com/docs/manual/tutorial/manage-the-database-profiler/)).
- Profiling levels are configurable, and `db.setProfilingLevel()` can be used to collect slow operations above a `slowms` threshold ([Database profiler](https://www.mongodb.com/docs/manual/tutorial/manage-the-database-profiler/), [Find slow queries](https://www.mongodb.com/docs/manual/tutorial/find-slow-queries-with-database-profiler/)).
- Profiler data is written to `system.profile`, a capped collection in each profiled database ([Database profiler](https://www.mongodb.com/docs/manual/tutorial/manage-the-database-profiler/)).
- MongoDB explicitly warns to consider performance, storage, and security implications before enabling the profiler in production because it can expose unencrypted query data ([Find slow queries](https://www.mongodb.com/docs/manual/tutorial/find-slow-queries-with-database-profiler/)).

### Atlas-specific profiling

- Atlas Query Profiler is available only on **M10+ clusters** and diagnoses slow-running queries using `mongod` log data surfaced in Atlas UI ([Atlas Query Profiler](https://www.mongodb.com/docs/atlas/tutorial/query-profiler/)).
- Atlas Query Profiler is different from the database profiler: it relies on slow-query log data and is not controlled by changing the database profiling level ([Atlas Query Profiler](https://www.mongodb.com/docs/atlas/tutorial/query-profiler/)).
- Atlas Performance Advisor monitors slow queries and suggests new indexes; the docs explicitly state it does **not negatively affect Atlas cluster performance** ([Atlas Performance Advisor](https://www.mongodb.com/docs/atlas/performance-advisor/)).

## Server health and runtime diagnostics

- `serverStatus` returns a broad overview of database state and is intended for regular monitoring/statistics collection ([serverStatus](https://www.mongodb.com/docs/manual/reference/command/serverStatus/)).
- Much of `serverStatus` overlaps with what `mongostat` displays dynamically ([serverStatus](https://www.mongodb.com/docs/manual/reference/command/serverStatus/)).
- `currentOp` returns in-progress operation information, but the command is **deprecated since 6.2**; the docs recommend using the `$currentOp` aggregation stage instead ([currentOp](https://www.mongodb.com/docs/manual/reference/command/currentOp/)).
- The database profiler docs also point to `db.currentOp()` as a related administrative surface for examining operations ([Database profiler](https://www.mongodb.com/docs/manual/tutorial/manage-the-database-profiler/)).

## Data modeling and query design for performance

- MongoDB recommends modeling data around **application access patterns**, with the core principle that data accessed together should be stored together ([Data modeling](https://www.mongodb.com/docs/manual/data-modeling/)).
- Embedding frequently co-read data can reduce the need for multi-document reads and multi-document transactions ([Data modeling](https://www.mongodb.com/docs/manual/data-modeling/), [Transactions](https://www.mongodb.com/docs/manual/core/transactions/)).
- Projections should be used intentionally to reduce returned payloads, especially when array or metadata-heavy results would otherwise inflate response size ([MQL reference](https://www.mongodb.com/docs/manual/reference/mql/), [Measure index use](https://www.mongodb.com/docs/manual/tutorial/measure-index-use/)).
- Large arrays and `$lookup`-heavy patterns are explicitly called out in Atlas Performance Advisor as common reasons for slow queries ([Atlas Performance Advisor](https://www.mongodb.com/docs/atlas/performance-advisor/)).

## Write path, atomicity, and transactions

- MongoDB write operations are atomic at the **single-document** level, even when multiple fields are modified in one document ([Write atomicity](https://www.mongodb.com/docs/manual/core/write-operations-atomicity/)).
- Multi-document write operations are not atomic as a whole unless you use transactions ([Write atomicity](https://www.mongodb.com/docs/manual/core/write-operations-atomicity/), [Transactions](https://www.mongodb.com/docs/manual/core/transactions/)).
- For concurrent updates, include expected current values in the filter or use operators like `$inc` to avoid silent overwrites ([Write atomicity](https://www.mongodb.com/docs/manual/core/write-operations-atomicity/)).
- Transactions support multi-operation and multi-collection atomicity, but MongoDB explicitly frames them as necessary for some situations rather than the default answer for all modeling problems ([Transactions](https://www.mongodb.com/docs/manual/core/transactions/)).

## Driver vs mongosh troubleshooting guidance

- Official drivers are the normal application surface and receive MongoDB’s active development, fixes, and security patches ([MongoDB Drivers](https://www.mongodb.com/docs/drivers/)).
- The mongosh method reference is useful for exploration and admin workflows, but it is not the primary application API model ([mongosh methods](https://www.mongodb.com/docs/manual/reference/method/), [MongoDB Drivers](https://www.mongodb.com/docs/drivers/)).
- When documenting remediation steps, keep shell snippets distinct from driver-level recommendations so production code guidance stays idiomatic to the application language/runtime ([MongoDB Drivers](https://www.mongodb.com/docs/drivers/), [mongosh methods](https://www.mongodb.com/docs/manual/reference/method/)).

## Methods, commands, stages, and diagnostics inventory

This is a **condensed troubleshooting-focused inventory**, not an exhaustive dump of every MongoDB method or operator.

| API | Purpose | Key args/modes | Output/effect | Typical troubleshooting use | Caveats |
|---|---|---|---|---|---|
| `db.collection.explain()` / `cursor.explain()` | Return query plan and execution stats ([Explain results](https://www.mongodb.com/docs/manual/reference/explain-results/)) | modes such as `executionStats`, `allPlansExecution` ([Measure index use](https://www.mongodb.com/docs/manual/tutorial/measure-index-use/)) | Query-plan tree and stats | Verify index use, scanned docs/keys, stage shape | Ignores plan cache; output changes by version/engine |
| Query planner / plan cache | Choose and cache efficient plans for query shapes ([Query plans](https://www.mongodb.com/docs/manual/core/query-plans/)) | query shape, candidate plans | Winning plan cached for subsequent queries | Explain regressions, plan instability, index effects | `explain` bypasses cache |
| `$indexStats` | Report per-index usage statistics ([Measure index use](https://www.mongodb.com/docs/manual/tutorial/measure-index-use/)) | aggregation stage | Index access counters | Identify unused/underused indexes | Metrics are node-local |
| `hint()` | Force a specific index ([Measure index use](https://www.mongodb.com/docs/manual/tutorial/measure-index-use/)) | index spec/name | Overrides planner choice | A/B test index behavior during diagnosis | Diagnostic tool, not a long-term substitute for good design |
| `db.setProfilingLevel()` | Configure profiler level/slowms ([Find slow queries](https://www.mongodb.com/docs/manual/tutorial/find-slow-queries-with-database-profiler/)) | profiling level, `slowms` | Enables/disables slow-op capture | Capture slow queries in targeted debugging | Profiler overhead and data exposure risk |
| `system.profile` | Store profiler output ([Database profiler](https://www.mongodb.com/docs/manual/tutorial/manage-the-database-profiler/)) | profiled database | Capped collection of captured ops | Inspect slow/expensive commands | Requires profiler enabled |
| `serverStatus` / `db.serverStatus()` | Return server-wide health and statistics ([serverStatus](https://www.mongodb.com/docs/manual/reference/command/serverStatus/)) | command or wrapper | Large state document | Inspect locks, queues, metrics, server health | Some fields limited in Atlas tiers |
| `currentOp` / `$currentOp` | Inspect in-progress operations ([currentOp](https://www.mongodb.com/docs/manual/reference/command/currentOp/)) | command or aggregation stage | Active operation info | Find blocking/long-running work | `currentOp` command deprecated since 6.2 |
| Atlas Query Profiler | Surface slow-query log data in Atlas ([Atlas Query Profiler](https://www.mongodb.com/docs/atlas/tutorial/query-profiler/)) | Atlas UI filters and time windows | Cluster query insights | Find slow query families quickly in Atlas | M10+ only; distinct from DB profiler |
| Atlas Performance Advisor | Recommend indexes for slow-query shapes ([Atlas Performance Advisor](https://www.mongodb.com/docs/atlas/performance-advisor/)) | Atlas UI/query-shape grouping | Suggested indexes with sample queries | Identify index gaps | Query shape may differ from actual pipeline after optimization |

## Performance and troubleshooting standards / best practices

### Schema and data modeling for performance

- Model around access patterns and keep co-accessed data together ([Data modeling](https://www.mongodb.com/docs/manual/data-modeling/)).
- Use embedding where it reduces repeated multi-document fetches or transaction needs ([Data modeling](https://www.mongodb.com/docs/manual/data-modeling/), [Transactions](https://www.mongodb.com/docs/manual/core/transactions/)).

### Query design

- Use the correct predicate/operator family for the query shape you are analyzing ([Query operators](https://www.mongodb.com/docs/manual/reference/operator/query/), [MQL reference](https://www.mongodb.com/docs/manual/reference/mql/)).
- Investigate document and key scan counts, not just raw latency, when deciding whether a query is efficient ([Analyze query plan](https://www.mongodb.com/docs/manual/tutorial/analyze-query-plan/)).

### Projection usage

- Reduce returned payload when possible, especially for array-heavy or wide documents ([MQL reference](https://www.mongodb.com/docs/manual/reference/mql/), [Measure index use](https://www.mongodb.com/docs/manual/tutorial/measure-index-use/)).

### Index strategy

- Add indexes for repeated query shapes, but account for insert/update maintenance cost ([Indexes](https://www.mongodb.com/docs/manual/indexes/)).
- Measure real index usage before keeping or removing indexes ([Measure index use](https://www.mongodb.com/docs/manual/tutorial/measure-index-use/)).

### Explain-plan analysis

- Use `executionStats` to see the actual work a query performed ([Analyze query plan](https://www.mongodb.com/docs/manual/tutorial/analyze-query-plan/)).
- Remember that explain output differs across engines and versions and bypasses cache effects ([Explain results](https://www.mongodb.com/docs/manual/reference/explain-results/), [Query plans](https://www.mongodb.com/docs/manual/core/query-plans/)).

### Profiler usage and overhead

- Prefer Atlas Query Profiler / Performance Advisor first on Atlas when they fit the problem ([Database profiler](https://www.mongodb.com/docs/manual/tutorial/manage-the-database-profiler/), [Atlas Query Profiler](https://www.mongodb.com/docs/atlas/tutorial/query-profiler/), [Atlas Performance Advisor](https://www.mongodb.com/docs/atlas/performance-advisor/)).
- If using the database profiler, scope it carefully and treat it as an overhead-bearing diagnostic tool ([Database profiler](https://www.mongodb.com/docs/manual/tutorial/manage-the-database-profiler/), [Find slow queries](https://www.mongodb.com/docs/manual/tutorial/find-slow-queries-with-database-profiler/)).

### Monitoring and observability

- Use `serverStatus` for regular statistics collection and broad health inspection ([serverStatus](https://www.mongodb.com/docs/manual/reference/command/serverStatus/)).
- Use Atlas-native views when on Atlas and local commands when self-hosted, following what the docs make available in each environment ([serverStatus](https://www.mongodb.com/docs/manual/reference/command/serverStatus/), [Atlas Query Profiler](https://www.mongodb.com/docs/atlas/tutorial/query-profiler/), [Atlas Performance Advisor](https://www.mongodb.com/docs/atlas/performance-advisor/)).

### Lock/concurrency investigation

- Check lock wait counters, lock acquisition timing, and queue depth when latency spikes are intermittent or concurrency-related ([Analyzing performance](https://www.mongodb.com/docs/manual/administration/analyzing-mongodb-performance/), [serverStatus](https://www.mongodb.com/docs/manual/reference/command/serverStatus/)).
- Use live-operation inspection for suspected blockers or long-running operations ([currentOp](https://www.mongodb.com/docs/manual/reference/command/currentOp/)).

### Transaction usage

- Do not assume transactions are the first performance-safe answer; first check whether document design can avoid them ([Transactions](https://www.mongodb.com/docs/manual/core/transactions/), [Data modeling](https://www.mongodb.com/docs/manual/data-modeling/)).
- Use transactions when atomicity truly spans multiple documents/collections and the requirement cannot be met with single-document semantics ([Transactions](https://www.mongodb.com/docs/manual/core/transactions/), [Write atomicity](https://www.mongodb.com/docs/manual/core/write-operations-atomicity/)).

### Driver-side troubleshooting considerations

- Keep application-side recommendations driver-native and use shell examples as diagnostic equivalents, not as direct replacements ([MongoDB Drivers](https://www.mongodb.com/docs/drivers/), [mongosh methods](https://www.mongodb.com/docs/manual/reference/method/)).

### Maintainability and safe production diagnostics

- Prefer the least invasive diagnostic surface that answers the question: explain first, targeted metrics next, profiler last when necessary ([Analyze query plan](https://www.mongodb.com/docs/manual/tutorial/analyze-query-plan/), [Database profiler](https://www.mongodb.com/docs/manual/tutorial/manage-the-database-profiler/)).
- Consider security and operational overhead before enabling data-capturing diagnostics in production ([Find slow queries](https://www.mongodb.com/docs/manual/tutorial/find-slow-queries-with-database-profiler/)).

## Known ambiguities / version-sensitive notes

- Explain output structure can differ by query engine and MongoDB version, and MongoDB explicitly says only the most important fields are documented and fields can change ([Explain results](https://www.mongodb.com/docs/manual/reference/explain-results/)).
- `currentOp` is deprecated since MongoDB 6.2 in favor of `$currentOp` ([currentOp](https://www.mongodb.com/docs/manual/reference/command/currentOp/)).
- Atlas Query Profiler and Performance Advisor are Atlas features and have tier/availability constraints, including the Query Profiler’s M10+ requirement ([Atlas Query Profiler](https://www.mongodb.com/docs/atlas/tutorial/query-profiler/), [Atlas Performance Advisor](https://www.mongodb.com/docs/atlas/performance-advisor/)).
- Some `serverStatus` fields are limited on Atlas Free or Flex clusters ([Analyzing performance](https://www.mongodb.com/docs/manual/administration/analyzing-mongodb-performance/)).
- This file is intentionally condensed; for exhaustive operator and command details, defer to the linked MQL, operator, command, and method references ([MQL reference](https://www.mongodb.com/docs/manual/reference/mql/), [Query operators](https://www.mongodb.com/docs/manual/reference/operator/query/), [Aggregation operators](https://www.mongodb.com/docs/manual/reference/operator/aggregation/), [mongosh methods](https://www.mongodb.com/docs/manual/reference/method/)).
