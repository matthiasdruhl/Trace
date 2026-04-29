# Deployed proof path (operator runbook)

Last updated: 2026-04-29

This runbook covers the deployed-proof workflow: prove the deployed Trace stack
with direct `POST /search` and the MCP bridge tool `search_cold_archive`, and
capture artifacts under `artifacts/validation-runs/`.

Full scope and deferred work are defined in
[features/deployed-proof-path.md](features/deployed-proof-path.md).

Use
[docs/DEPLOYMENT_RUNBOOK.md](C:/Users/matth/Projects/Trace/Trace/docs/DEPLOYMENT_RUNBOOK.md)
for first-time stack creation, dataset refresh, redeploys, and rollback. Use
that runbook as the canonical rerun entrypoint. Use this document only after
you have started from the deployment workflow and need proof-specific flags,
acceptance rules, artifact interpretation, or stable fixture promotion.

## Dataset context reference

Use
[docs/DEPLOYMENT_RUNBOOK.md](C:/Users/matth/Projects/Trace/Trace/docs/DEPLOYMENT_RUNBOOK.md)
for the authoritative dataset refresh, promotion, and rollout workflow. This
section is only a proof-specific reference for dataset roles.

| Role | URI | Operator rule |
| --- | --- | --- |
| **Random-vector smoke / infra** | `s3://trace-vault/uber_audit.lance/` | **Preserve** at this prefix. Do **not** move this tree into `trace/eval/lance/`, do **not** overwrite it in place for "migration", and do **not** describe it as eval data. **Rollback** = repoint stack/Lambda back to this URI. |
| **Embedding-backed eval** | `s3://trace-vault/trace/eval/lance/` | Generate locally, upload **new** embedding-backed objects here, **validate**, **then** repoint Lambda / stack config from smoke to this prefix. |

The current proof-safe rule is simple:

- use `trace-eval` and `s3://trace-vault/trace/eval/lance/` for accepted Step 3 evidence
- treat `s3://trace-vault/uber_audit.lance/` as smoke-only or rollback-only context
- use [S3_MIGRATION.md](S3_MIGRATION.md) only for the reference summary of smoke-vs-eval dataset roles

Current state:

- the smoke dataset exists at `s3://trace-vault/uber_audit.lance/`
- the embedding-backed eval dataset is live at `s3://trace-vault/trace/eval/lance/`
- `trace-smoke` and `trace-eval` are both deployed in `us-east-1`
- the first deployed proof run passed against `trace-eval` and wrote artifacts at `artifacts/validation-runs/20260423T233528Z`
- representative stable fixtures are now committed under `fixtures/deployed/examples/`

## Prerequisites

- **AWS CLI** configured for the account and region where the stack runs (`aws sts get-caller-identity` works).
- **Python 3** with script dependencies: `pip install -r scripts/requirements.txt -c scripts/constraints.txt` (includes `boto3` for stack resolution).
- **Node.js 18+** and a built MCP bridge: from the repo root, `cd mcp-bridge && npm install && npm run build` (produces `mcp-bridge/dist/index.js`).
- **Dataset** already uploaded to the bucket/prefix your stack uses (see `template.yaml` parameters `TraceDataBucketName` / `TraceLancePrefix`, or `TRACE_LANCE_S3_URI`).
- **Embeddings** for real runs: `OPENAI_API_KEY` set (same model family as the deployed Lambda dimension, usually `text-embedding-3-small` and length 1536). For structural smoke only, use `--mock-embeddings`: HTTP uses a deterministic query vector, and the proof run sets the bridge env `USE_MOCK_EMBEDDINGS` for MCP. Rankings may differ between HTTP and MCP in that mode.
- **HTTP auth**: if the stack uses an API key secret, set `TRACE_API_KEY` or `TRACE_MCP_API_KEY` to match the deployed secret.
- Use `docs/DEPLOYMENT_RUNBOOK.md` for first-time stack creation or redeployment workflow; use this runbook for ongoing proof execution after stacks already exist.

## Resolve context

The proof runner can pull **SearchUrl** (and dataset URI from stack parameters)
from CloudFormation when you pass **`--stack-name`** and a **region**
(`--region` or `AWS_REGION`).

You can override the search URL with **`--search-url`** /
`TRACE_SEARCH_URL`. The manifest still needs a **dataset URI**: use
**`--dataset-uri`** / `TRACE_LANCE_S3_URI`, or rely on stack parameters
`TraceDataBucketName` + `TraceLancePrefix`.

