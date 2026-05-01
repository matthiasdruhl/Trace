# Benchmark Evidence

## Headline Claims

- Trace reached `1.000` average `Recall@k` and `1.000` filtered strict accuracy on the current labeled eval corpus.
- `keyword_only` lagged at `0.250` average `Recall@k`, `0.150` average `Precision@k`, and `0.000` filtered strict accuracy on that same corpus.
- On the deployed `trace-eval` eval stack, warm HTTP median latency was `187.761` ms, the search path reported median `took_ms` of `92.000` ms, and direct-Lambda cold samples recorded median `Init Duration` of `97.480` ms plus median billed duration of `1728.000` ms.

## What We Measured

- Local retrieval quality on the current labeled eval corpus using the committed retrieval harness.
- Direct-Lambda cold-sample evidence plus deployed warm-path runtime behavior on the `trace-eval` stack.
- Search-runtime cost estimates derived from measured billed duration and explicit pricing assumptions.

## Current Numbers Table

### Retrieval Evidence

| Metric | Value |
| --- | ---: |
| Corpus | `current labeled eval corpus` |
| Approved corpus validation | `passed via C:\Users\matth\Projects\Trace\Trace\fixtures\eval\local_validation_cases.json` |
| Case count | `8` |
| Trace average Recall@k | `1.000` |
| Trace average Precision@k | `0.600` |
| Trace filtered strict accuracy | `1.000` |
| Keyword average Recall@k | `0.250` |
| Keyword average Precision@k | `0.150` |
| Keyword filtered strict accuracy | `0.000` |

### Deployed Benchmark Evidence

| Metric | Value |
| --- | ---: |
| Cold Lambda init median (ms) | `97.480` |
| Cold Lambda init p95 (ms) | `98.443` |
| Cold Lambda billed median (ms) | `1728.000` |
| Warm HTTP latency median (ms) | `187.761` |
| Warm HTTP latency p95 (ms) | `232.625` |
| Warm took_ms median (ms) | `92.000` |
| Warm took_ms p95 (ms) | `123.400` |
| Warm Lambda billed median (ms) | `66.000` |
| Configured memory (MB) | `512` |
| Max memory used (MB) | `82` |
| Estimated warm cost/query (USD) | `0.00000164` |
| Estimated cold cost/query (USD) | `0.00001272` |

## What The Numbers Mean

- Trace's main retrieval claim is that the current local eval corpus preserves full labeled recall while the lexical baseline does not.
- The deployed benchmark numbers show that the eval stack stays within a bounded warm-path latency and memory envelope under the current Lambda configuration.
- The cold Lambda `Init Duration` numbers describe Lambda runtime initialization only, so they should be paired with billed duration when describing first-hit behavior.
- The cost estimate is intentionally scoped to Lambda request cost, Lambda compute cost, and API Gateway HTTP API request cost only; it should be quoted as an estimate, not a billing export.

## Boundaries And Methodology

- Retrieval metrics are local evidence on the current small labeled eval corpus, not proof of broad retrieval superiority.
- The retrieval report is only packaged when its manifest and latest passing local-validation artifact certify the same eval corpus.
- `vector_postfilter` matched `trace_prefilter_vector` on the current corpus, but that tie is candidate-window-sensitive and is not the main headline claim.
- Cold-start evidence comes from direct Lambda invokes of freshly published versions and should be described as direct-Lambda cold-start evidence, not API Gateway cold-start evidence.
- Warm latency comes from repeated deployed HTTP requests, while `took_ms` reflects the search path's reported internal timing.
- Search-runtime cost excludes query-embedding spend because that cost depends on token volume rather than Lambda billed duration.

## Source Artifacts Used

- Retrieval report: `artifacts\evaluations\20260428T161716Z\report.json`
- Retrieval manifest: `C:\Users\matth\Projects\Trace\Trace\.test-tmp\eval-seed\uber_audit.seed-manifest.json`
- Retrieval approval validation report: `C:\Users\matth\Projects\Trace\Trace\.test-tmp\eval-seed\uber_audit.eval-validation.json`
- Benchmark report: `artifacts\benchmarks\20260428T195740Z\benchmark.json`
- Snapshot: `fixtures\eval\benchmark_evidence_snapshot.json`
