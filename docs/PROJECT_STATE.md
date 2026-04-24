# Trace project state

Last updated: 2026-04-23

## Summary

Trace is no longer just a planning repository. The codebase currently contains a working Rust Lambda search service, a working MCP bridge, a synthetic data generation pipeline, an AWS SAM deployment template, and a deployed proof-path runner with targeted tests.

The active code path supports:

- Lance-backed nearest-neighbor search
- constrained metadata filtering applied before vector search
- optional API-key enforcement for the HTTP API
- MCP-mediated natural-language search through embeddings

Against the active backlog in `docs/NEXT_STEPS.md`, the current status is:

- Step 1 (ingestion/retrieval story): implemented in code
- Step 2 (eval dataset path): complete
- Step 3 (deployed proof path): partially complete
- Steps 4, 7, 8, and 9: not implemented yet
- Steps 5 and 6: partially complete through early docs/tooling, but not finished as operator-ready systems

## What is implemented

### Search service

Implemented in `lambda-engine/`:

- HTTP API v2 and direct Lambda invoke request handling
- request size and JSON validation
- optional `X-TRACE-API-KEY` enforcement
- Lance dataset open and cached runtime access
- vector nearest-neighbor search over `vector`
- constrained `sql_filter` parsing and compiled predicate application
- projection control with optional `text_content`
- unit and integration-style tests covering filtering and request behavior

### MCP bridge

Implemented in `mcp-bridge/`:

- MCP server bootstrapped on stdio transport
- `search_cold_archive` tool
- OpenAI embedding generation for natural-language queries
- mock embedding and mock search modes for local testing
- request/response validation around the Lambda HTTP API
- CI build coverage

### Data generation

Implemented in `scripts/seed.py`:

- deterministic synthetic compliance dataset generation
- explicit `openai` and `random` embedding modes
- source parquet and seed-manifest output
- Lance dataset creation and IVF-PQ indexing when the dataset is large enough to train it
- local output generation
- optional S3 staging upload and promotion flow
- CLI validation and local disk-space preflight checks

Implemented in `scripts/validate_eval_dataset.py`:

- small curated local query validation against embedding-backed Lance datasets before upload
- filtered-query validation cases for metadata-constrained retrieval sanity checks under the repo's restricted filter grammar
- manifest checks for `openai` embedding mode, expected vector dimension, and query/dataset embedding-model consistency
- case evaluation based on top-result metadata alignment plus minimum top-k matching counts, with optional all-results metadata checks for filtered cases
- JSON validation report output plus seed-manifest stamping of the latest local validation summary

Important current behavior:

- `openai` mode is now the default path for local eval/demo dataset generation and uses `text-embedding-3-small` at `1536` dimensions
- `random` mode remains available as an explicit smoke/infrastructure path and should not be used as evidence of semantic retrieval quality
- a fresh embedding-backed local eval dataset has been generated successfully under `.test-tmp/eval-seed/`
- the corresponding local validation report passed `7/7` cases and was recorded in the seed manifest
- the eval dataset is now uploaded to `s3://trace-vault/trace/eval/lance/`

### Deployed proof path

Implemented in `scripts/prove_deployed_path.py`, `scripts/proof_mcp_stdio.py`, `fixtures/deployed/`, and `tests/`:

- stack output and deployed search URL resolution
- deployed `POST /search` execution
- MCP stdio traversal through `mcp-bridge`
- golden-case loading and proof-oriented assertions
- per-run artifacts and manifest writing
- scrubbed stable-fixture promotion helpers
- unit coverage for runner and MCP stdio failure paths

Current deployed proof status:

- the first successful eval-stack proof run completed at `artifacts/validation-runs/20260423T233528Z`
- that run used stack `trace-eval`, dataset `s3://trace-vault/trace/eval/lance`, region `us-east-1`, and model `text-embedding-3-small`
- all proof cases in that run passed for both direct HTTP and MCP traversal

### Deployment

Implemented in `template.yaml`:

- ARM64 Lambda packaging via SAM and `cargo-lambda`
- HTTP API `POST /search`
- CORS configuration
- S3 read permissions for the configured dataset prefix (parameters `TraceDataBucketName` / `TraceLancePrefix`; stack output `TraceDatasetS3Uri`)
- optional Secrets Manager-backed API key injection
- stack outputs for `HttpApiUrl`, `SearchUrl`, `TraceDatasetS3Uri`, and `TraceSearchFunctionArn`

Deployed in AWS (`us-east-1`):

- `trace-smoke` points at `s3://trace-vault/uber_audit.lance`
- `trace-eval` points at `s3://trace-vault/trace/eval/lance`
- `trace-smoke` search URL: `https://u73d8vk2yl.execute-api.us-east-1.amazonaws.com/search`
- `trace-eval` search URL: `https://kp2kjz4fkg.execute-api.us-east-1.amazonaws.com/search`

## What is not fully done

- There is no user-facing web application in this repository
- `fixtures/deployed/examples/` exists, but representative committed stable fixtures have not been generated yet
- There is not yet a single shared or production-facing stack beyond the current `trace-smoke` and `trace-eval` layout
- There is not yet a labeled retrieval-evaluation harness with metrics such as `Recall@k` or `Precision@k`
- There are not yet benchmark artifacts for latency, memory footprint, or cost-per-query
- There is not yet a completed deployment history for smoke/eval stacks, although `docs/DEPLOYMENT_RUNBOOK.md` now documents that workflow

## Current repo guidance

- Use `codex/clean-main-candidate` as the clean promotion branch when replacing or merging into `main`
- Treat `docs/deprecated/` as historical context, not active reference material
- Do not recommit generated Lance dataset directories
- Treat `s3://trace-vault/uber_audit.lance/` as the rollback-safe random-vector smoke dataset and `s3://trace-vault/trace/eval/lance/` as the active embedding-backed eval dataset
