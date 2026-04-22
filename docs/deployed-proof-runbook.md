# Deployed proof path (operator runbook)

Last updated: 2026-04-22

This runbook covers the deployed-proof workflow: prove the deployed Trace stack
with direct `POST /search` and the MCP bridge tool `search_cold_archive`, and
capture artifacts under `artifacts/validation-runs/`.

Full scope and deferred work are defined in [features/deployed-proof-path.md](features/deployed-proof-path.md).

## S3 datasets: smoke vs eval (trace-vault)

The shared bucket **`trace-vault`** holds a **random-vector smoke dataset** at **`s3://trace-vault/uber_audit.lance/`** (old random-vector seed script). Treat it as **smoke / infra only**—**not** eval data and **not** proof of semantic retrieval quality.

| Role | URI | Operator rule |
| --- | --- | --- |
| **Random-vector smoke / infra** | `s3://trace-vault/uber_audit.lance/` | **Preserve** at this prefix. Do **not** move this tree into `trace/eval/lance/`, do **not** overwrite it in place for “migration,” and do **not** describe it as eval data. **Rollback** = repoint stack/Lambda back to this URI. |
| **Embedding-backed eval** | `s3://trace-vault/trace/eval/lance/` | Generate locally, upload **new** embedding-backed objects here, **validate**, **then** repoint Lambda / stack config from smoke to this prefix. |

Full migration sequence (preserve → label smoke → local eval build → upload → validate → repoint → keep smoke for rollback) and **why a new prefix is safer than in-place mutation** (cache/cutover clarity) are in [S3_MIGRATION.md](S3_MIGRATION.md) (*Operator sequence (trace-vault → embedding eval)*).

Until you cut over, a deployed stack may still point at **`uber_audit.lance/`**; the proof runner remains valid for **path** verification (`POST /search`, filters, MCP). Golden cases are **not** retrieval-quality benchmarks—see [features/deployed-proof-path.md](features/deployed-proof-path.md#golden-cases).

## Prerequisites

- **AWS CLI** configured for the account and region where the stack runs (`aws sts get-caller-identity` works).
- **Python 3** with script dependencies: `pip install -r scripts/requirements.txt -c scripts/constraints.txt` (includes `boto3` for stack resolution).
- **Node.js 18+** and a built MCP bridge: from the repo root, `cd mcp-bridge && npm install && npm run build` (produces `mcp-bridge/dist/index.js`).
- **Dataset** already uploaded to the bucket/prefix your stack uses (see `template.yaml` parameters `TraceDataBucketName` / `TraceLancePrefix`, or `TRACE_LANCE_S3_URI`).
- **Embeddings** for real runs: `OPENAI_API_KEY` set (same model family as the deployed Lambda dimension, usually `text-embedding-3-small` and length 1536). For structural smoke only, use `--mock-embeddings`: HTTP uses a deterministic query vector, and the proof run sets the bridge env `USE_MOCK_EMBEDDINGS` for MCP. Rankings may differ between HTTP and MCP in that mode.
- **HTTP auth**: if the stack uses an API key secret, set `TRACE_API_KEY` or `TRACE_MCP_API_KEY` to match the deployed secret.

## Resolve context

The proof runner can pull **SearchUrl** (and dataset URI from stack parameters) from CloudFormation when you pass **`--stack-name`** and a **region** (`--region` or `AWS_REGION`).

You can override the search URL with **`--search-url`** / `TRACE_SEARCH_URL`. The manifest still needs a **dataset URI**: use **`--dataset-uri`** / `TRACE_LANCE_S3_URI`, or rely on stack parameters `TraceDataBucketName` + `TraceLancePrefix`.

If `TraceSearchFunctionArn` is present on the stack, the runner reads **`TRACE_QUERY_VECTOR_DIM`** from the deployed Lambda so the proof script matches runtime dimension expectations.

## Run the proof

From the repository root:

```bash
python scripts/prove_deployed_path.py \
  --stack-name YOUR_STACK \
  --region us-east-1 \
  --repo-root .
```

Or with explicit URLs (no stack lookup):

```bash
set TRACE_LANCE_S3_URI=s3://trace-vault/uber_audit.lance/
set TRACE_SEARCH_URL=https://xxxx.execute-api.us-east-1.amazonaws.com/search
set OPENAI_API_KEY=...
python scripts/prove_deployed_path.py --repo-root .
```

Use the URI your stack actually reads (smoke: `s3://trace-vault/uber_audit.lance/`; after eval upload and cutover: `s3://trace-vault/trace/eval/lance/`). For other buckets, substitute bucket and prefix accordingly.

### Useful flags

| Flag | Purpose |
| --- | --- |
| `--mock-embeddings` | No OpenAI calls for HTTP vectors; sets bridge `USE_MOCK_EMBEDDINGS` for MCP. Structural smoke only. |
| `--skip-mcp` | HTTP-only proof. |
| `--dry-run` | Load cases and resolve context; no HTTP/MCP calls. |
| `--write-stable-fixtures` | After success, write scrubbed examples to `fixtures/deployed/examples/` (see `--stable-fixture-cases`). Requires MCP artifacts for each promoted case (do not combine with `--skip-mcp`). |

## Artifacts

Each run writes:

- `artifacts/validation-runs/<run_id>/manifest.json` - `api_auth_mode` reflects the deployed stack when `--stack-name` is used (from `TraceApiKeySecretRef`); `local_api_key_supplied` records whether this run passed a key (see [features/deployed-proof-path.md](features/deployed-proof-path.md#per-run-manifest))
- `artifacts/validation-runs/<run_id>/http/<case_id>.request.json` and `.response.json`
- `artifacts/validation-runs/<run_id>/mcp/<case_id>.request.json` and `.response.json`

Stable promoted examples (optional): `fixtures/deployed/examples/http_<case_id>.json` and `mcp_<case_id>.json` with volatile fields removed or replaced (for example `took_ms`, request ids, real URLs).

## Golden cases

Cases live in `fixtures/deployed/golden_cases.json`. They are **proof-oriented** (non-empty results, optional post-hoc checks on returned rows), not retrieval-quality evaluation.

**`require_filter_match`:** When true, the runner only checks that each result row's `city_code` and `doc_type` match **equality** conditions of the form `field = 'literal'` found in the case's `sql_filter` string (quoted literals, `''` escape supported). It does **not** re-validate the full `sql_filter` grammar ([`sql_filter` in API_CONTRACT.md](API_CONTRACT.md#sql_filter-grammar)); the Lambda still enforces that. The proof runner does **not** assert `IN (...)`, ranges, `OR` / `NOT`, or other shapes. Cases that rely on those operators should keep `require_filter_match` false and still prove the path by sending the filter and requiring non-empty results (see `filtered-doc-type-in` in the golden fixture).

## Assumptions

- The MCP bridge is invoked via **stdio** using the same newline-delimited JSON-RPC as the official MCP SDK (see `scripts/proof_mcp_stdio.py`).
- Operators building the bridge once per machine is acceptable; CI that only unit-tests scrubbing/parsing does not need a built `dist/` unless exercising MCP integration.
