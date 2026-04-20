# Project Trace - Current State

This document summarizes where the **Trace** repository stands as of **2026-04-20**, based on the code and artifacts currently present in the workspace. It is intended to be a reality-based snapshot for contributors, reviewers, and future planning.

This file should answer a simple question:

**What is actually implemented today, and what is still partial or missing?**

---

## Product intent

**Trace** is an **AWS-first, serverless, object-storage-native** semantic search system for archived enterprise data.

The current architecture is centered on:

- **Lance** datasets stored in **S3**
- a **Rust AWS Lambda** search kernel
- an **MCP bridge** for agent-facing retrieval
- a **SAM** deployment template for the HTTP API and Lambda packaging flow

The core product thesis remains:

- keep storage cheap
- wake compute on demand
- support hybrid retrieval over archived data
- expose the system to AI agents through MCP

Today, the repository is past the "scaffold only" stage. The main remaining work is finishing and proving the product end to end, especially around **metadata filtering**, **deployment validation**, and **benchmark-backed claims**.

---

## Current repo snapshot

| Path | Current status |
|------|----------------|
| `[README.md](../README.md)` | Present, but still more narrative than execution-oriented. |
| `[scripts/seed.py](../scripts/seed.py)` | Implemented local-plus-S3 Lance seeding flow with IVF-PQ index build, staging/promotion logic, and upload safety checks. |
| `[lambda-engine/](../lambda-engine/)` | Implemented Rust Lambda with request parsing, auth handling, Lance dataset open/search path, API response shaping, and tests. |
| `[mcp-bridge/](../mcp-bridge/)` | Present and implemented as a Node/TypeScript MCP server exposing `search_cold_archive`. |
| `[template.yaml](../template.yaml)` | Present and implemented as an AWS SAM template for Lambda + HTTP API deployment. |
| `[lance_seed/](../lance_seed/)`, `[_smoke_lance_seed/](../_smoke_lance_seed/)` | Local Lance dataset trees for development and smoke testing. |

---

## Implementation status by subsystem

### 1. Ingestion and dataset generation

**Status:** `implemented, but embedding strategy is still not fully aligned with the final demo path`

What exists now in `[scripts/seed.py](../scripts/seed.py)`:

- synthetic "Uber Compliance & Audit" dataset generation
- canonical fields:
  - `incident_id`
  - `timestamp`
  - `city_code`
  - `doc_type`
  - `text_content`
  - `vector`
- Lance table creation through LanceDB
- IVF-PQ index build on `vector`
- local-only mode and S3 upload mode
- staging-prefix uploads with manifest-last ordering
- promotion flow from staging to live prefix
- upload safety checks and environment guardrails

Important current limitation:

- the checked-in seed path still uses **random vectors**, which is fine for structural and performance work, but it is not yet the same as the intended **real embedding story** used by the MCP bridge.

Implication:

- the ingestion pipeline is real, but the final end-to-end demo path still needs a canonical, documented decision on embeddings.

### 2. Search kernel (`lambda-engine`)

**Status:** `partially implemented, with a real Lance-backed path`

What exists now:

- Rust Lambda bootstrap and handler wiring
- request parsing for:
  - direct invocation JSON
  - API Gateway HTTP API v2 payloads
- API error handling and JSON response envelopes
- optional `X-TRACE-API-KEY` enforcement for HTTP traffic
- environment/config parsing for dataset URI, payload size, query dimension, and auth behavior
- Lance dataset open-once behavior via cached runtime state
- Lance ANN search over the `vector` column
- projection handling for fields like:
  - `incident_id`
  - `timestamp`
  - `city_code`
  - `doc_type`
  - `text_content`
  - `_distance` mapped to `score`
- result serialization to the documented API shape
- a substantial Rust unit test suite

Verified local state:

- `cargo test` passes in `lambda-engine/`

What is still incomplete or unresolved:

- `sql_filter` is validated, but not yet applied to the search path
- the intended **hybrid retrieval** story is therefore still incomplete
- benchmark-backed proof for latency, memory, and cost is not yet recorded in-repo
- the architecture is still **AWS-specific**, not multicloud-ready

Important correction from earlier stale docs:

