# Trace project state

Last updated: 2026-04-28

## Summary

Trace is no longer just a planning repository. The codebase currently contains a working Rust Lambda search service, a working MCP bridge, a browser-facing production app, a synthetic data generation pipeline, an AWS SAM deployment template, and a deployed proof-path runner with targeted tests.

The active code path supports:

- Lance-backed nearest-neighbor search
- constrained metadata filtering applied before vector search
- optional API-key enforcement for the HTTP API
- MCP-mediated natural-language search through embeddings
- a browser-facing investigation workflow with structured filters, curated cases,
  surfaced evidence, and deterministic handoff output

Against the active backlog in `docs/NEXT_STEPS.md`, the current status is:

- step 1 (clarify the product story everywhere): complete
- step 2 (build a strong demo surface): complete
- step 3 (create a side-by-side proof of value): complete
- step 4 (package benchmark and evaluation evidence for judges): partially complete
- step 5 (tighten deployment and operator documentation): partially complete
- step 6 (harden deployed proof automation): partially complete
- step 7 (add one memorable trust or explainability feature): not implemented yet
- step 8 (prepare the finalist pitch path now): not implemented yet

Strategically, Trace is now better described as an AI-assisted investigation
workflow than as a search system alone. The retrieval backbone is credible; the
main gap is turning that backbone into a more visible investigation experience.

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

Current product implication:

- the MCP bridge provides the opening for an AI-native investigation flow
- today it is still exposed mostly as retrieval plumbing rather than a full investigation handoff experience

### Production web app

Implemented across `demo-ui/`, `mcp-bridge/`, and `template.yaml`:

- a browser-facing React/Vite investigation workspace
- compact top bar and two-column operator layout on desktop
- curated investigation cases with surfaced subtitles
- structured filters tied to submitted search scope
- a featured top-lead card plus supporting evidence ladder
- deterministic handoff panel and reasoning strip
- product-specific loading, error, and no-result states
- a public app API exposed under `/api/*` for search, cases, and health

Current product implication:

- Trace now has a visible demo surface rather than just backend retrieval
- the main product story is legible as an investigation workflow, not only as
  search infrastructure

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

### Retrieval relevance evaluation

Implemented in `scripts/evaluate_retrieval.py`, `scripts/filter_expr.py`, and `fixtures/eval/`:

- labeled local relevance cases keyed by exact `incident_id`
- shared constrained-filter parsing and Python-side filter evaluation reused across local validation and retrieval evaluation
- local scoring for `trace_prefilter_vector`, `keyword_only`, and `vector_postfilter`
- source-dataset validation that checks labeled `incident_id` presence, uniqueness, and filtered-case label/filter consistency before scoring
- machine-readable JSON reports plus compact Markdown summaries
- targeted unit coverage for fixture loading, filter behavior, keyword ranking, metrics, and report writing

Current local retrieval-eval status:

- the same local eval corpus now feeds the committed proof pack in `docs/PROOF_OF_VALUE.md`
- the latest local retrieval evaluation used the local eval dataset under `.test-tmp/eval-seed/`
- the latest local retrieval evaluation used the default `vector_postfilter` candidate multiplier of `10` with no fixed candidate-limit override
- `trace_prefilter_vector` reached `1.000` average `Recall@k`, `0.600` average `Precision@k`, and `1.000` filtered strict accuracy on the current labeled set
- `keyword_only` reached `0.250` average `Recall@k`, `0.150` average `Precision@k`, and `0.000` filtered strict accuracy
- `vector_postfilter` matched `trace_prefilter_vector` on the current labeled set, but that comparison is sensitive to the configured postfilter candidate window and the small local corpus

Metric definitions used by the harness:

- `Recall@k`: labeled relevant records returned within `k`
- `Precision@k`: labeled relevant records returned divided by `k`, not by the number of rows actually returned
- `Precision@returned`: labeled relevant records returned divided by the number of rows actually returned
- filtered strict success: for filtered cases, every returned row matches the filter and the full labeled positive set is retrieved within `k`
- filtered strict accuracy: average filtered strict success across filtered cases

Boundary on these claims:

- this harness is local evidence on a small labeled corpus, not a final benchmark suite
- it does not prove that the deployed stack is equivalent to the local harness path
- it should not be treated as proof of broad retrieval superiority outside the current corpus

### Proof-of-value comparison pack

