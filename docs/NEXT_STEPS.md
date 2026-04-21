# Trace next steps

Last updated: 2026-04-20

This is the active prioritized backlog for the current implementation, not a sprint-era planning memo.

## 1. Prove the deployed path end to end

Highest priority:

- deploy the current SAM stack against a real S3-backed Lance dataset
- confirm `POST /search` returns real results in the deployed environment
- exercise the same endpoint through the MCP bridge
- capture a small set of golden-path example queries for repeatable demos and regression checks
- verify both unfiltered and metadata-filtered searches in the deployed environment
- save one or two representative request/response fixtures that can be reused in docs and smoke checks

## 2. Align the ingestion and retrieval story

The current codebase is structurally sound, but the seed script still generates random vectors. That is acceptable for structural testing, but it does not prove semantic retrieval quality. The next milestone should make the dataset story honest, reproducible, and judgeable.

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

## 3. Prove retrieval relevance, not just infrastructure health

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

The goal is to be able to say, with evidence, that Trace is not just working code but a better retrieval architecture for the target use case.

## 4. Add deployment and operations documentation

Useful follow-up docs:

- environment setup checklist for Lambda and MCP bridge
- deployment steps from local seed to SAM deploy
- rollback and troubleshooting notes for common failures
- operator notes for dataset refreshes, embedding regeneration, and cache-related debugging

## 5. Add benchmark evidence

The code supports the architecture claims, but the repository would benefit from measured evidence:

- cold start versus warm path timing
- latency by dataset size
- memory footprint during search
- cost-per-query estimates grounded in actual Lambda and S3 usage
- relevance metrics from the retrieval evaluation harness
- benchmark notes that distinguish structural smoke tests from semantic-quality evaluations

## 6. Build a stronger demo and judging surface

After the deployed and evaluation paths are stable, package the project so its value is obvious quickly.

High-value additions:

- three to five memorable demo queries with expected outcomes
- one example where keywords fail but semantic retrieval succeeds
- one example where semantic retrieval alone is insufficient but semantic retrieval plus metadata filtering succeeds
- a concise explanation of why the architecture is better than a naive RAG or keyword-only baseline for the target workflow
- a lightweight user-facing surface, whether that is a small web UI or a polished MCP-driven walkthrough

The main goal is to make the project easy to understand in under a minute without requiring the viewer to infer the value from architecture alone.

## 7. Decide on the next product surface

After deployment proof is stable, choose one of:

- a small operator-facing web UI
- richer MCP ergonomics and tool outputs
- stronger ingestion realism and benchmark automation

The main rule is to extend from the current working core rather than reopening broad planning exploration.
