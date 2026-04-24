# Retrieval Evaluation Runbook

Last updated: 2026-04-24

## Goal

Run the local retrieval relevance harness against the embedding-backed eval
dataset and compare three local methods on the same labeled cases:

- `trace_prefilter_vector`: the harness's local prefilter-then-vector method
- `keyword_only`: lexical ranking over `text_content`
- `vector_postfilter`: vector retrieval without metadata prefilter, followed by
  Python-side filtering over a configurable candidate pool

This is local evidence for retrieval quality on a small labeled corpus. It is
separate from the deployed proof path in `docs/deployed-proof-runbook.md`, and
it should not be read as proof that the deployed stack follows the same path or
that the current retrieval approach is broadly superior outside this corpus.

## Inputs

- a local embedding-backed eval dataset plus manifest
- labeled cases in `fixtures/eval/retrieval_relevance_cases.json`
- `OPENAI_API_KEY` for query embeddings

The harness requires an `openai` manifest and the current `1536`-dimension
embedding model alignment.

Before any scoring happens, the harness validates the labels against the source
dataset referenced by the manifest:

- every labeled `incident_id` must exist in the source parquet
- `incident_id` values in the source dataset must be unique
- for filtered cases, every labeled positive must satisfy the case filter

## Run

From the repo root:

```bash
set OPENAI_API_KEY=...
python scripts/evaluate_retrieval.py --output-dir .test-tmp/eval-seed --table-name uber_audit --cases-path fixtures/eval/retrieval_relevance_cases.json
```

Default outputs land under:

```text
artifacts/evaluations/<run_id>/
```

Files written:

- `report.json`: full machine-readable metrics and per-case method results
- `summary.md`: compact human-readable metric summary

Useful postfilter knobs:

- `--postfilter-candidate-multiplier`: sizes the `vector_postfilter` candidate
  pool relative to case `limit` before Python-side filtering; default `10`
- `--postfilter-candidate-limit`: fixed candidate pool size override for
  `vector_postfilter`

Tradeoff:

- a larger candidate window makes the `vector_postfilter` baseline less likely
  to miss filter-satisfying positives that appear below the top `k` global
  vector results, but it also makes that baseline less comparable to a strict
  top-`k` retrieval path and more dependent on the chosen window size
- a smaller candidate window is cheaper and harsher, but it can understate what
  a postfilter strategy would recover if allowed to inspect more candidates

## Metric definitions

- `Recall@k`: `relevant_hit_count / labeled_relevant_count` for a case
- `Precision@k`: `relevant_hit_count / k`, where `k` is the case `limit`
  rather than the number of rows actually returned
- `Precision@returned`: `relevant_hit_count / returned_count`; this is reported
  separately so short result sets are not implicitly graded as if they returned
  `k` rows
- filtered-case strict success: for a filtered case, `true` only when every
  returned row satisfies the filter and the method retrieves the full labeled
  positive set within `k`
- filtered strict accuracy: average strict-success rate across filtered cases

The older phrase "filtered-query accuracy" was too loose for this harness. The
current docs use "filtered strict success" and "filtered strict accuracy" to
make the pass condition explicit.

## Current reference run

The latest local Step 4 acceptance run in this workspace is:

```text
artifacts/evaluations/20260424T062035Z/
```

Reference configuration from that run:

- `vector_postfilter` candidate multiplier: `10`
- `vector_postfilter` candidate limit override: unset

Aggregate metrics from that run:

- `trace_prefilter_vector`: average `Recall@k = 1.000`, average `Precision@k = 0.600`, filtered strict accuracy `1.000`
- `keyword_only`: average `Recall@k = 0.238`, average `Precision@k = 0.143`, filtered strict accuracy `0.500`
- `vector_postfilter`: average `Recall@k = 1.000`, average `Precision@k = 0.600`, filtered strict accuracy `1.000`

## Interpretation

- Treat `trace_prefilter_vector` as a local harness method, not as proof of
  deployed-path equivalence.
- Treat `keyword_only` as the lexical baseline.
- Treat `vector_postfilter` as a sensitivity baseline whose results depend in
  part on the configured candidate window.
- Keep proof fixtures and relevance labels separate; deployed proof confirms the
  path works, while this harness scores retrieval quality on labeled local
  cases.
- Read the current results as bounded local evidence. They are useful for
  regression checks and for comparing methods on this corpus, but they are not a
  final benchmark suite or a claim of general retrieval superiority.