If `TraceSearchFunctionArn` is present on the stack, the runner reads
**`TRACE_QUERY_VECTOR_DIM`** from the deployed Lambda so the proof script
matches runtime dimension expectations.

## Command reference

The canonical rerun entrypoint lives in
[docs/DEPLOYMENT_RUNBOOK.md](C:/Users/matth/Projects/Trace/Trace/docs/DEPLOYMENT_RUNBOOK.md).
The examples here are reference forms for interpreting or customizing a proof
run after you have already entered the deployed proof workflow.

From the repository root:

```bash
python scripts/prove_deployed_path.py \
  --stack-name YOUR_STACK \
  --region us-east-1 \
  --repo-root .
```

Or with explicit eval-stack settings (no stack lookup):

```bash
set TRACE_LANCE_S3_URI=s3://trace-vault/trace/eval/lance/
set TRACE_SEARCH_URL=https://xxxx.execute-api.us-east-1.amazonaws.com/search
set OPENAI_API_KEY=...
python scripts/prove_deployed_path.py --repo-root .
```

For accepted Step 3 evidence, use the eval dataset URI and the `trace-eval`
stack context. Use smoke dataset settings only for structural debugging or
rollback-only scenarios, not for accepted proof completion claims.

## What counts as Step 3 acceptance

Claim Step 3 completion only from a full proof run against the eval stack or
eval dataset URI. The acceptable path is:

- no `--dry-run`
- no `--skip-mcp`
- no `--allow-missing-vectors`
- no `--mock-embeddings` when using the current golden cases, because those cases
  rely on generated embeddings rather than checked-in query vectors
- every case passes through both direct HTTP and MCP
- every successful HTTP and MCP response reports `query_dim` equal to the
  deployed runtime expectation
- proof-level filter checks pass for cases that set `require_filter_match=true`

The runner also supports degraded or scaffold modes, but they do not satisfy
Step 3 acceptance on their own:

- `--dry-run`: loads cases and resolves runtime context only; no HTTP or MCP calls
- `--skip-mcp`: validates only the direct HTTP path
- `--allow-missing-vectors`: permits skipped HTTP validation when query vectors
  cannot be resolved
- `--mock-embeddings`: structural smoke only; useful for path debugging, not for
  claiming an embedding-backed deployed proof

In those modes, the runner may still write partial artifacts, but the overall
command remains an incomplete proof run and exits non-zero after the final
completeness check.

Important override behavior:

- `--search-url` and `--dataset-uri` can override stack-derived values
- `--stack-name` is the only path that lets the runner infer deployed
  `api_auth_mode` and read `TRACE_QUERY_VECTOR_DIM` from the deployed Lambda when
  `TraceSearchFunctionArn` is present
- `--write-stable-fixtures` requires explicit
  `--stable-fixture-cases=<case_id,...>`; the runner will not choose
  representative cases implicitly from fixture ordering
- `--write-stable-fixtures` is blocked unless the run is in the trusted eval
  context: the manifest `dataset_uri` must equal
  `s3://trace-vault/trace/eval/lance/`, and if `--stack-name` is provided it
  must equal `trace-eval`
- `--allow-non-eval-stable-fixtures` overrides that promotion guard; use it only
  when you intentionally want fixtures from a different deployed source

## Step 3 acceptance sequence

Use this as the repeatable acceptance path for the deployed-proof milestone:

1. Run the proof against `trace-eval` and confirm every case in `fixtures/deployed/golden_cases.json` passes through both direct HTTP and MCP traversal.
2. Inspect `artifacts/validation-runs/<run_id>/manifest.json` and the per-case request/response artifacts under `http/` and `mcp/`.
3. Confirm the manifest `dataset_uri` is the eval dataset path `s3://trace-vault/trace/eval/lance/` and that the run was not a dry-run, skip-MCP, mock-embedding, or missing-vector run.
4. Re-run the proof with `--write-stable-fixtures` once the responses look representative and the target stack is still `trace-eval`.
5. Review the scrubbed outputs under `fixtures/deployed/examples/` and confirm they omit raw vectors, volatile timing fields, request IDs, and environment-specific URLs.
6. Commit only explicitly selected, representative fixtures from the eval dataset path `s3://trace-vault/trace/eval/lance/`; do not promote examples from the smoke dataset or rely on any default representative-case policy.

Step 3 is considered satisfied only when all golden cases pass direct HTTP and
MCP validation in the same full run, `query_dim` matches the deployed runtime,
and proof-level filter checks pass for cases that set
`require_filter_match=true`.

