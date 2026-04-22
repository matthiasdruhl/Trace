# Trace Filtering Implementation README

Status note (2026-04-21): the filtering system described here has already been implemented in the active codebase. This document is retained as the implementation rationale and design record for the current constrained `sql_filter` model; the live contract is documented in `docs/API_CONTRACT.md`.

This document specifies how to implement **real metadata filtering** in `lambda-engine` for Trace's current architecture.

It is intentionally concrete. The goal is not to brainstorm filtering ideas; the goal is to define the implementation path that best fits the code that exists today.

---

## Historical goal

Make `sql_filter` in the Lambda search API actually affect the result set returned by `POST /search`.

At the end of this work, the Trace Lambda should support:

- semantic nearest-neighbor search over `vector`
- structured metadata filtering over allowed fields
- predictable, safe validation errors for unsupported filters
- tests that prove filtering changes search output

---

## Executive decision

For the current repository, the best implementation path is:

**implement a constrained filter parser that compiles to Lance-native predicates first**

Do **not** start by exposing arbitrary SQL or embedding DuckDB directly into the request path.

### Why this is the right choice now

1. The current search kernel is already Lance-first
   - dataset open/search path already exists in [`lambda-engine/src/search.rs`](../lambda-engine/src/search.rs)
   - the missing behavior is filtering, not a missing storage/query engine

2. It is the safest path for an HTTP-facing API
   - raw SQL creates injection, validation, and behavioral ambiguity problems
   - a constrained grammar is much easier to reason about and test

3. It is the fastest path to a real MVP
   - no new execution engine needs to be introduced into the critical path
   - no additional dependency graph or deployment complexity is required for the first usable version

4. It keeps the public API stable
   - clients can continue sending `sql_filter` as a string
   - internally, Trace can treat it as a constrained filter expression rather than arbitrary SQL

### When DuckDB should enter the picture

DuckDB can still be valuable later if Trace needs:

- richer filter semantics
- joins across metadata side tables
- precomputed structured analytics
- more advanced hybrid ranking or materialization workflows

But that should be a **phase 2** decision, not the first implementation of live filtering.

---

## Implementation principle

Treat `sql_filter` as:

**a small, explicitly supported filter language**

not as:

- general SQL
- arbitrary DuckDB expressions
- a pass-through string to a backend engine

This preserves the existing request shape while keeping execution safe and predictable.

---

## Supported MVP filter surface

The first filtering implementation should support only the metadata fields already exposed in the dataset and API:

- `incident_id`
- `timestamp`
- `city_code`
- `doc_type`

Do **not** support filtering on:

- `text_content`
- `vector`
- computed expressions
- functions
- arbitrary casts
- joins
- subqueries

### Supported operators

The MVP should support:

- `=`
- `!=`
- `<`
- `<=`
- `>`
- `>=`
- `IN (...)`
- `AND`
- `OR`
- parentheses for grouping

Optional but reasonable for MVP:

- `NOT`

### Type rules

- `incident_id`, `city_code`, `doc_type` are string fields
- `timestamp` is a timestamp field and should be compared using RFC 3339 timestamp strings

### Example supported filters

```sql
city_code = 'NYC-TLC'
```

```sql
doc_type IN ('Insurance_Lapse_Report', 'Safety_Incident_Log')
```

```sql
city_code = 'NYC-TLC' AND doc_type = 'Insurance_Lapse_Report'
```

```sql
timestamp >= '2025-01-01T00:00:00Z' AND timestamp < '2026-01-01T00:00:00Z'
```

```sql
(city_code = 'NYC-TLC' OR city_code = 'SF-CPUC') AND doc_type != 'Data_Privacy_Request'
```

### Example unsupported filters

These should fail with `400`:

```sql
LOWER(city_code) = 'nyc-tlc'
```

```sql
text_content LIKE '%insurance%'
```

```sql
SELECT * FROM x
```

```sql
city_code = 'NYC-TLC'; DROP TABLE foo;
```

---

## Target execution model

The Lambda should execute filtering as:

1. parse and validate `sql_filter`
2. compile it to a Lance-compatible predicate string
3. apply the predicate to the dataset scanner before nearest-neighbor execution
4. run vector search with the requested projection
5. return filtered nearest results

Conceptually:

```text
request
  -> validate k / columns / filter length
  -> parse filter to AST
  -> compile AST to Lance predicate
  -> dataset.scan()
       .filter(predicate)
       .nearest(...)
       .project(...)
  -> stream batches
  -> serialize response
```

### Important product behavior

Filtering is part of candidate selection, not a post-response client-side trim.

That means:

- the nearest-neighbor search should only consider rows matching the filter predicate
- results should not be computed over the full dataset and then dropped afterward if avoidable

If Lance API limitations force a slightly different ordering internally, the externally visible behavior must still be:

**only matching rows appear in results**

