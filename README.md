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

Validate the embedding-backed local eval dataset before upload:

```bash
set OPENAI_API_KEY=...
python scripts/validate_eval_dataset.py --output-dir lance_seed --table-name uber_audit
```

That command runs a small curated set of local query and filtered-query sanity
cases from `fixtures/eval/local_validation_cases.json`, writes
`<output_dir>/<table>.eval-validation.json`, and records the latest validation
summary back into the seed manifest for auditability before S3 promotion. The
current validator is a local gate for an `openai` manifest, manifest/query
model alignment, `1536`-dimension consistency, the repo's restricted
`sql_filter` syntax, and a few expected retrieval patterns; it is not a full
relevance harness, benchmark corpus, or proof of deployed-path equivalence.

Run the local retrieval relevance harness:

```bash
set OPENAI_API_KEY=...
python scripts/evaluate_retrieval.py --output-dir .test-tmp/eval-seed --table-name uber_audit --cases-path fixtures/eval/retrieval_relevance_cases.json
```

That command scores three local methods on a small labeled corpus:

- the harness's local `trace_prefilter_vector` method
- a keyword-only lexical baseline
- a `vector_postfilter` baseline that retrieves a configurable candidate pool
  before applying the filter in Python

Before scoring, the harness validates that every labeled `incident_id` exists
in the source dataset and that filtered-case labels satisfy the case filter.
It then writes a JSON report plus a Markdown summary under
`artifacts/evaluations/<run_id>/`.

This is local retrieval evidence only. It does not prove deployed-path
equivalence, and it should not be treated as a broad retrieval benchmark beyond
the small local labeled corpus.

Generated outputs under the selected `output_dir` such as `lance_seed/`,
`_smoke_lance_seed/`, `<table>.source.parquet`, and
`<table>.seed-manifest.json` should remain untracked.

Current local status:

- a fresh embedding-backed local eval dataset has been generated under `.test-tmp/eval-seed/`
- the corresponding local validation run passed `7/7` curated cases
- the first local retrieval evaluation run completed under `artifacts/evaluations/20260424T062035Z/`
- the eval dataset is now uploaded to `s3://trace-vault/trace/eval/lance/`
- the smoke stack `trace-smoke` is deployed in `us-east-1`
- the eval stack `trace-eval` is deployed in `us-east-1`
- the first deployed proof run passed against the eval stack

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
- the eval dataset is live at `s3://trace-vault/trace/eval/lance/`
- `trace-smoke` search URL: `https://u73d8vk2yl.execute-api.us-east-1.amazonaws.com/search`
- `trace-eval` search URL: `https://kp2kjz4fkg.execute-api.us-east-1.amazonaws.com/search`
- the first eval proof run passed and wrote artifacts under `artifacts/validation-runs/20260423T233528Z`
- representative stable fixtures are committed under `fixtures/deployed/examples/`

## Documentation map

- `docs/ARCHITECTURE.md`: component-level system overview
- `docs/API_CONTRACT.md`: request, response, auth, and filter grammar reference
- `docs/DATA_SPEC.md`: synthetic dataset schema and seed script behavior
- `docs/DEPLOYMENT_RUNBOOK.md`: end-to-end deployment, upload, proof, and rollback checklist
- `docs/deployed-proof-runbook.md`: how to run the deployed proof path and interpret artifacts
- `docs/PROJECT_STATE.md`: current implementation snapshot
- `docs/NEXT_STEPS.md`: active prioritized backlog
- `docs/retrieval-eval-runbook.md`: how to run the local labeled relevance harness and interpret its metrics
- `docs/S3_MIGRATION.md`: current smoke-vs-eval S3 migration plan and actual migration status
- `docs/RUST_CRATE_DOCS.md`: external Rust dependency documentation index
- `docs/features/deployed-proof-path.md`: feature spec for the deployed proof-path implementation

Superseded planning docs and older README/state snapshots are preserved in `docs/deprecated/` with timestamped filenames.
