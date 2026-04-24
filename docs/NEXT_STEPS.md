# Trace next steps

Last updated: 2026-04-24

This is the active prioritized backlog for the current implementation, not a sprint-era planning memo.

Status terms used below:

- `Implemented in code`: the repository already contains the core code path for this step
- `Partially complete`: some enabling code exists, but the milestone still requires operator work, deployment work, validation runs, or additional artifacts
- `Not implemented yet`: this is still backlog rather than a built capability

## 1. Align the ingestion and retrieval story

Status: `Implemented in code`, with a small amount of ongoing documentation/operator follow-up

The repository now has the core code path for this milestone:

- deterministic source-record generation
- explicit `random` smoke mode
- real OpenAI-backed embedding generation as the default local path
- source parquet and seed-manifest output for provenance

That moves the dataset story much closer to honest and reproducible, but the
project still needs to use that path deliberately and keep smoke-vs-eval
claims clean.

**S3:** Keep the legacy random-vector dataset at `s3://trace-vault/uber_audit.lance/` as smoke/infra; put the new embedding-backed dataset under `s3://trace-vault/trace/eval/lance/` and repoint only after validation. See [S3_MIGRATION.md](S3_MIGRATION.md).

Remaining follow-up for this milestone:

- keep random vectors only as an explicit structural/local smoke-test mode in docs and operator practice
- validate a few curated local queries against the new embedding-backed path before treating it as ready for S3 promotion
- keep documenting the active embedding model and the 1536-dimension assumption anywhere operators will need to audit it
- preserve the source parquet plus manifest workflow as the canonical provenance trail for regenerated datasets

Desired seed/eval dataset properties:

- semantically related records that use different wording for the same concept
- near-miss records that share keywords but should not rank as true matches
- realistic combinations of `timestamp`, `city_code`, and `doc_type` so filtered retrieval can be tested meaningfully
- a small, stable evaluation corpus that is cheap to regenerate and easy to inspect manually

Implemented in code:

- `scripts/seed.py` computes vectors from `text_content` in `openai` mode
- `random` remains the explicit smoke-mode path
- dataset generation and embedding generation are now distinct phases in the seed pipeline
- the seed path emits a manifest describing the generated dataset and embedding model

This milestone's core implementation is done. The remaining work here is mostly about keeping docs, audit notes, and operator practice honest about smoke versus eval usage.

## 2. Populate and validate the eval dataset path

Status: `Complete`

Once embeddings are generated correctly, the next step is to build the real eval dataset and make it available to deployment workflows.

Required follow-up:

- generate the embedding-backed dataset locally and validate it before upload
- upload that dataset to `s3://trace-vault/trace/eval/lance/`
- keep `s3://trace-vault/uber_audit.lance/` untouched as the random-vector smoke dataset
- repoint SAM / Lambda to the eval prefix only after the new dataset is validated
- record the active embedding model, vector dimension, and dataset URI in docs or manifests so deployment verification is auditable

Implemented in code:

- `scripts/validate_eval_dataset.py` runs a small curated local query and filtered-query sanity gate against the embedding-backed Lance dataset before upload
- `fixtures/eval/local_validation_cases.json` provides the default small curated sanity-case corpus
- the validation runner writes `<table>.eval-validation.json` and records the latest validation summary in the seed manifest for auditability

Completed in this workspace and AWS:

- a fresh embedding-backed eval dataset was generated successfully under `.test-tmp/eval-seed/`
- the local validation gate passed `7/7` curated cases
- the seed manifest was stamped with the successful local validation summary
- the eval dataset was uploaded to `s3://trace-vault/trace/eval/lance/`
- the smoke stack `trace-smoke` was deployed in `us-east-1` against `uber_audit.lance`
- the eval stack `trace-eval` was deployed in `us-east-1` against `trace/eval/lance`
- the first deployed proof run passed against `trace-eval`

This is the point after which deployed-path verification becomes worth doing, because the stack can finally point at a real embedding-backed corpus. The local validator still does not replace a separate deployed proof pass or a labeled relevance harness.

## 3. Prove the deployed path end to end

Status: `Complete`

After steps 1 and 2 are complete, prove the live stack against the embedding-backed eval dataset.