---

## File-by-file implementation plan

### 1. Add a new module: `lambda-engine/src/filter.rs`

Create a new module responsible for:

- lexical validation / parsing
- AST representation
- semantic validation against allowed fields and types
- compilation to a Lance predicate string

Recommended responsibilities:

- `parse_filter(input: &str) -> Result<Option<FilterExpr>, ApiError>`
- `compile_filter(expr: &FilterExpr) -> Result<String, ApiError>`
- helper validation for timestamp literals and string literals

If the filter string is empty or whitespace-only:

- return `Ok(None)`

### 2. Register the module in `lambda-engine/src/lib.rs`

Add:

```rust
pub mod filter;
```

### 3. Extend `lambda-engine/src/search.rs`

This file should continue to own request validation and scanner construction, but filtering logic should be delegated to the new module.

Add the following integration points:

1. import the filter module
2. parse `req.sql_filter` after `k` validation
3. compile the validated filter AST into a predicate string
4. apply the predicate to the scanner before executing the ANN query

Recommended shape:

- keep `SearchRequest` as-is
- keep `validate()` responsible only for:
  - `k`
  - `sql_filter` length
- add a new function in `search.rs` that resolves an optional compiled predicate

Example conceptual flow:

```rust
let compiled_filter = crate::filter::parse_filter(&req.sql_filter)
    .and_then(|maybe| maybe.map(crate::filter::compile_filter).transpose())?;
```

Then when building the scanner:

```rust
let mut scan = dataset.scan();
if let Some(predicate) = compiled_filter.as_deref() {
    scan = scan.filter(predicate).map_err(map_lance_err)?;
}
```

Then continue with:

- `.nearest(...)`
- `.distance_metric(...)`
- `.use_index(true)`
- `.project(...)`
- `.try_into_stream()`

### 4. Update `lambda-engine/src/error.rs`

Add stable 400-level error codes for filter failures.

Recommended new codes:

- `INVALID_SQL_FILTER`
  Use for unsupported syntax, unsupported operators, unknown fields, or malformed expressions.

- `INVALID_FILTER_VALUE`
  Use for type errors such as malformed timestamps.

You may choose to collapse both into `INVALID_SQL_FILTER`, but if you want cleaner telemetry, keeping both is better.

The important thing is that:

- invalid filters are client errors
- they must not surface backend parser internals verbatim

### 5. Update `docs/API_CONTRACT.md`

Historically, this required changing the `sql_filter` description from:

- accepted but not applied

to:

- accepted and applied for the supported MVP grammar

Document:

- allowed fields
- allowed operators
- empty string behavior
- unsupported constructs returning `400`

### 6. Add tests in `lambda-engine/src/filter.rs`

This module should have its own unit tests for:

- empty filter
- simple equality
- `IN (...)`
- nested boolean expressions
- malformed strings
- unknown fields
- bad timestamp literal
- unsupported function calls
- unsupported semicolon / multi-statement input

### 7. Add integration-style tests in `lambda-engine/src/search.rs`

Add tests that verify:

- a parsed filter becomes a scanner predicate
- invalid filters produce the correct API error codes
- the request contract remains stable

If practical with a local test dataset, add true behavior tests showing that the filter changes the results returned by search.

---

## AST design

Use a typed AST instead of string manipulation.

Recommended shape:

```rust
pub enum FilterExpr {
    And(Box<FilterExpr>, Box<FilterExpr>),
    Or(Box<FilterExpr>, Box<FilterExpr>),
    Not(Box<FilterExpr>),
    Compare {
        field: FilterField,
        op: CompareOp,
        value: FilterValue,
    },
    In {
        field: FilterField,
        values: Vec<FilterValue>,
    },
}

pub enum FilterField {
    IncidentId,
    Timestamp,
    CityCode,
    DocType,
}

pub enum CompareOp {
    Eq,
    Ne,
    Lt,
    Lte,
    Gt,
    Gte,
}

pub enum FilterValue {
    String(String),
    Timestamp(String),
}
```

### Why typed AST matters

It prevents:

- unsafe string concatenation
- type confusion
- leaking unsupported syntax deeper into the execution path

It also makes later extension much cleaner.

---

## Parsing strategy

Use a small hand-rolled parser or a simple recursive-descent parser.

For the MVP, do **not** add a heavy parser generator unless truly needed.

### Grammar recommendation

Use this conceptual grammar:

```text
expr        := or_expr
or_expr     := and_expr ("OR" and_expr)*
and_expr    := unary_expr ("AND" unary_expr)*
unary_expr  := "NOT" unary_expr | primary
primary     := comparison | in_expr | "(" expr ")"
comparison  := ident comp_op literal
in_expr     := ident "IN" "(" literal ("," literal)* ")"
comp_op     := "=" | "!=" | "<" | "<=" | ">" | ">="
ident       := allowed field name
literal     := single-quoted string
```