Implemented in `scripts/build_proof_of_value.py`, `fixtures/eval/proof_of_value_cases.json`,
`fixtures/eval/proof_of_value_snapshot.json`, and `docs/PROOF_OF_VALUE.md`:

- a committed side-by-side artifact now packages the insurance lapse workflow where keyword-only search fails but Trace succeeds
- a second committed artifact shows that semantic-only retrieval is still too broad for the Chicago insurance workflow until metadata scope is applied
- the proof pack is grounded in the local retrieval harness and the current embedding-backed eval dataset, not in ad hoc screenshots
- the same local report also shows `vector_postfilter` matching `trace_prefilter_vector` on the current labeled set, so the proof pack should be read as two selected operator-facing comparisons rather than universal baseline dominance
- the same artifact IDs can now be reused consistently in the README, demo, and pitch

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
- the latest successful full eval-stack proof run completed at `artifacts/validation-runs/20260427T040405Z`
- that run used stack `trace-eval`, dataset `s3://trace-vault/trace/eval/lance`, region `us-east-1`, and model `text-embedding-3-small`
- all proof cases in that run passed for both direct HTTP and MCP traversal
- representative scrubbed stable fixtures are now committed under `fixtures/deployed/examples/` for `unfiltered-demo` and `filtered-nyc-safety`
- `docs/deployed-proof-runbook.md` now defines the repeatable acceptance sequence for reruns and fixture promotion

Important boundary on those claims:

- Step 3 completion refers to a full deployed proof run with both HTTP and MCP validation against the eval dataset
- the proof runner also supports `--dry-run`, `--skip-mcp`, `--allow-missing-vectors`, and `--mock-embeddings`, but those modes are scaffolding or smoke aids rather than completion evidence
- stable-fixture writing is guarded against `--dry-run` and `--skip-mcp`, requires explicit `--stable-fixture-cases`, and requires all four artifacts for each selected case: HTTP request, HTTP response, MCP request, and MCP response
- the runner also blocks stable-fixture promotion outside the trusted eval context by default: manifest `dataset_uri` must equal `s3://trace-vault/trace/eval/lance/`, and if `stack_name` is provided it must equal `trace-eval`
- `--allow-non-eval-stable-fixtures` can still override that guard, so operators still need to confirm committed proof fixtures came from the eval deployment context before treating them as Step 3 evidence

### Deployment

Implemented in `template.yaml`:

- ARM64 Lambda packaging via SAM and `cargo-lambda`
- CloudFront-backed production app delivery
- static frontend bucket for `demo-ui/dist`
- public app API under `/api/*`
- retained Rust search endpoint `POST /search` behind the app API
- CORS configuration
- S3 read permissions for the configured dataset prefix (parameters `TraceDataBucketName` / `TraceLancePrefix`; stack output `TraceDatasetS3Uri`)
- optional Secrets Manager-backed API key injection
- stack outputs for `AppUrl`, `AppApiBaseUrl`, `FrontendBucketName`,
  `TraceAppDistributionId`, `HttpApiUrl`, `SearchUrl`, `TraceDatasetS3Uri`,
  and `TraceSearchFunctionArn`

Deployed in AWS (`us-east-1`):

- `trace-smoke` points at `s3://trace-vault/uber_audit.lance`
- `trace-eval` points at `s3://trace-vault/trace/eval/lance`
- `trace-smoke` search URL: `https://u73d8vk2yl.execute-api.us-east-1.amazonaws.com/search`
- `trace-eval` search URL: `https://kqsqrljj11.execute-api.us-east-1.amazonaws.com/search`
- `trace-eval` app URL: `https://d16y21pmy9pe9s.cloudfront.net`

## What is not fully done

- There are not yet benchmark artifacts for latency, memory footprint, or cost-per-query
- There is not yet a completed deployment history for smoke/eval stacks, although `docs/DEPLOYMENT_RUNBOOK.md` now documents that workflow

## Current repo guidance

- Use `codex/clean-main-candidate` as the clean promotion branch when replacing or merging into `main`
- Treat `docs/deprecated/` as historical context, not active reference material
- Do not recommit generated Lance dataset directories
- Treat `s3://trace-vault/uber_audit.lance/` as the rollback-safe random-vector smoke dataset and `s3://trace-vault/trace/eval/lance/` as the active embedding-backed eval dataset
