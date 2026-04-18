# Project Trace — Current State

This document summarizes where the **Trace** repository stands today, grounded in the planning and specification material under [`docs/`](.) and in the code and artifacts present in the workspace. It is a snapshot for contributors and reviewers, not a marketing pitch.

---

## Product intent (from `README.md` and planning docs)

**Trace** is a **serverless-oriented, object-storage-native** semantic search stack: keep vectors and metadata in **Lance** on **S3**, wake compute on demand (target: **AWS Lambda** on **ARM64**), and combine **vector search (IVF-PQ)** with **SQL-style metadata filtering (DuckDB)**. The framing in [`README.md`](../README.md) and [`Codex_Trace_Init_Plan.md`](Codex_Trace_Init_Plan.md) emphasizes **near-zero idle cost**, **in-VPC / customer-account data residency**, and **agent-facing access** via **Model Context Protocol (MCP)**.

[`COMPREHENSIVE_PLAN.md`](COMPREHENSIVE_PLAN.md) frames a **5-day sprint** toward a demo: seed data to S3, Rust Lambda as the search kernel, Node MCP bridge, benchmarks and a small showcase UI, with guardrails (e.g. **256MB Lambda** target, **sub-800ms** queries, **`X-TRACE-API-KEY`** on the agent path).

---

## Documentation map (`docs/`)

| Document | Role |
| :--- | :--- |
| [`DATA_SPEC.md`](DATA_SPEC.md) | Canonical schema and content rules for the synthetic **“Uber Compliance & Audit”** Lance dataset (100k rows, IVF-PQ on `vector`, S3 bucket `trace-vault`). |
| [`RUST_CRATE_DOCS.md`](RUST_CRATE_DOCS.md) | Index of upstream Rust API docs for **`lance`**, **`duckdb`**, **`aws-sdk-s3`**. |
| [`cursor_prompt_trace.md`](cursor_prompt_trace.md) | Master build prompt: expected layout (`lambda-engine`, `mcp-bridge`, `scripts`), Lambda behavior, MCP tool shape, SAM `template.yaml`. |
| [`COMPREHENSIVE_PLAN.md`](COMPREHENSIVE_PLAN.md) | Day-by-day sprint checklist and delegation notes. |
| [`Codex_Trace_Init_Plan.md`](Codex_Trace_Init_Plan.md) | Executive architecture and challenge strategy (Michelangelo alignment, MCP as submission centerpiece). |
| [`RESEARCH_PLAN.md`](RESEARCH_PLAN.md) | Pre-build research and zero-code deliverables. |
| [`ALLOCATION_PLAN.md`](ALLOCATION_PLAN.md) | 14-day phased plan and token/tooling discipline. |
| [`FUTURE_ROADMAP.md`](FUTURE_ROADMAP.md) | Post-MVP ideas (cache layer, PII scrubbing, tiering, multimodal, SIMD). |
| [`CURSOR_BEST_PRACTICES.md`](CURSOR_BEST_PRACTICES.md), [`CODEX_BEST_PRACTICES.md`](CODEX_BEST_PRACTICES.md) | Tooling guidance for contributors. |

---

## Repository layout (what exists on disk)

| Path | Status |
| :--- | :--- |
| [`README.md`](../README.md) | Product narrative and link to `RUST_CRATE_DOCS.md`. |
| [`scripts/seed.py`](../scripts/seed.py) | **Implemented:** end-to-end seeding per [`DATA_SPEC.md`](DATA_SPEC.md) (Pandas → Lance via LanceDB, **IVF_PQ** on `vector`, optional S3 upload). |
| [`lambda-engine/`](../lambda-engine/) | **Scaffold:** Rust Lambda binary with **`lambda_runtime`**, **`aws-sdk-s3`**, **`lance`**, **`duckdb`** in [`Cargo.toml`](../lambda-engine/Cargo.toml); handler parses JSON, initializes clients, **does not yet open Lance on S3 or run DuckDB queries**. |
| `mcp-bridge/` | **Not present** (called for in [`cursor_prompt_trace.md`](cursor_prompt_trace.md)). |
| `template.yaml` / SAM | **Not present** in the repo root (called for in [`cursor_prompt_trace.md`](cursor_prompt_trace.md)). |
| [`lance_seed/`](../lance_seed/), [`_smoke_lance_seed/`](../_smoke_lance_seed/) | Local **`.lance`** dataset trees (indices, transactions, data blobs); useful for offline development. |

---

## Implementation status vs. specs

### Ingestion (`scripts/seed.py`)

- **Aligned** with [`DATA_SPEC.md`](DATA_SPEC.md): columns `incident_id`, `timestamp`, `city_code`, `doc_type`, `text_content`, `vector` (1536-D, random uniform for bulk seed), dictionaries and templates, IVF-PQ index with partition/sub-vector heuristics, upload to `s3://trace-vault/...` by default with `--skip-upload` for local-only runs.
- [`cursor_prompt_trace.md`](cursor_prompt_trace.md) additionally mentions **OpenAI embeddings** and slightly different field names in one checklist; the **checked-in script follows `DATA_SPEC.md`** (random vectors, `incident_id` / `city_code` / `doc_type`).

### Search kernel (`lambda-engine`)

- **Done:** Async handler, request parsing (direct JSON or API Gateway–style `body` string), dependency wiring for S3 / DuckDB / Lance types.
- **Not done (per plans):** S3 **range** reads, opening a **Lance dataset from an S3 URI**, **IVF-PQ search**, **DuckDB** metadata pre/post filtering, authentication (`X-TRACE-API-KEY`), performance/memory tuning, **`cargo lambda`** / release profile work noted in [`cursor_prompt_trace.md`](cursor_prompt_trace.md).

### Agent interface and IaC

- **MCP server** (`search_cold_archive`, embedding in bridge, API key): **not in repo**.
- **AWS SAM** stack (bucket, Lambda **arm64**, API Gateway): **not in repo**.

---

## Near-term backlog (derived from docs)

1. **Lambda:** Implement real search path: Lance on S3 + DuckDB filters + structured response; meet latency/memory targets in [`COMPREHENSIVE_PLAN.md`](COMPREHENSIVE_PLAN.md) / [`cursor_prompt_trace.md`](cursor_prompt_trace.md).
2. **`mcp-bridge`:** MCP tool + Lambda invocation + embedding service + key validation.
3. **SAM / CI:** `template.yaml`, deploy story, and benchmarking harness from the sprint plan.
4. **Optional:** Items in [`FUTURE_ROADMAP.md`](FUTURE_ROADMAP.md) after the MVP path is stable.

---

## How to use this file

Treat **`PROJECT_STATE.md`** as the **bridge between narrative docs and the repo**: when a doc says “we will build X,” this file should reflect whether **X** is **present, partial, or missing**. Update it when major components land or when specs diverge from code so the drift is visible in one place.
