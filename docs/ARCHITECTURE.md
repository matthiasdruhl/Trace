# Trace architecture

## Overview

Trace is a serverless semantic search stack built around a Lance dataset stored on S3.

The active runtime path is:

1. A client or agent submits a search request.
2. The MCP bridge optionally embeds natural-language text into a query vector.
3. The Rust Lambda validates the request, enforces optional API key auth, opens the Lance dataset, applies a constrained metadata filter when present, and runs nearest-neighbor search.
4. Results are returned as JSON over API Gateway HTTP API v2 or direct Lambda invoke.

## Components

### `scripts/seed.py`

The seed script generates synthetic compliance-style records with this schema:

- `incident_id`
- `timestamp`
- `city_code`
- `doc_type`
- `text_content`
- `vector`

It writes a Lance table locally, builds an IVF-PQ index over `vector`, and can optionally upload to S3 using a staging-prefix then promote flow.

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

It validates tool arguments, generates embeddings through OpenAI unless mock mode is enabled, calls the deployed Trace search endpoint, and returns the normalized JSON response to the MCP client.

### `template.yaml`

The SAM template provisions:

- an ARM64 Rust Lambda using `provided.al2023`
- an HTTP API with `POST /search`
- S3 read permissions for the configured Lance prefix
- optional Secrets Manager-backed API key injection

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
- The seed script currently generates random vectors for synthetic data, which is sufficient for structural testing but not a production embedding pipeline

## Current gaps

- No end-user UI is included in this repository
- The seed script does not generate real semantic embeddings
- Deployment validation still depends on the target AWS environment and dataset availability