### Useful flags

| Flag | Purpose |
| --- | --- |
| `--mock-embeddings` | No OpenAI calls for HTTP vectors; sets bridge `USE_MOCK_EMBEDDINGS` for MCP. Structural smoke only; not Step 3 evidence. |
| `--skip-mcp` | Debugging mode: validate only the direct HTTP path, then fail the overall run as incomplete. |
| `--dry-run` | Resolve context and load cases only; no HTTP/MCP calls, and the overall run remains incomplete. |
| `--allow-missing-vectors` | Scaffold mode: if embeddings cannot be resolved, skip HTTP instead of failing immediately; the overall run still fails if any case is incomplete. |
| `--write-stable-fixtures` | After success, write scrubbed examples to `fixtures/deployed/examples/` for the explicit case IDs named in `--stable-fixture-cases`. Promotion requires full HTTP and MCP request/response artifacts for every selected case and cannot be combined with `--skip-mcp` or `--dry-run`. |
| `--allow-non-eval-stable-fixtures` | Override the trusted-eval-context promotion guard. Does not make non-eval fixtures acceptable for Step 3 by itself. |

## Artifacts

Each run writes:

- `artifacts/validation-runs/<run_id>/manifest.json` - `api_auth_mode` reflects the deployed stack when `--stack-name` is used (from `TraceApiKeySecretRef`); `local_api_key_supplied` records whether this run passed a key (see [features/deployed-proof-path.md](features/deployed-proof-path.md#per-run-manifest))
- `artifacts/validation-runs/<run_id>/http/<case_id>.request.json` and `.response.json`
- `artifacts/validation-runs/<run_id>/mcp/<case_id>.request.json` and `.response.json`

Stable promoted examples (optional): `fixtures/deployed/examples/http_<case_id>.json`
and `mcp_<case_id>.json` with volatile fields removed or replaced (for example
`took_ms`, request ids, real URLs).

Promotion guardrails:

- enforced by the runner: `--write-stable-fixtures` cannot be combined with
  `--skip-mcp` or `--dry-run`
- enforced by the runner: `--write-stable-fixtures` requires explicit
  `--stable-fixture-cases`; the runner does not auto-select representative cases
  from `golden_cases.json`
- enforced by the runner: promotion fails if any selected case is missing any of
  the four required artifacts: HTTP request, HTTP response, MCP request, or MCP
  response
- enforced by the runner: promotion is blocked outside the trusted eval context
  unless you pass `--allow-non-eval-stable-fixtures`; trusted eval context means
  manifest `dataset_uri` exactly equals
  `s3://trace-vault/trace/eval/lance/`, and if `stack_name` is present it must
  equal `trace-eval`
- not enforced by the runner: whether the selected cases are representative
  enough to commit
- operator requirement: check the manifest before committing fixtures and only
  promote Step 3 fixtures from a full `trace-eval` proof run whose `dataset_uri`
  is the eval prefix; do not use the override for normal Step 3 evidence

Current committed examples:

- `http_unfiltered-demo.json` / `mcp_unfiltered-demo.json`
- `http_filtered-nyc-safety.json` / `mcp_filtered-nyc-safety.json`

These examples are proof fixtures, not ranking-quality benchmarks.

## Golden cases

Cases live in `fixtures/deployed/golden_cases.json`. They are **proof-oriented**
(non-empty results, optional post-hoc checks on returned rows), not
retrieval-quality evaluation.

**`require_filter_match`:** When true, the runner only checks that each result
row's `city_code` and `doc_type` match **equality** conditions of the form
`field = 'literal'` found in the case's `sql_filter` string (quoted literals,
`''` escape supported). It does **not** re-validate the full `sql_filter`
grammar ([`sql_filter` in API_CONTRACT.md](API_CONTRACT.md#sql_filter-grammar));
the Lambda still enforces that. The proof runner does **not** assert
`IN (...)`, ranges, `OR` / `NOT`, or other shapes. Cases that rely on those
operators should keep `require_filter_match` false and still prove the path by
sending the filter and requiring non-empty results (see
`filtered-doc-type-in` in the golden fixture).

## Assumptions

- The MCP bridge is invoked via **stdio** using the same newline-delimited
  JSON-RPC as the official MCP SDK (see `scripts/proof_mcp_stdio.py`).
- Operators building the bridge once per machine is acceptable; CI that only
  unit-tests scrubbing/parsing does not need a built `dist/` unless exercising
  MCP integration.
