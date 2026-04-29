# Trace Deployment Runbook

Last updated: 2026-04-29

This runbook is the end-to-end operator guide for deploying Trace from this
repository. It covers:

- local eval dataset generation
- local validation before upload
- S3 upload and promotion to the eval prefix
- first deployment layout for smoke and eval stacks
- deployed proof validation
- rollback

## When to use this runbook

Use this document when you need the main search/eval operator path:

- first-time smoke/eval stack setup
- local embedding-backed dataset generation and validation
- dataset refresh or embedding regeneration
- S3 promotion to the eval prefix
- proof rerun entrypoints after stack or dataset changes
- rollback of the search/eval environments

Use other docs for narrower tasks:

- use [docs/WEB_APP_DEPLOYMENT.md](C:/Users/matth/Projects/Trace/Trace/docs/WEB_APP_DEPLOYMENT.md) for the browser-facing app publish flow, CloudFront invalidation, app smoke checks, and app-specific incident handling
- use [docs/deployed-proof-runbook.md](C:/Users/matth/Projects/Trace/Trace/docs/deployed-proof-runbook.md) for proof flags, full acceptance rules, artifact review, and stable fixture promotion
- use [docs/OPENAI_API_KEY_SETUP.md](C:/Users/matth/Projects/Trace/Trace/docs/OPENAI_API_KEY_SETUP.md) for local embedding credential setup
- use [docs/retrieval-eval-runbook.md](C:/Users/matth/Projects/Trace/Trace/docs/retrieval-eval-runbook.md) for the local labeled relevance harness only

This document is written for the current Trace search/eval setup:

- smoke dataset URI: `s3://trace-vault/uber_audit.lance/`
- eval dataset URI: `s3://trace-vault/trace/eval/lance/`
- embedding model: `text-embedding-3-small`
- vector dimension: `1536`

Current deployed search/eval state:

- smoke stack: `trace-smoke`
- eval stack: `trace-eval`
- region: `us-east-1`
- smoke search URL: `https://u73d8vk2yl.execute-api.us-east-1.amazonaws.com/search`
- eval search URL: `https://kqsqrljj11.execute-api.us-east-1.amazonaws.com/search`
- latest successful full eval proof run: `artifacts/validation-runs/20260427T040405Z`

## Operator path at a glance

1. Generate the embedding-backed local eval dataset.
2. Run local validation before any upload.
3. Promote the validated dataset to the eval S3 prefix.
4. Deploy or refresh the smoke and eval stacks as needed.
5. Rerun deployed proof against `trace-eval`.
6. Use the web app deployment guide only if you are also publishing the browser app.
7. Use rollback only by repointing to the preserved smoke dataset path.

## Recommended deployment layout

Use two stacks:

| Stack | Dataset prefix | Purpose |
| --- | --- | --- |
| `trace-smoke` | `uber_audit.lance` | Infrastructure-only smoke path, rollback anchor, and non-semantic checks |
| `trace-eval` | `trace/eval/lance` | Real embedding-backed validation and deployed proof runs |

Do not overwrite the smoke prefix in place. Keep `uber_audit.lance` untouched and
deploy the eval dataset at `trace/eval/lance`.

## Prerequisites

In a normal PowerShell session on the deployment machine, confirm:

```powershell
sam --version
cargo lambda --version
aws sts get-caller-identity
```

Expected results:

- `sam` resolves successfully
- `cargo lambda` resolves successfully
- `aws sts get-caller-identity` returns the active AWS identity

A local `OPENAI_API_KEY` shell variable is required for dataset seeding, local
embedding-backed tests, and proof tooling. For the deployed browser app secret
path, use
[docs/WEB_APP_DEPLOYMENT.md](C:/Users/matth/Projects/Trace/Trace/docs/WEB_APP_DEPLOYMENT.md).

If AWS credentials are not configured persistently, use either:

```powershell
aws configure
```

or:

```powershell
aws login
```

depending on your AWS authentication flow.

## 1. Generate the local eval dataset

From the repository root:

```powershell
.\.venv-seed\Scripts\python.exe scripts\seed.py `
  --embedding-mode openai `
  --embedding-model text-embedding-3-small `
  --output-dir .test-tmp\eval-seed `
  --table-name uber_audit `
  --force
```

Expected outputs:

- `.test-tmp\eval-seed\uber_audit.lance`
- `.test-tmp\eval-seed\uber_audit.source.parquet`
- `.test-tmp\eval-seed\uber_audit.seed-manifest.json`

Expected manifest properties:

- `embedding_mode = openai`
- `embedding_model = text-embedding-3-small`
- `vector_dimension = 1536`

## 2. Validate the local eval dataset

Run the local validation gate before any upload:

```powershell
.\.venv-verify\Scripts\python.exe scripts\validate_eval_dataset.py `
  --output-dir .test-tmp\eval-seed `
  --table-name uber_audit