Highest priority:

- deploy or update the current SAM stack against the real eval dataset in S3
- confirm `POST /search` returns real results in the deployed environment
- exercise the same endpoint through the MCP bridge
- capture a small set of golden-path example queries for repeatable demos and regression checks
- verify deployed behavior for both unfiltered and metadata-filtered searches
- save one or two representative request/response fixtures that can be reused in docs and smoke checks

Note:

- this step is about proving the deployed path for features that already exist in code, including metadata filtering; it is not a backlog item to implement filtering itself
- smoke-dataset path proof can still be useful for infrastructure debugging, but it should not be treated as the main acceptance gate once the eval dataset path exists

Already implemented in code:

- `scripts/prove_deployed_path.py` for direct HTTP and MCP proof runs
- `scripts/proof_mcp_stdio.py` for subprocess MCP traversal
- `fixtures/deployed/golden_cases.json` for proof-oriented cases
- targeted proof-path tests in `tests/`

Completed in this workspace:

- a successful `trace-eval` proof run exists with all five golden cases passing through both direct HTTP and MCP in the same full run
- representative stable fixtures are committed under `fixtures/deployed/examples/` for one unfiltered and one equality-filtered case
- the proof runbook now defines the repeatable Step 3 acceptance sequence, including artifact inspection and fixture promotion guidance

Acceptance boundary for this completed step:

- Step 3 completion means a full eval-stack proof run with both HTTP and MCP validation
- `--dry-run`, `--skip-mcp`, `--allow-missing-vectors`, and `--mock-embeddings` remain useful operator modes, but they do not satisfy Step 3 on their own
- stable fixtures are only acceptable as Step 3 proof artifacts when they come from a full run in the trusted eval context; the runner now requires explicit `--stable-fixture-cases`, requires full HTTP and MCP request/response artifacts for each selected case, and blocks promotion unless the manifest `dataset_uri` is exactly `s3://trace-vault/trace/eval/lance/` and any provided `--stack-name` is `trace-eval`
- operators can still bypass that promotion guard with `--allow-non-eval-stable-fixtures`, so Step 3 trust still depends on checking the manifest and commit intent rather than assuming every promoted fixture is automatically acceptable evidence

Remaining follow-up that belongs elsewhere:

- broader hardening, replay/smoke variants, and CI/process decisions remain Step 6 work
- any future shared/main-stack cutover beyond the current `trace-smoke` and `trace-eval` layout remains separate deployment follow-up

## 4. Prove retrieval relevance, not just infrastructure health

Status: `Complete`

Deployment success and latency numbers are not enough on their own. The project also needs evidence that the semantic retrieval path actually returns better results than simpler baselines.

Implemented in code:

- `scripts/evaluate_retrieval.py` runs a local retrieval evaluation harness against the embedding-backed eval dataset
- `fixtures/eval/retrieval_relevance_cases.json` provides labeled relevance cases with exact `incident_id` judgments
- `scripts/filter_expr.py` now provides shared constrained-filter parsing, Lance compilation, and Python-side row evaluation for both the validator and the retrieval harness
- `tests/test_evaluate_retrieval.py` covers case loading, filter evaluation, keyword scoring, post-filter behavior, metrics, and report output
- `docs/retrieval-eval-runbook.md` documents reruns and metric interpretation

The harness currently scores three methods on the same labeled local cases:

- `trace_prefilter_vector`
- `keyword_only`
- `vector_postfilter`

Metrics published by the harness:

- `Recall@k`
- corrected `Precision@k` with denominator `k` (the case limit)
- `Precision@returned`
- filtered strict success per filtered case
- filtered strict accuracy aggregated across filtered cases
- qualitative failure notes when Trace loses to a baseline or misses labeled positives

Important scope notes:

- labeled `incident_id` values are validated against the source dataset before scoring
- the `vector_postfilter` baseline now uses a configurable candidate window, so its results should be read together with that configuration
- this harness is local evidence on a small labeled corpus; it does not establish deployed-path equivalence or broad retrieval superiority

Completed in this workspace:

