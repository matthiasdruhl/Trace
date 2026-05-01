# Trace documentation

Active docs are grouped by role. Start from the repository `[README.md](../README.md)` for product context, then use the section below that matches what you are doing.

## Guides (operators)

Step-by-step runbooks and setup:


| Doc                                                                  | Purpose                                                                         |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| [guides/DEPLOYMENT_RUNBOOK.md](guides/DEPLOYMENT_RUNBOOK.md)         | Dataset refresh, SAM/search stack rollout, deployed proof entrypoints, rollback |
| [guides/WEB_APP_DEPLOYMENT.md](guides/WEB_APP_DEPLOYMENT.md)         | Browser app publish, CloudFront, app smoke checks, app troubleshooting          |
| [guides/deployed-proof-runbook.md](guides/deployed-proof-runbook.md) | Proof flags, acceptance rules, artifacts, fixture promotion                     |
| [guides/retrieval-eval-runbook.md](guides/retrieval-eval-runbook.md) | Local labeled relevance harness and metrics                                     |
| [guides/OPENAI_API_KEY_SETUP.md](guides/OPENAI_API_KEY_SETUP.md)     | Local embedding credential setup                                                |
| [guides/S3_MIGRATION.md](guides/S3_MIGRATION.md)                     | Smoke vs eval dataset roles, prefixes, safe cutover                             |


## Reference (engineering)

Contracts and system shape:


| Doc                                                          | Purpose                                                      |
| ------------------------------------------------------------ | ------------------------------------------------------------ |
| [reference/ARCHITECTURE.md](reference/ARCHITECTURE.md)       | Component-level overview                                     |
| [reference/API_CONTRACT.md](reference/API_CONTRACT.md)       | `POST /search` request, response, auth, `sql_filter` grammar |
| [reference/DATA_SPEC.md](reference/DATA_SPEC.md)             | Synthetic dataset schema and seed behavior                   |
| [reference/RUST_CRATE_DOCS.md](reference/RUST_CRATE_DOCS.md) | Rust dependency doc index                                    |


## Product (positioning and narrative)


| Doc                                                                  | Purpose                                                    |
| -------------------------------------------------------------------- | ---------------------------------------------------------- |
| [product/PERSONA.md](product/PERSONA.md)                             | Primary user and framing                                   |
| [product/PROOF_OF_VALUE.md](product/PROOF_OF_VALUE.md)               | Committed judge-facing proof pack (local eval comparisons) |
| [product/COMPETITION_STRATEGY.md](product/COMPETITION_STRATEGY.md)   | Challenge scoring orientation                              |
| [product/DEMO_PLAN.md](product/DEMO_PLAN.md)                         | Live demo structure and proof points                       |
| [product/PITCH_VIDEO_PLAN.md](product/PITCH_VIDEO_PLAN.md)           | Pitch outline and asset checklist                          |
| [product/UI_JUDGE_IMPROVEMENTS.md](product/UI_JUDGE_IMPROVEMENTS.md) | UI/judge-facing improvement notes                          |


## Project (state, backlog, evidence)


| Doc                                                            | Purpose                                                                                 |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| [project/PROJECT_STATE.md](project/PROJECT_STATE.md)           | Implementation snapshot                                                                 |
| [project/NEXT_STEPS.md](project/NEXT_STEPS.md)                 | Prioritized backlog                                                                     |
| [project/FINAL_STEPS.md](project/FINAL_STEPS.md)               | Late-stage checklist items                                                              |
| [project/BENCHMARK_EVIDENCE.md](project/BENCHMARK_EVIDENCE.md) | Canonical Step 4 numbers (paired with `fixtures/eval/benchmark_evidence_snapshot.json`) |


## Features


| Doc                                                                | Purpose                          |
| ------------------------------------------------------------------ | -------------------------------- |
| [features/deployed-proof-path.md](features/deployed-proof-path.md) | Deployed proof-path feature spec |


## Archive

Superseded planning and snapshots: [deprecated/](deprecated/README.md).