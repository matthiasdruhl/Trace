# Deployed Proof Path

Last updated: 2026-04-21

## S3 layout (smoke vs eval)

For bucket **`trace-vault`**, keep roles separate:

| Dataset | URI | Role |
| --- | --- | --- |
| **Random-vector smoke dataset** (old seed) | `s3://trace-vault/uber_audit.lance/` | **Smoke / infra only** — permissions, Lambda, MCP plumbing, rollback anchor. **Not** eval data; **not** semantic-eval truth. **Keep at this prefix**; **do not overwrite or delete** during migration. |
| **Embedding-backed eval dataset** (new) | `s3://trace-vault/trace/eval/lance/` | **Eval / honest demos** — generate locally, upload here, **validate**, **then** repoint stack/Lambda. |

Do **not** move **`uber_audit.lance/`** into **`trace/eval/lance/`** and treat it as eval data. Do **not** overwrite the smoke prefix in place to “upgrade” it—put the embedding-backed build under **`trace/eval/lance/`** instead. Do **not** mutate files in place under a fixed URI and expect immediate consistency—**prefer a new eval prefix and config repoint** (see [S3_MIGRATION.md](../S3_MIGRATION.md)); that avoids ambiguity and is safer for cache/cutover than replacing objects behind an unchanged URI. Step 1 proof cases validate the **deployed path**, not retrieval benchmark quality.

**Cutover discipline:** repoint production Lambda / stack parameters to the eval URI **only after** the new prefix is validated. **Rollback** continues to use **`s3://trace-vault/uber_audit.lance/`** (smoke URI unchanged).

## Goal

Prove the Trace runtime path end to end against a real deployed stack and a real S3-backed Lance dataset.

This feature operationalizes the top backlog item in [docs/NEXT_STEPS.md](../NEXT_STEPS.md):

- deploy the current SAM stack against a real S3-backed Lance dataset
- confirm `POST /search` returns real results in the deployed environment
- exercise the same endpoint through the MCP bridge
- capture a small set of golden-path example queries for repeatable demos and regression checks
- verify both unfiltered and metadata-filtered searches in the deployed environment (the API applies the full filter; the proof runner only performs narrow, proof-level checks on returned rows when enabled; see Golden cases below)
- save one or two representative request/response fixtures that can be reused in docs and smoke checks

## Feature Archetype

This is an operational verification workflow layered on top of an already-implemented search service.

Architecturally, Trace remains hexagonal:

- the Rust Lambda is the core search runtime
- the SAM stack is the deployment adapter
- the MCP bridge is an integration adapter
- the proof-path workflow is an operator-facing orchestration layer

This is not a new product-facing CRUD surface. It is a repeatable validation harness that coordinates existing system boundaries and persists evidence.

## User Impact

Primary user:

- an engineer or operator validating that Trace works in a real AWS environment

Primary outcome:

- a single repeatable workflow that produces deploy-time proof, stable examples, and artifacts suitable for demos, regressions, and operator debugging

Definition of done:

- a golden-cases fixture exists in-repo
- a proof runner can load those cases and execute a run scaffold
- the runner produces a per-run manifest plus per-case artifacts
- the runner has explicit seams for:
  - stack output resolution
  - query embedding
  - direct HTTP validation
  - MCP validation
- one or two scrubbed response fixtures can be promoted into stable docs/smoke artifacts

## Existing Boundaries

These are the current seams this feature extends:

- [template.yaml](../../template.yaml) exposes `POST /search`
- [template.yaml](../../template.yaml) outputs `SearchUrl`
- [scripts/seed.py](../../scripts/seed.py) already handles dataset generation and upload orchestration
- [scripts/seed.py](../../scripts/seed.py) already distinguishes promoted live datasets from staging candidates
- [lambda-engine/src/search.rs](../../lambda-engine/src/search.rs) is the source of truth for search execution
- [mcp-bridge/src/index.ts](../../mcp-bridge/src/index.ts) exposes `search_cold_archive`

## Scope

In scope for `NEXT_STEPS` step 1:

- operator-facing proof runner
- deployed stack and search URL resolution
- direct HTTP `POST /search` validation
- MCP-path validation through `search_cold_archive`
- committed golden-case definitions for deployed proof
- run manifests and saved artifacts
- saving one or two stable representative fixtures
- minimal operator documentation for running the proof flow

Out of scope:

- changes to the public search API contract
- schema changes to the Lance dataset
- a new UI
- retrieval-quality evaluation metrics beyond pass/fail proof checks
- generalized ingestion or dataset-generation changes
- broad benchmark automation
- a full proof-runner testing framework beyond the minimal checks needed to complete step 1

## Data Model

No SQL or Lance schema changes are required.

This feature adds file-backed operational artifacts.

### Golden cases

Path:

- `fixtures/deployed/golden_cases.json`

Schema:

