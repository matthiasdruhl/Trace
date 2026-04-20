# Trace project state

Last updated: 2026-04-20

## Summary

Trace is no longer just a planning repository. The codebase currently contains a working Rust Lambda search service, a working MCP bridge, a synthetic data generation pipeline, and an AWS SAM deployment template.

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

- synthetic compliance dataset generation
- Lance dataset creation and IVF-PQ indexing
- local output generation
- optional S3 staging upload and promotion flow
- CLI validation and local disk-space preflight checks

### Deployment

Implemented in `template.yaml`:

- ARM64 Lambda packaging via SAM and `cargo-lambda`
- HTTP API `POST /search`
- CORS configuration
- S3 read permissions for the configured dataset prefix
- optional Secrets Manager-backed API key injection

## What is not fully done

- There is no user-facing web application in this repository
- The synthetic seed script uses random vectors rather than a production embedding pipeline
- End-to-end deployed validation still depends on a real AWS environment and a populated S3 dataset
- Documentation is now aligned to the codebase, but deployment playbooks and benchmark evidence can still be improved

## Current repo guidance

- Use `codex/clean-main-candidate` as the clean promotion branch when replacing or merging into `main`
- Treat `docs/deprecated/` as historical context, not active reference material
- Do not recommit generated Lance dataset directories
