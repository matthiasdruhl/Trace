# Trace project state

Last updated: 2026-04-22

## Summary

Trace is no longer just a planning repository. The codebase currently contains a working Rust Lambda search service, a working MCP bridge, a synthetic data generation pipeline, an AWS SAM deployment template, and a deployed proof-path runner with targeted tests.

The active code path supports:

- Lance-backed nearest-neighbor search
- constrained metadata filtering applied before vector search
- optional API-key enforcement for the HTTP API
- MCP-mediated natural-language search through embeddings

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

Important current behavior:

- `openai` mode is now the default path for local eval/demo dataset generation and uses `text-embedding-3-small` at `1536` dimensions
- `random` mode remains available as an explicit smoke/infrastructure path and should not be used as evidence of semantic retrieval quality

### Deployed proof path

Implemented in `scripts/prove_deployed_path.py`, `scripts/proof_mcp_stdio.py`, `fixtures/deployed/`, and `tests/`:

- stack output and deployed search URL resolution
- deployed `POST /search` execution
- MCP stdio traversal through `mcp-bridge`
- golden-case loading and proof-oriented assertions
- per-run artifacts and manifest writing
- scrubbed stable-fixture promotion helpers
- unit coverage for runner and MCP stdio failure paths

### Deployment

Implemented in `template.yaml`:

- ARM64 Lambda packaging via SAM and `cargo-lambda`
- HTTP API `POST /search`
- CORS configuration
- S3 read permissions for the configured dataset prefix (parameters `TraceDataBucketName` / `TraceLancePrefix`; stack output `TraceDatasetS3Uri`)
- optional Secrets Manager-backed API key injection
- stack outputs for `HttpApiUrl`, `SearchUrl`, `TraceDatasetS3Uri`, and `TraceSearchFunctionArn`

## What is not fully done

- There is no user-facing web application in this repository
- A new embedding-backed eval dataset has not yet been uploaded to `s3://trace-vault/trace/eval/lance/`
- The deployed stack has not yet been repointed away from the current smoke dataset at `s3://trace-vault/uber_audit.lance/`
- A real embedding-backed S3 validation run has not yet been recorded
- `fixtures/deployed/examples/` exists, but representative committed stable fixtures have not been generated yet

## Current repo guidance

- Use `codex/clean-main-candidate` as the clean promotion branch when replacing or merging into `main`
- Treat `docs/deprecated/` as historical context, not active reference material
- Do not recommit generated Lance dataset directories
- Treat `s3://trace-vault/uber_audit.lance/` as the current random-vector smoke dataset until the eval prefix is populated and validated
