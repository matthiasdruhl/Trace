# Trace

Trace is an AWS-first semantic search system for archived data stored in Lance format on S3. The current repository contains:

- a Rust Lambda search engine in `lambda-engine/`
- a Node/TypeScript MCP bridge in `mcp-bridge/`
- a Python seeding pipeline in `scripts/`
- a deployed proof runner and MCP stdio helper in `scripts/`
- an AWS SAM template in `template.yaml`

The current implementation supports Lance-backed nearest-neighbor search, constrained metadata filtering, API key or IAM-only HTTP access, and an MCP bridge that embeds natural-language queries before calling the search API.

## Repository layout

- `lambda-engine/`: Rust Lambda runtime, request validation, filtering, and Lance search path
- `mcp-bridge/`: MCP server exposing `search_cold_archive`
- `scripts/`: synthetic dataset generation and optional S3 upload/promotion flow
- `docs/`: active reference docs plus a `deprecated/` archive for superseded planning material
- `template.yaml`: SAM deployment template for the Lambda and HTTP API

## Quick start

### 1. Seed a local dataset

`scripts/seed.py` now generates a deterministic synthetic source corpus, writes
`<output_dir>/<table>.source.parquet` and
`<output_dir>/<table>.seed-manifest.json`, and supports two explicit vector
modes:

- `openai` (default): real embeddings for eval/demo datasets
- `random`: deterministic smoke/infra vectors only

Install Python dependencies:

```bash
pip install -r scripts/requirements.txt -c scripts/constraints.txt
```

Generate a small random-vector smoke dataset:

```bash
python scripts/seed.py --embedding-mode random --rows 2000 --output-dir _smoke_lance_seed --force
```

Generate the default embedding-backed local dataset:

```bash
set OPENAI_API_KEY=...
python scripts/seed.py --force
```

The default run uses `text-embedding-3-small` and keeps the dataset at 1536
dimensions to match the current Lambda and MCP bridge expectations.

Generated outputs under the selected `output_dir` such as `lance_seed/`,
`_smoke_lance_seed/`, `<table>.source.parquet`, and
`<table>.seed-manifest.json` should remain untracked.

### 2. Validate the Rust Lambda

```bash
cd lambda-engine
cargo test
```

### 3. Build the MCP bridge

```bash
cd mcp-bridge
npm install
npm run build
```

## Runtime configuration

Important Lambda environment variables:

- `TRACE_LANCE_S3_URI`: canonical `s3://bucket/prefix` dataset location
- `TRACE_S3_BUCKET` and `TRACE_LANCE_PREFIX`: fallback pair if `TRACE_LANCE_S3_URI` is unset

When deployed with SAM (`template.yaml`), **`TraceDataBucketName`** and **`TraceLancePrefix`** populate all three variables and the S3 IAM policy together; override the prefix parameter (or pass it at deploy) to cut over to a new dataset location without code changes. Stack output **`TraceDatasetS3Uri`** reflects the resolved URI.
- `TRACE_QUERY_VECTOR_DIM`: expected embedding dimension, default `1536`
- `TRACE_MAX_PAYLOAD_BYTES`: request body limit, default `262144`
- `TRACE_API_KEY_SECRET`: optional HTTP API key secret; blank means IAM-only mode

Important MCP bridge environment variables:

- `TRACE_SEARCH_URL`: deployed HTTP search endpoint
- `OPENAI_API_KEY`: required unless `USE_MOCK_EMBEDDINGS=true`
- `OPENAI_EMBEDDING_MODEL`: defaults to `text-embedding-3-small`
- `TRACE_QUERY_VECTOR_DIM`: optional cross-check against the embedding model dimension
- `TRACE_MCP_MOCK`: return mock search responses instead of calling the endpoint
- `USE_MOCK_EMBEDDINGS`: generate zero-vectors for local testing only

## Current behavior

- Search route: `POST /search`
- Transport: API Gateway HTTP API v2 or direct Lambda invoke
- Result limit: defaults to `10`, capped at `50`
- Metadata filter: constrained `sql_filter` grammar over `incident_id`, `timestamp`, `city_code`, and `doc_type`
- Text projection: `include_text: true` adds `text_content` to results

## Proof tooling

The repo now includes deployed-proof tooling for the later end-to-end validation milestone:

- `scripts/prove_deployed_path.py`: validates deployed `POST /search` and MCP traversal, writes per-run artifacts, and can promote scrubbed stable fixtures
- `scripts/proof_mcp_stdio.py`: stdio JSON-RPC helper for exercising `mcp-bridge` as a subprocess from the proof runner
- `fixtures/deployed/golden_cases.json`: proof-oriented golden cases
- `fixtures/deployed/examples/`: committed location for stable scrubbed examples

Current status:

- the proof runner and tests are implemented
- the current smoke dataset is `s3://trace-vault/uber_audit.lance/`
- the future eval target is `s3://trace-vault/trace/eval/lance/`
- a new embedding-backed eval dataset has not been uploaded yet
- SAM/Lambda has not been repointed to the eval prefix yet
- representative stable fixtures have not been committed yet

## Documentation map

- `docs/ARCHITECTURE.md`: component-level system overview
- `docs/API_CONTRACT.md`: request, response, auth, and filter grammar reference
- `docs/DATA_SPEC.md`: synthetic dataset schema and seed script behavior
- `docs/deployed-proof-runbook.md`: how to run the deployed proof path and interpret artifacts
- `docs/PROJECT_STATE.md`: current implementation snapshot
- `docs/NEXT_STEPS.md`: active prioritized backlog
- `docs/S3_MIGRATION.md`: current smoke-vs-eval S3 migration plan and actual migration status
- `docs/RUST_CRATE_DOCS.md`: external Rust dependency documentation index
- `docs/features/deployed-proof-path.md`: feature spec for the deployed proof-path implementation

Superseded planning docs and older README/state snapshots are preserved in `docs/deprecated/` with timestamped filenames.