- the Lambda is **not** just a scaffold anymore
- the repo **does** open and query Lance datasets
- the main missing product behavior is **real filtering**, not basic search execution

### 3. MCP bridge (`mcp-bridge`)

**Status:** `implemented`

What exists now in `[mcp-bridge/src/index.ts](../mcp-bridge/src/index.ts)`:

- MCP stdio server setup
- `search_cold_archive` tool definition
- strict argument validation for:
  - `query_text`
  - `sql_filter`
  - `limit`
  - `include_text`
- OpenAI embedding generation
- mock embedding mode for development
- timeout handling
- one-retry behavior for transient network errors
- structured error handling for backend failures
- HTTP invocation of the deployed Trace search endpoint
- response validation for Lambda output shape

What is still incomplete or worth tightening:

- the bridge build path has not yet been fully verified in this local environment because Node toolchain setup is incomplete here
- the model-facing result cap and demo-facing behavior still need final product decisions
- bridge environment documentation should be consolidated and simplified

### 4. Infrastructure and deployment (`template.yaml`)

**Status:** `implemented, but not yet fully validated in this environment`

What exists now:

- AWS SAM template at `[template.yaml](../template.yaml)`
- Lambda configuration targeting:
  - `provided.al2023`
  - `arm64`
- HTTP API route for `POST /search`
- environment wiring for:
  - `TRACE_S3_BUCKET`
  - `TRACE_LANCE_PREFIX`
  - `TRACE_LANCE_S3_URI`
  - `TRACE_API_KEY_SECRET`
- IAM permissions for:
  - S3 object reads
  - S3 prefix listing
  - Secrets Manager access when configured
- X-Ray and logging support

What is still incomplete or unverified:

- this local machine does not currently have `sam` available, so `sam validate --lint` and `sam build` were not verified here
- the actual deployed golden path still needs to be exercised and documented

### 5. CI / build verification

**Status:** `partially verified`

What is known:

- Rust tests pass locally
- there is a GitHub Actions workflow for Rust checks and SAM packaging in `[.github/workflows/lambda-engine-ci.yml](../.github/workflows/lambda-engine-ci.yml)`

What is not yet fully verified in this environment:

- `npm run build` failed locally due missing/blocked Node toolchain setup
- `sam validate --lint` could not be run because `sam` is not installed here

Implication:

- the repository appears to be set up for broader verification, but this workstation snapshot has only confirmed the Rust side directly

---

## Architectural reality check

### What Trace is today

Trace is currently best described as:

**an AWS-first serverless semantic search MVP with a real Rust search kernel, a real MCP bridge, and a real SAM deployment path**

### What Trace is not yet

Trace is **not yet**:

- a completed hybrid-search product
- a fully validated deployed demo with benchmark evidence in-repo
- a multicloud architecture
- a multimodal ingestion/search platform
- a Docling-based ingestion system

Those are still roadmap items, not current-state claims.

---

## Biggest remaining gaps

These are the most important gaps between the current repo and the intended MVP:

1. **Metadata filtering is not yet live**
   The docs and code still indicate `sql_filter` is validated but not applied.

2. **End-to-end deployed proof is not yet documented**
   The repo has the pieces, but the golden path still needs to be exercised and captured clearly.

3. **Embedding alignment is still unresolved**
   Seeded vectors, MCP-generated embeddings, and the final demo path need one canonical story.

4. **Benchmark evidence is missing**
   The project thesis depends on cost and latency claims that should be backed by measurements.

5. **Documentation drift still exists**
   This file was stale before this update, and the README/setup story still needs cleanup.

---

## Current best next steps

The next best implementation priorities are now documented in:

- `[NEXT_STEPS_2026-04-18.md](NEXT_STEPS_2026-04-18.md)`

In short, the order should be:

1. implement real metadata filtering
2. prove deployed end-to-end correctness
3. align the embedding story
4. keep CI-equivalent checks green
5. validate benchmark and runtime guardrails
6. clean up docs and demo flow

---

## How to use this file

Treat `PROJECT_STATE.md` as the canonical answer to:

- what is already in the repo
- what is partially implemented
- what should not yet be claimed as complete

If a planning doc says "we will build X," this file should say whether **X** is:

- present
- partial
- missing

Update this file whenever a major subsystem crosses one of those boundaries.