- a first local relevance run completed successfully under `artifacts/evaluations/20260424T062035Z/`
- that run used the eval dataset under `.test-tmp/eval-seed/` and the current `text-embedding-3-small` / `1536` setup
- that run used the default `vector_postfilter` candidate multiplier of `10` with no fixed candidate-limit override
- `trace_prefilter_vector` reached `1.000` average `Recall@k`, `0.600` average `Precision@k`, and `1.000` filtered strict accuracy on the current labeled cases
- `keyword_only` reached `0.238` average `Recall@k`, `0.143` average `Precision@k`, and `0.500` filtered strict accuracy
- `vector_postfilter` matched `trace_prefilter_vector` on this particular run, but that comparison remains sensitive to the configured postfilter candidate window and the small corpus size

Acceptance boundary for this completed step:

- Step 4 completion means a local labeled relevance harness exists, is rerunnable, and has produced at least one real report against the embedding-backed eval dataset
- the current labeled cases are intentionally small and synthetic; they are evidence of retrieval quality progress, not a final benchmark suite
- proof fixtures and labeled relevance judgments remain separate artifacts and should not be conflated
- Step 4 does not prove that the deployed stack is path-equivalent to the local harness, and it does not justify broader claims than this corpus supports

The goal is to maintain bounded, rerunnable local evidence about whether the current retrieval approach retrieves the labeled records more reliably than simple baselines on this corpus.

## 5. Add deployment and operations documentation

Status: `Partially complete`

Useful follow-up docs:

- environment setup checklist for Lambda and MCP bridge
- deployment steps from local seed to SAM deploy
- rollback and troubleshooting notes for common failures
- operator notes for dataset refreshes, embedding regeneration, and cache-related debugging
- extend the minimal deployed-proof runbook into a fuller operator handbook once the proof path is stable

Current repo status:

- `docs/deployed-proof-runbook.md` exists as a minimal proof-path operator runbook
- `docs/S3_MIGRATION.md` exists for smoke-versus-eval migration guidance
- `docs/DEPLOYMENT_RUNBOOK.md` now exists as the end-to-end deployment and rollback handbook

## 6. Harden deployed proof automation

Status: `Partially complete`

After the first end-to-end proof path is working, harden it so it is safer to rerun and easier to trust.

Useful follow-up:

- add focused unit tests for proof-case parsing, response scrubbing, and artifact generation
- add focused integration tests for the direct HTTP validation path and MCP validation path
- add a CI-safe dry-run or mock mode for the proof runner so basic regressions can be checked without a live AWS deployment
- add a lightweight smoke-check mode that can replay saved fixtures or run a reduced validation path when full deployment proof is unnecessary
- decide whether any of this should run in CI, remain manual, or be a release-time verification step

Current repo status:

- the proof runner already has a `--dry-run` path
- targeted unit coverage already exists for the proof runner and MCP stdio helper
- the remaining work here is broader hardening, integration coverage, replay/smoke modes, and process decisions

## 7. Add benchmark evidence

Status: `Not implemented yet`

The code supports the architecture claims, but the repository would benefit from measured evidence:

- cold start versus warm path timing
- latency by dataset size
- memory footprint during search
- cost-per-query estimates grounded in actual Lambda and S3 usage
- relevance metrics from the retrieval evaluation harness
- benchmark notes that distinguish structural smoke tests from semantic-quality evaluations

## 8. Build a stronger demo and judging surface

Status: `Not implemented yet`

After the deployed and evaluation paths are stable, package the project so its value is obvious quickly.

High-value additions:

- three to five memorable demo queries with expected outcomes
- one example where keywords fail but semantic retrieval succeeds
- one example where semantic retrieval alone is insufficient but semantic retrieval plus metadata filtering succeeds
- a concise explanation of why the architecture is better than a naive RAG or keyword-only baseline for the target workflow
- a lightweight user-facing surface, whether that is a small web UI or a polished MCP-driven walkthrough

The main goal is to make the project easy to understand in under a minute without requiring the viewer to infer the value from architecture alone.

## 9. Decide on the next product surface

Status: `Not implemented yet`

After deployment proof is stable, choose one of:

- a small operator-facing web UI
- richer MCP ergonomics and tool outputs
- stronger ingestion realism and benchmark automation

The main rule is to extend from the current working core rather than reopening broad planning exploration.