```

Expected output:

- `Local eval validation passed`
- `.test-tmp\eval-seed\uber_audit.eval-validation.json`

Acceptance criteria:

- all cases in `fixtures/eval/local_validation_cases.json` pass
- the seed manifest contains `latest_local_validation`
- the report records `passed = true`

## 3. Upload and promote the eval dataset to S3

Upload the locally validated eval dataset using the built-in staging and
promotion flow:

```powershell
.\.venv-seed\Scripts\python.exe scripts\seed.py `
  --embedding-mode openai `
  --embedding-model text-embedding-3-small `
  --output-dir .test-tmp\eval-seed `
  --table-name uber_audit `
  --bucket trace-vault `
  --s3-prefix trace/eval/lance `
  --no-skip-upload `
  --promote-to-live `
  --yes `
  --allow-production-bucket `
  --force
```

What this does:

- rebuilds the local dataset from the same config
- uploads to `trace/eval/lance/staging/<run_id>/`
- promotes the uploaded dataset into `trace/eval/lance/`
- records candidate/live URIs in the seed manifest

Do not:

- copy `uber_audit.lance/` into the eval prefix
- upload random-vector smoke data to the eval prefix
- overwrite the smoke prefix in place

Verify S3 after promotion:

```powershell
aws s3 ls s3://trace-vault/trace/eval/lance/ --recursive | Select-Object -First 20
aws s3 ls s3://trace-vault/uber_audit.lance/ --recursive | Select-Object -First 20
```

Acceptance criteria:

- objects exist under `s3://trace-vault/trace/eval/lance/`
- smoke objects still exist under `s3://trace-vault/uber_audit.lance/`
- manifest upload fields are populated for the eval build

### Dataset refresh and embedding regeneration

Use this refresh path whenever any of these are true:

- the source corpus changed
- the embedding-backed eval dataset needs to be rebuilt
- the embedding model or vector dimension changed intentionally
- you need a fresh eval artifact before demos, proof reruns, or benchmark reruns

Refresh rules:

- regenerate locally with `scripts/seed.py` in `openai` mode before touching the live eval prefix
- keep `text-embedding-3-small` and dimension `1536` unless you are intentionally changing the deployed stack contract too
- rerun `scripts/validate_eval_dataset.py` before every upload or promotion
- promote only validated embedding-backed eval data to `s3://trace-vault/trace/eval/lance/`
- preserve `s3://trace-vault/uber_audit.lance/` as the rollback-safe smoke dataset
- after any refresh that changes the deployed eval data or stack configuration, rerun the deployed proof flow against `trace-eval`

For dataset role and prefix-safety details, use
[docs/S3_MIGRATION.md](C:/Users/matth/Projects/Trace/Trace/docs/S3_MIGRATION.md).

## 4. Deploy the smoke stack

Deploy the smoke stack first so there is always a known rollback path.

Example:

```powershell
sam build --beta-features

sam deploy `
  --stack-name trace-smoke `
  --region us-east-1 `
  --capabilities CAPABILITY_IAM `
  --resolve-s3 `
  --parameter-overrides `
    TraceDataBucketName=trace-vault `
    TraceLancePrefix=uber_audit.lance
```

Expected state:

- stack name: `trace-smoke`
- dataset output: `s3://trace-vault/uber_audit.lance`
- Lambda / API are wired to the smoke dataset only

## 5. Deploy the eval stack

Deploy a separate stack for semantic validation and proof runs:

```powershell
sam build --beta-features

sam deploy `
  --stack-name trace-eval `
  --region us-east-1 `
  --capabilities CAPABILITY_IAM `
  --resolve-s3 `
  --parameter-overrides `
    TraceDataBucketName=trace-vault `
    TraceLancePrefix=trace/eval/lance
```

Expected state:

- stack name: `trace-eval`
- dataset output: `s3://trace-vault/trace/eval/lance`
- smoke stack remains unchanged

After deploy, record:

```powershell
aws cloudformation describe-stacks `
  --stack-name trace-eval `
  --region us-east-1
```

Look for these outputs:

- `SearchUrl`
- `TraceDatasetS3Uri`
- `TraceSearchFunctionArn`

`TraceDatasetS3Uri` should equal `s3://trace-vault/trace/eval/lance`.

## 6. Build the MCP bridge

