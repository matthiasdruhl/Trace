# Trace architecture

Trace is a purpose-built archive investigation system for regulatory,
compliance, and trust and safety operators. The architecture matters because it
supports one specific product promise: investigators should be able to move
from a messy natural-language case request to a defensible set of evidence
without losing operational control.

## Overview

Trace is a serverless investigation workflow backbone built around a Lance
dataset stored on S3.

The active runtime path is:

1. A client or agent submits a search request.
2. The MCP bridge optionally embeds natural-language text into a query vector.
3. The Rust Lambda validates the request, enforces optional API key auth, opens the Lance dataset, applies a constrained metadata filter when present, and runs nearest-neighbor search.
4. Results are returned as JSON over API Gateway HTTP API v2 or direct Lambda invoke.

In product terms, this means Trace lets an investigator search by intent first,
then narrow the result set by city, document type, or time without falling back
to brittle keyword-only workflows, and sets up the evidence for a later
explanation or handoff layer.

The repo also contains an operator-oriented proof path used to validate that deployed HTTP and MCP traversal behave correctly against a live stack.

## Components

### `scripts/seed.py`

The seed script generates synthetic compliance-style records with this schema:

- `incident_id`
- `timestamp`
- `city_code`
- `doc_type`
- `text_content`
- `vector`

It writes a source parquet file, generates vectors in either `openai` or
`random` mode, writes a seed manifest, builds a Lance table locally, and can
optionally upload to S3 using a staging-prefix then promote flow.

Current behavior:

- `openai` is the default embedding mode for local eval/demo dataset generation
- `random` remains an explicit smoke/infrastructure mode
- the embedding-backed eval dataset is now live at `s3://trace-vault/trace/eval/lance/`

### `lambda-engine/`

The Rust Lambda contains the runtime search path:

- request parsing for API Gateway and direct invoke
- optional HTTP API key enforcement
- environment validation and S3/Lance configuration
- constrained `sql_filter` parsing and compilation
- Lance scan + vector nearest-neighbor search
- JSON response shaping and sanitized error handling

The Lambda is the source of truth for the public search contract.

### `mcp-bridge/`

The MCP bridge exposes a single tool:

- `search_cold_archive`

It validates tool arguments, generates embeddings through OpenAI unless mock
mode is enabled, calls the deployed Trace search endpoint, and returns the
normalized JSON response to the MCP client. This is the natural place to expose
an AI-assisted investigation experience rather than only a bare retrieval call.

### `scripts/prove_deployed_path.py` and `scripts/proof_mcp_stdio.py`

These scripts provide deployment-proof orchestration:

- resolve deployed stack outputs and runtime context
- call deployed `POST /search`
- invoke `mcp-bridge` over stdio JSON-RPC for the same golden cases
- assert contract-level correctness for response shape, expected ids, and narrow proof-oriented filter behavior
- write per-run manifests and artifacts
- optionally promote scrubbed stable fixtures into `fixtures/deployed/examples/`

### `template.yaml`

The SAM template provisions:

- an ARM64 Rust Lambda using `provided.al2023`
- an HTTP API with `POST /search`
- S3 read permissions scoped to the configured Lance prefix (parameters `TraceDataBucketName` and `TraceLancePrefix`, which set `TRACE_LANCE_S3_URI` and matching IAM)
- optional Secrets Manager-backed API key injection
- stack outputs for `HttpApiUrl`, `SearchUrl`, `TraceDatasetS3Uri`, and `TraceSearchFunctionArn`

## Search execution model

The current search path is Lance-first:

- open the configured dataset URI
- compile and apply a constrained metadata predicate when `sql_filter` is present
- run nearest-neighbor search on the `vector` column with L2 distance
- project the allowed columns plus `_distance`
- serialize results into the public JSON envelope

## Filtering model

`sql_filter` is a historical field name, but it now maps to a constrained filter language rather than arbitrary SQL.

Allowed filter fields:

- `incident_id`
- `timestamp`
- `city_code`
- `doc_type`

Allowed operators:

- `=`, `!=`, `<`, `<=`, `>`, `>=`
- `IN (...)`
- `AND`, `OR`, `NOT`
- parentheses for grouping

The Lambda parses the filter into a typed AST and compiles it into a predicate string for Lance/DataFusion. Raw user text is not passed through directly.

## Active constraints

- Default vector dimension is `1536`
- Search limit is capped at `50`
- Payload size defaults to `256 KiB`
- Search is tuned for S3-backed Lance datasets, not local interactive dashboards
- The seed script keeps `1536`-dimensional output so it stays aligned with the current Lambda and MCP bridge
- The current deployed smoke dataset is `s3://trace-vault/uber_audit.lance/`
- The current deployed eval dataset is `s3://trace-vault/trace/eval/lance/`

## Current gaps

- No end-user UI is included in this repository
- The current MCP bridge exposes retrieval but not yet a richer investigation handoff or explanation flow
- There are not yet committed polished comparison artifacts or screenshots for the main demo story