```json
{
  "version": 1,
  "cases": [
    {
      "case_id": "nyc-unfiltered-demo",
      "query_text": "recent vehicle inspection audit with overdue paperwork",
      "sql_filter": "city_code = 'NYC-TLC'",
      "limit": 5,
      "include_text": true,
      "expected_ids": [],
      "assertions": {
        "require_non_empty_results": true,
        "require_filter_match": true
      }
    }
  ]
}
```

**`require_filter_match` is not grammar validation.** Step 1 uses it as a best-effort proof check: the runner extracts `city_code = '...'` and `doc_type = '...'` equality clauses (single-quoted literals) from `sql_filter` and asserts each returned row matches those literals. It does not prove that arbitrary `sql_filter` text was interpreted correctly overall. Operators must not treat a passing run as verification of the full filter language in [API_CONTRACT.md](../API_CONTRACT.md#sql_filter-grammar); that remains the search service's responsibility. Shapes such as `IN (...)`, inequalities, `OR`, `NOT`, and parentheses are outside the current proof assertions; golden cases that use them should set `require_filter_match` to false and rely on non-empty results (and manual spot checks) unless the filter string contains extractable `city_code` / `doc_type` equalities the runner can check.

### Per-run manifest

Path:

- `artifacts/validation-runs/<run_id>/manifest.json`

Fields:

- `run_id`
- `executed_at`
- `stack_name`
- `region`
- `search_url`
- `dataset_uri`
- `api_auth_mode` — deployed HTTP auth when `--stack-name` resolves the stack: `api_key` if `TraceApiKeySecretRef` is set, else `iam_only_or_public`; `unknown` if no stack metadata (URL/env-only runs)
- `local_api_key_supplied` — whether the operator passed `--api-key` / env for this run (orthogonal to deployed mode)
- `embedding_model`
- `query_dim`
- `cases`

### Per-case artifacts

Paths:

- `artifacts/validation-runs/<run_id>/http/<case_id>.request.json`
- `artifacts/validation-runs/<run_id>/http/<case_id>.response.json`
- `artifacts/validation-runs/<run_id>/mcp/<case_id>.request.json`
- `artifacts/validation-runs/<run_id>/mcp/<case_id>.response.json`

### Stable fixtures

Paths:

- `fixtures/deployed/examples/http_<case_id>.json`
- `fixtures/deployed/examples/mcp_<case_id>.json`

Stable fixtures must omit volatile fields such as:

- `took_ms`
- timestamps generated by the proof run
- environment-specific URLs
- transient request IDs

## API Design

No new public REST or GraphQL endpoint is required.

The proof runner is an internal CLI surface:

```bash
python scripts/prove_deployed_path.py \
  --cases fixtures/deployed/golden_cases.json \
  --stack-name trace-dev \
  --region us-east-1 \
  --search-url https://example.execute-api.us-east-1.amazonaws.com/search \
  --dataset-uri s3://trace-vault/uber_audit.lance/
```

Use `--dataset-uri` that matches the stack (smoke URI above, or `s3://trace-vault/trace/eval/lance/` after eval upload and cutover). Include the trailing `/` for the Lance dataset root.

The runner consumes the existing search contract from [docs/API_CONTRACT.md](../API_CONTRACT.md).

## Component Architecture

### Flow

1. The operator starts the proof runner.
2. The runner loads golden cases from `fixtures/deployed/golden_cases.json`.
3. The runner resolves runtime context:
   - stack name and region
   - deployed `SearchUrl`
   - dataset URI
   - auth mode
   - embedding model and vector dimension
4. For each case, the runner:
   - resolves or computes a query vector
   - sends a direct HTTP `POST /search`
   - invokes the MCP bridge path for the same query
   - normalizes both responses
   - applies assertions (non-empty results, optional narrow filter literal checks on result rows; not full `sql_filter` validation)
   - writes artifacts
5. The runner writes a final run manifest.
6. If requested, the runner promotes scrubbed case outputs into stable fixtures.

### Suggested module seams

- `load_cases`: parse and validate fixture input
- `resolve_runtime_context`: gather stack and environment details
- `embed_query`: compute vectors for natural-language cases
- `call_search_http`: invoke deployed search API directly
- `call_search_mcp`: exercise the MCP bridge
- `assert_case`: verify expectations
- `write_case_artifacts`: persist run outputs
- `promote_stable_fixtures`: scrub and copy reusable examples

## Edge Cases

- Dataset cache drift: the Lambda caches the dataset by canonical URI, so a run that mutates data in place may validate stale state. Uploading to a **new prefix** and repointing config is safer than replacing objects under an existing URI.
- Ranking instability: equal-distance results may reorder, so assertions should avoid overly strict ordering when ties are possible.
- Bridge/runtime drift: MCP embedding dimension may diverge from Lambda `query_dim`.
- Auth mismatches: direct HTTP may require `X-TRACE-API-KEY` while MCP is configured differently.
- Fixture rot: committed stable fixtures can become misleading if they retain volatile fields.
- Concurrent runs: artifact writes must be isolated by unique `run_id`.

## Performance

Optimize for one embedding per case per run.

The direct HTTP check and the MCP check should not both independently recompute embeddings when the purpose is contract verification. Cache the case vector during the run and reuse it where possible.

## Step 1 Implementation Plan

This section is intentionally trimmed to match only `NEXT_STEPS` step 1.

### 1. Finish deployment-context resolution

- resolve `SearchUrl` from the deployed stack when `--stack-name` is provided
- resolve region, dataset URI, and auth metadata from stack outputs or environment
- fail clearly when the deployed target is incomplete or ambiguous

Done when:

- the proof runner can be pointed at a deployed stack without manually copying every value

### 2. Finish direct HTTP proof execution

- support embedding generation from `query_text`
- build direct `POST /search` payloads from the generated vectors
- execute unfiltered and filtered proof cases against the deployed endpoint
- persist raw request and response artifacts

Done when:

- the runner can prove the deployed HTTP path against at least one unfiltered case and one filtered case

### 3. Finish MCP-path proof execution

- invoke the MCP bridge path for each golden case
- save MCP request and response artifacts separately from HTTP artifacts
- verify the MCP path succeeds against the same deployed backend

Done when:

- every golden case exercises both the direct HTTP path and the MCP path

### 4. Finalize golden cases and fixtures

- expand the golden-case set to three to five memorable deployed demo queries
- record expected outcomes at a proof level
- scrub and promote one or two representative responses into stable fixtures

Done when:

- the repository contains reusable proof cases plus a small set of stable example fixtures

### 5. Add the minimal operator runbook

- document seed/upload/promote prerequisites
- document stack deployment assumptions
- document how to run the proof script and where artifacts land

Done when:

- another engineer can run the deployed proof flow without tribal setup knowledge

### 6. Execute one real deployed validation run

- run the full flow against a real S3-backed Lance dataset
- confirm both HTTP and MCP success
- save the resulting representative fixtures

Done when:

- backlog step 1 is satisfied with recorded evidence, not just local scaffolding

## Deferred Work By Backlog Step

The remaining implementation work belongs to later backlog steps, not this feature milestone.

### Move to `NEXT_STEPS` step 2: Align the ingestion and retrieval story

- any change to `scripts/seed.py` that adds real embedding-backed ingestion
- any dataset manifest describing embedding model and generation parameters
- any work that makes demo datasets semantically honest and reproducible
- any refactor that separates dataset generation from embedding generation

Reason:

- those changes are about data realism and ingestion architecture, not deployed proof of the current runtime path

### Move to `NEXT_STEPS` step 3: Prove retrieval relevance, not just infrastructure health

- labeled relevance judgments beyond simple proof fixtures
- expected-rank assertions intended to prove semantic quality
- baseline comparisons such as keyword-only or no-prefilter retrieval
- evaluation metrics such as `Recall@k`, `Precision@k`, and filtered-query accuracy

Reason:

- this is retrieval evaluation work, not deployment verification

### Move to `NEXT_STEPS` step 4: Add deployment and operations documentation

- broad environment setup checklists
- rollback procedures
- troubleshooting playbooks
- operator notes for dataset refreshes and cache debugging beyond the minimal proof runbook

Reason:

- only the minimum run instructions belong in step 1; the fuller operator handbook is a later documentation milestone

### Move to `NEXT_STEPS` step 5: Add benchmark evidence

- cold-start and warm-path timing suites
- memory and cost measurement automation
- latency-by-dataset-size studies

Reason:

- benchmark evidence is explicitly a later milestone and should not expand the deployed proof feature

### Move to `NEXT_STEPS` step 6: Build a stronger demo and judging surface

- a polished user-facing walkthrough
- curated “semantic beats keyword” showcase cases
- explanatory demo packaging intended for judges or external viewers

Reason:

- step 1 only needs a small set of proof cases and saved fixtures, not a polished demo surface

## Testing Strategy

Keep this intentionally light for step 1.

Critical unit tests:

- fixture parsing rejects malformed cases
- response scrubbing removes unstable fields
- assertion logic handles proof-level checks correctly (including the limited `require_filter_match` behavior documented under Golden cases)
- artifact paths are deterministic and isolated by `run_id`

Critical integration tests:

- direct HTTP invocation handles success and error responses
- proof run writes a manifest and case artifacts
- MCP path can be exercised in mock mode
- stack resolution fails clearly when required outputs are missing

Critical end-to-end validation:

- deploy against a real S3-backed Lance dataset
- run at least one unfiltered case and one metadata-filtered case
- persist one or two scrubbed fixtures for docs and smoke checks