### Literal rules

For MVP simplicity:

- require single-quoted string literals
- allow escaped single quotes if you want polish
- for `timestamp`, validate the literal parses as RFC 3339 before accepting it

---

## Compilation strategy

Once parsed and type-checked, compile the AST into a predicate string that Lance accepts.

### Key rule

Only compile from validated AST nodes.

Never pass through raw user text after parsing.

### Field mapping

Map AST fields directly to dataset column names:

- `FilterField::IncidentId -> "incident_id"`
- `FilterField::Timestamp -> "timestamp"`
- `FilterField::CityCode -> "city_code"`
- `FilterField::DocType -> "doc_type"`

### Literal escaping

Create a small helper that safely escapes single quotes in string literals before embedding them in the compiled predicate.

### Example compilation

Input:

```sql
city_code = 'NYC-TLC' AND doc_type = 'Insurance_Lapse_Report'
```

Compiled predicate:

```sql
(city_code = 'NYC-TLC') AND (doc_type = 'Insurance_Lapse_Report')
```

Input:

```sql
timestamp >= '2025-01-01T00:00:00Z'
```

Compiled predicate:

```sql
timestamp >= '2025-01-01T00:00:00Z'
```

---

## API behavior specification

### Empty filter

If `sql_filter` is empty or all whitespace:

- treat it as no filter
- do not error

### Unsupported syntax

Return:

- HTTP `400`
- code `INVALID_SQL_FILTER`

Message example:

```text
Unsupported sql_filter syntax. Allowed fields: incident_id, timestamp, city_code, doc_type.
```

### Invalid timestamp literal

Return:

- HTTP `400`
- code `INVALID_FILTER_VALUE`

Message example:

```text
Invalid timestamp literal in sql_filter. Expected RFC 3339.
```

### Unknown field

Return:

- HTTP `400`
- code `INVALID_SQL_FILTER`

### Filter too long

Keep the existing behavior:

- HTTP `400`
- code `SQL_FILTER_TOO_LONG`

---

## Recommended phased rollout

### Phase 1: MVP filter compiler

Ship:

- `=`
- `!=`
- `<`
- `<=`
- `>`
- `>=`
- `IN`
- `AND`
- `OR`
- parentheses

Only for:

- `incident_id`
- `timestamp`
- `city_code`
- `doc_type`

This phase is enough to make the product story real.

### Phase 2: polish and hardening

Add if needed:

- `NOT`
- better error messages with token position
- richer literal escaping
- dedicated integration tests with a real local Lance dataset fixture

### Phase 3: optional advanced filtering

Consider later:

- expanding supported fields
- introducing a structured filter object in the API
- DuckDB-backed metadata sidecar workflows

---

## Why not DuckDB first

DuckDB is attractive conceptually, but it is not the best first implementation here.

### Problems with DuckDB-first

1. The current crate does not even depend on `duckdb` yet
   - despite older planning docs, the current `Cargo.toml` does not include it

2. SQL semantics create product ambiguity
   - what SQL subset is allowed
   - what functions are allowed
   - what escaping rules exist
   - how timestamps are typed

3. It increases the critical-path complexity
   - more dependencies
   - more behavior to test
   - more ways for deploy/build/package to fail

4. It is not required to solve the current MVP gap

### Better long-term positioning

If you still want DuckDB in Trace, introduce it later for:

- analytics
- richer metadata workflows
- offline materialization
- sidecar indexing or reporting

not as the first implementation of HTTP request filtering.

---

## Acceptance criteria

This implementation is complete when all of the following are true:

1. `sql_filter` changes the set of rows considered for search
2. unsupported syntax fails with stable 400-level errors
3. only the allowed metadata fields can be filtered
4. timestamp filters are validated
5. the Lambda test suite covers parser, compiler, and request integration behavior
6. `docs/API_CONTRACT.md` documents the now-live filtering behavior
7. Trace can demo a real hybrid search query such as:

```text
Find NYC insurance lapse reports from 2025
```

with:

- semantic query vector
- `city_code = 'NYC-TLC'`
- `doc_type = 'Insurance_Lapse_Report'`
- time range filter on `timestamp`

---

## Suggested implementation order

Follow this order exactly:

1. create `filter.rs` with AST types
2. implement tokenizer and parser
3. implement semantic validation and compilation
4. add unit tests for parser/compiler
5. integrate compiled predicates into `search.rs`
6. add request-path tests
7. update `API_CONTRACT.md`
8. validate against a real seeded dataset

---

## Final recommendation

For the current codebase, the highest-confidence path is:

**constrained filter language -> typed AST -> Lance predicate compilation -> scanner-level filtering**

That gives Trace the hybrid-search behavior it needs now without overcomplicating the Lambda runtime or widening the API surface prematurely.
