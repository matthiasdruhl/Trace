# Trace Deployment Runbook

Last updated: 2026-04-26

This runbook is the end-to-end operator guide for deploying Trace from this
repository. It covers:

- local eval dataset generation
- local validation before upload
- S3 upload and promotion to the eval prefix
- first deployment layout for smoke and eval stacks
- deployed proof validation
- rollback

Important scope note:

- this runbook is primarily the smoke/eval search-stack and proof-path guide
- the browser-facing production app deploy flow now also includes frontend
  publishing and CloudFront invalidation, which are documented in
  `docs/WEB_APP_DEPLOYMENT.md`
- use this runbook for dataset generation, stack deployment, proof validation,
  and rollback of the search/eval environments
- use the web app deployment guide when you need the current app API +
  frontend publish flow for the production demo surface

This document is written for the current Trace setup:

- smoke dataset URI: `s3://trace-vault/uber_audit.lance/`
- eval dataset URI: `s3://trace-vault/trace/eval/lance/`
- embedding model: `text-embedding-3-small`
- vector dimension: `1536`

Current deployed state:

- smoke stack: `trace-smoke`
- eval stack: `trace-eval`
- region: `us-east-1`
- smoke search URL: `https://u73d8vk2yl.execute-api.us-east-1.amazonaws.com/search`
- eval search URL: `https://kqsqrljj11.execute-api.us-east-1.amazonaws.com/search`
- eval app URL: `https://d16y21pmy9pe9s.cloudfront.net`
- latest successful full eval proof run: `artifacts/validation-runs/20260427T040405Z`

## Recommended deployment layout

Use two stacks:

| Stack | Dataset prefix | Purpose |
| --- | --- | --- |
| `trace-smoke` | `uber_audit.lance` | Infrastructure-only smoke path, rollback anchor, and non-semantic checks |
| `trace-eval` | `trace/eval/lance` | Real embedding-backed validation and deployed proof runs |

Do not overwrite the smoke prefix in place. Keep `uber_audit.lance` untouched and
deploy the eval dataset at `trace/eval/lance`.

Current app note:

- the production app introduced on the current branch is a broader deployment
  shape than the earlier smoke/eval search-only stacks
- that app path provisions CloudFront, a frontend bucket, and `/api/*` routes
- this runbook remains the source of truth for smoke/eval retrieval validation,
  not the only documentation for the browser app rollout

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

For the browser app deployment path described in
[docs/WEB_APP_DEPLOYMENT.md](C:/Users/matth/Projects/Trace/Trace/docs/WEB_APP_DEPLOYMENT.md),
the deployed Node app API now reads the OpenAI key from Secrets Manager at
runtime via `OPENAI_API_KEY_SECRET_REF`. A local `OPENAI_API_KEY` shell
variable is still required for dataset seeding, local embedding-backed tests,
and proof tooling, but it is no longer a prerequisite for a normal stack
update by itself.

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

- use a full proof run, not `--dry-run`, `--skip-mcp`, `--allow-missing-vectors`, or `--mock-embeddings`
- HTTP proof passes
- MCP proof passes
- filtered and unfiltered proof cases pass
- successful HTTP and MCP responses report `query_dim` matching the deployed runtime expectation
- artifacts are written under `artifacts/validation-runs/<run_id>/`

Only that full run counts for Step 3 completion wording. Dry-run, skip-MCP,
missing-vector, and mock-embedding modes are still useful for scaffolding or
smoke debugging, but they are not Step 3 acceptance evidence. The runner may
still write partial artifacts in those modes, then exits non-zero because the
proof is incomplete.

Optional stable fixtures:

```powershell
python scripts\prove_deployed_path.py `
  --stack-name trace-eval `
  --region us-east-1 `
  --repo-root . `
  --write-stable-fixtures
```

Only promote stable fixtures if the responses are representative and clean
enough to keep in the repository. Use `docs/deployed-proof-runbook.md` for the
full Step 3 acceptance sequence, artifact review expectations, and fixture
promotion guidance.

Important guardrail: the runner enforces that stable-fixture writing comes from
a full run with explicit `--stable-fixture-cases`, full HTTP and MCP
request/response artifacts for every selected case, and it blocks promotion
outside the trusted eval context unless you pass
`--allow-non-eval-stable-fixtures`.
Before committing fixtures, still confirm the manifest `dataset_uri` is
`s3://trace-vault/trace/eval/lance/`, confirm any provided `--stack-name` was
`trace-eval`, and do not promote smoke dataset examples or rely on any default
representative-fixture policy for normal Step 3 evidence.

## 8. Step 2 completion status

Step 2 is now complete in this workspace. The following have already happened:

- the local embedding-backed dataset was generated successfully
- local validation passed
- the eval dataset was promoted to `s3://trace-vault/trace/eval/lance/`
- `trace-smoke` was deployed against `uber_audit.lance`
- `trace-eval` was deployed against `trace/eval/lance`
- deployed proof passed on `trace-eval`
- that Step 3 proof is only considered complete when the accepted run includes both HTTP and MCP validation against `trace-eval`
- the smoke dataset remained available as rollback-only infra data

## 9. Rollback

Rollback should always preserve the smoke path.

If `trace-eval` behaves unexpectedly:

- leave `trace-smoke` untouched
- use `trace-smoke` for infra debugging and smoke checks
- fix the eval dataset or deployment and redeploy `trace-eval`

If a future shared or main stack ever needs rollback, point it back to:

- `TraceDataBucketName=trace-vault`
- `TraceLancePrefix=uber_audit.lance`

and redeploy.

## 10. Documentation updates after successful deployment

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

## 11. Known environment note

At the time this runbook was written, local dataset generation and validation had
already been completed once in this workspace at:

- `.test-tmp\eval-seed\uber_audit.lance`
- `.test-tmp\eval-seed\uber_audit.seed-manifest.json`
- `.test-tmp\eval-seed\uber_audit.eval-validation.json`

If those artifacts are still current and trusted, you may reuse them for the
first upload. If there is any doubt, regenerate from step 1 before publishing.
