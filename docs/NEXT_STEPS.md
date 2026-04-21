# Trace next steps

Last updated: 2026-04-21

This is the active prioritized backlog for the current implementation, not a sprint-era planning memo.

## 1. Align the ingestion and retrieval story

The current codebase is structurally sound, but the seed script still generates random vectors. That is acceptable for structural testing, but it does not prove semantic retrieval quality. The next milestone should make the dataset story honest, reproducible, and judgeable.

**S3:** Keep the legacy random-vector dataset at `s3://trace-vault/uber_audit.lance/` as smoke/infra; put the new embedding-backed dataset under `s3://trace-vault/trace/eval/lance/` and repoint only after validation. See [S3_MIGRATION.md](S3_MIGRATION.md).

Required follow-up:

- keep random vectors only as an explicit structural/local smoke-test mode and document that clearly
- add a real embedding-backed ingestion mode for demo and evaluation datasets
- ensure the embedding path is reproducible enough to regenerate the same class of dataset later
- document which embedding model is used and what assumptions that choice introduces

Desired seed/eval dataset properties:

- semantically related records that use different wording for the same concept
- near-miss records that share keywords but should not rank as true matches
- realistic combinations of `timestamp`, `city_code`, and `doc_type` so filtered retrieval can be tested meaningfully
- a small, stable evaluation corpus that is cheap to regenerate and easy to inspect manually

Concrete implementation ideas:

- extend `scripts/seed.py` with a real embedding mode that computes vectors from `text_content`
- keep a fast local mode for development and CI, but make the semantically meaningful mode the default for demos
- separate "dataset generation" from "embedding generation" if that makes retries and caching easier
- add a small manifest describing the generated dataset, embedding model, and generation parameters

This is the step after which embeddings become correct enough to support meaningful deployment validation.

## 2. Populate and validate the eval dataset path

Once embeddings are generated correctly, the next step is to build the real eval dataset and make it available to deployment workflows.

Required follow-up:

- generate the embedding-backed dataset locally and validate it before upload
- upload that dataset to `s3://trace-vault/trace/eval/lance/`
- keep `s3://trace-vault/uber_audit.lance/` untouched as the random-vector smoke dataset
- repoint SAM / Lambda to the eval prefix only after the new dataset is validated
- record the active embedding model, vector dimension, and dataset URI in docs or manifests so deployment verification is auditable

This is the point after which deployed-path verification becomes meaningful for semantic behavior, because the stack can finally point at a real embedding-backed corpus.

## 3. Prove the deployed path end to end

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

## 4. Prove retrieval relevance, not just infrastructure health

Deployment success and latency numbers are not enough on their own. The project also needs evidence that the semantic retrieval path actually returns better results than simpler baselines.

Add an evaluation harness with:

- a labeled set of representative natural-language queries
- expected relevant records for each query
- adversarial cases where keyword overlap should not be enough
- filtered-query cases where the correct answer depends on both semantics and metadata constraints

Measure and publish:

- `Recall@k`
- `Precision@k`
- filtered-query accuracy
- qualitative notes for failure cases and ambiguous queries

Compare Trace against at least one baseline such as:

- keyword-only retrieval
- vector search without metadata prefilter
- another lightweight retrieval baseline if it is cheap to add

Additional follow-up that belongs here:

- promote deployed proof cases into a labeled evaluation set once the dataset story is semantically honest
- add stronger expected-rank or top-k assertions only after the evaluation corpus is stable enough to support them
- distinguish clearly between "deployment proof fixtures" and "retrieval quality judgments" so the two do not get conflated

The goal is to be able to say, with evidence, that Trace is not just working code but a better retrieval architecture for the target use case.

## 5. Add deployment and operations documentation

Useful follow-up docs:

- environment setup checklist for Lambda and MCP bridge
- deployment steps from local seed to SAM deploy
- rollback and troubleshooting notes for common failures
- operator notes for dataset refreshes, embedding regeneration, and cache-related debugging
- extend the minimal deployed-proof runbook into a fuller operator handbook once the proof path is stable

## 6. Harden deployed proof automation

After the first end-to-end proof path is working, harden it so it is safer to rerun and easier to trust.

Useful follow-up:

- add focused unit tests for proof-case parsing, response scrubbing, and artifact generation
- add focused integration tests for the direct HTTP validation path and MCP validation path
- add a CI-safe dry-run or mock mode for the proof runner so basic regressions can be checked without a live AWS deployment
- add a lightweight smoke-check mode that can replay saved fixtures or run a reduced validation path when full deployment proof is unnecessary
- decide whether any of this should run in CI, remain manual, or be a release-time verification step

## 7. Add benchmark evidence

The code supports the architecture claims, but the repository would benefit from measured evidence:

- cold start versus warm path timing
- latency by dataset size
- memory footprint during search
- cost-per-query estimates grounded in actual Lambda and S3 usage
- relevance metrics from the retrieval evaluation harness
- benchmark notes that distinguish structural smoke tests from semantic-quality evaluations

## 8. Build a stronger demo and judging surface

After the deployed and evaluation paths are stable, package the project so its value is obvious quickly.

High-value additions:

- three to five memorable demo queries with expected outcomes
- one example where keywords fail but semantic retrieval succeeds
- one example where semantic retrieval alone is insufficient but semantic retrieval plus metadata filtering succeeds
- a concise explanation of why the architecture is better than a naive RAG or keyword-only baseline for the target workflow
- a lightweight user-facing surface, whether that is a small web UI or a polished MCP-driven walkthrough

The main goal is to make the project easy to understand in under a minute without requiring the viewer to infer the value from architecture alone.

## 9. Decide on the next product surface

After deployment proof is stable, choose one of:

- a small operator-facing web UI
- richer MCP ergonomics and tool outputs
- stronger ingestion realism and benchmark automation

The main rule is to extend from the current working core rather than reopening broad planning exploration.