From the repository root:

```powershell
cd mcp-bridge
npm install
npm run build
cd ..
```

Expected output artifact:

- `mcp-bridge/dist/index.js`

## 7. Run deployed proof against the eval stack

From the repository root:

```powershell
python scripts\prove_deployed_path.py `
  --stack-name trace-eval `
  --region us-east-1 `
  --repo-root .
```

If no stack lookup is desired, use explicit settings:

```powershell
$env:TRACE_LANCE_S3_URI = "s3://trace-vault/trace/eval/lance/"
$env:TRACE_SEARCH_URL = "https://your-api-id.execute-api.us-east-1.amazonaws.com/search"
python scripts\prove_deployed_path.py --repo-root .
```

Acceptance criteria:

- run proof against `trace-eval` or the eval dataset URI
- write artifacts under `artifacts/validation-runs/<run_id>/`
- use the proof runbook for the detailed acceptance standard, degraded modes, and artifact review rules

Use
[docs/deployed-proof-runbook.md](C:/Users/matth/Projects/Trace/Trace/docs/deployed-proof-runbook.md)
for:

- degraded or scaffold proof modes such as `--dry-run`, `--skip-mcp`, `--allow-missing-vectors`, and `--mock-embeddings`
- the full Step 3 acceptance sequence
- artifact review expectations
- stable fixture promotion rules and guardrails

## 8. Current workspace state

The following have already happened in this workspace:

- the local embedding-backed dataset was generated successfully
- local validation passed
- the eval dataset was promoted to `s3://trace-vault/trace/eval/lance/`
- `trace-smoke` was deployed against `uber_audit.lance`
- `trace-eval` was deployed against `trace/eval/lance`
- deployed proof passed on `trace-eval`
- that Step 3 proof is only considered complete when the accepted run includes both HTTP and MCP validation against `trace-eval`
- the smoke dataset remained available as rollback-only infra data
- Step 4 benchmark and evaluation evidence packaging is complete
- Step 5 deployment and operator documentation is now complete

## 9. Troubleshooting and follow-on guides

Use these docs when the main operator path branches:

- browser app publish failures, app health checks, or app-specific emergency overrides: [docs/WEB_APP_DEPLOYMENT.md](C:/Users/matth/Projects/Trace/Trace/docs/WEB_APP_DEPLOYMENT.md)
- proof flags, artifact review, and stable fixture promotion: [docs/deployed-proof-runbook.md](C:/Users/matth/Projects/Trace/Trace/docs/deployed-proof-runbook.md)
- local retrieval harness execution and metrics: [docs/retrieval-eval-runbook.md](C:/Users/matth/Projects/Trace/Trace/docs/retrieval-eval-runbook.md)
- dataset role, prefix, and migration safety rules: [docs/S3_MIGRATION.md](C:/Users/matth/Projects/Trace/Trace/docs/S3_MIGRATION.md)
- local OpenAI key setup for embedding-backed commands: [docs/OPENAI_API_KEY_SETUP.md](C:/Users/matth/Projects/Trace/Trace/docs/OPENAI_API_KEY_SETUP.md)

## 10. Rollback

Rollback should always preserve the smoke path.

If `trace-eval` behaves unexpectedly:

- leave `trace-smoke` untouched
- use `trace-smoke` for infra debugging and smoke checks
- fix the eval dataset or deployment and redeploy `trace-eval`

If a future shared or main stack ever needs rollback, point it back to:

- `TraceDataBucketName=trace-vault`
- `TraceLancePrefix=uber_audit.lance`

and redeploy.

## 11. Documentation updates after successful deployment

After the first successful eval deployment and proof run, update:

- `docs/PROJECT_STATE.md`
- `docs/NEXT_STEPS.md`
- `docs/S3_MIGRATION.md`
- `docs/deployed-proof-runbook.md`

Those updates should reflect:

- the eval prefix is now populated
- the smoke prefix remains rollback-only infra data
- the local validation gate has been exercised successfully
- `trace-eval` is the active semantic validation environment
- step 2 is complete
- Step 4 benchmark and evaluation evidence packaging is complete
- Step 5 deployment and operator documentation is now complete

## 12. Known environment note

At the time this runbook was written, local dataset generation and validation had
already been completed once in this workspace at:

- `.test-tmp\eval-seed\uber_audit.lance`
- `.test-tmp\eval-seed\uber_audit.seed-manifest.json`
- `.test-tmp\eval-seed\uber_audit.eval-validation.json`

If those artifacts are still current and trusted, you may reuse them for the
first upload. If there is any doubt, regenerate from step 1 before publishing.
