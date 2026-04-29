# Trace Web App Deployment

Last updated: 2026-04-29

This guide covers the browser-facing Trace app deployment workflow for the
current stack shape:

- static frontend in `demo-ui/`
- app API Lambda in `mcp-bridge/`
- Rust search Lambda in `lambda-engine/`
- CloudFront + frontend bucket provisioned by `template.yaml`

Use this guide when you want to update the live web app. Use
[docs/DEPLOYMENT_RUNBOOK.md](C:/Users/matth/Projects/Trace/Trace/docs/DEPLOYMENT_RUNBOOK.md)
for dataset generation, eval proof workflow, and smoke/eval rollout details.

## When to use this guide

Use this document when you need the browser app publish path:

- frontend-only deploys
- full app publishes that package app-facing code and then publish the frontend
- app-specific smoke tests for `/`, `/api/health`, and `/api/search`
- app-specific troubleshooting and emergency override steps

Do not use this document as the primary guide for:

- dataset generation or dataset refresh
- smoke/eval rollout strategy
- proof acceptance rules or stable fixture promotion

Those remain in
[docs/DEPLOYMENT_RUNBOOK.md](C:/Users/matth/Projects/Trace/Trace/docs/DEPLOYMENT_RUNBOOK.md)
and
[docs/deployed-proof-runbook.md](C:/Users/matth/Projects/Trace/Trace/docs/deployed-proof-runbook.md).

## Current production-style stack values

- stack: `trace-eval`
- region: `us-east-1`
- dataset bucket: `trace-vault`
- dataset prefix: `trace/eval/lance`
- OpenAI secret ref: `trace/openai-api-key`
- OpenAI secret format: plain text `SecretString`
- OpenAI JSON key: empty by default

## Prerequisites

Before deploying, confirm:

```powershell
aws sts get-caller-identity
sam --version
esbuild --version
node --version
npm.cmd --version
```

You also need:

- a deployed stack or permission to deploy one
- an OpenAI secret in AWS Secrets Manager
- local repo access at `C:\Users\matth\Projects\Trace\Trace`

Current OpenAI secret convention:

- store `trace/openai-api-key` as a plain-text secret
- do not wrap the key in JSON
- keep `OpenAiApiKeySecretJsonKey` empty
- let the app API Lambda read the secret at runtime via
  `OPENAI_API_KEY_SECRET_REF`; do not reintroduce direct stack-managed
  `OPENAI_API_KEY` plaintext injection

## First-time secret setup

If `trace/openai-api-key` does not exist yet, create it in AWS Secrets Manager
before the first app deploy:

```powershell
aws secretsmanager create-secret `
  --name trace/openai-api-key `
  --secret-string "YOUR_REAL_OPENAI_KEY" `
  --region us-east-1
```

Verify the secret exists:

```powershell
aws secretsmanager describe-secret `
  --secret-id trace/openai-api-key `
  --region us-east-1
```

This is the deployed app secret path. Use
[docs/OPENAI_API_KEY_SETUP.md](C:/Users/matth/Projects/Trace/Trace/docs/OPENAI_API_KEY_SETUP.md)
only for local shell credential setup for embedding-backed commands.

## Which deploy path to use

Use `scripts/deploy-frontend.ps1` when you changed only files in `demo-ui/`.

Use `scripts/deploy-full.ps1` when you are intentionally publishing the browser
app together with app-facing backend changes.

Start in
[docs/DEPLOYMENT_RUNBOOK.md](C:/Users/matth/Projects/Trace/Trace/docs/DEPLOYMENT_RUNBOOK.md)
first if the change is primarily about:

- dataset refresh
- smoke/eval rollout strategy
- canonical stack rollout or rollback decisions
- deployed proof rerun entrypoints

## Frontend-only deploy

From the repo root:

```powershell
.\scripts\deploy-frontend.ps1
```

What it does for the app publish path:

- reads `AppApiBaseUrl`, `FrontendBucketName`, and `TraceAppDistributionId`
  from the CloudFormation stack
- sets `VITE_TRACE_API_BASE_URL`
- runs `npm.cmd run build` in `demo-ui/`
- syncs `demo-ui/dist` to the frontend bucket
- invalidates CloudFront and waits for completion
- smoke-tests the deployed root, `/api/health`, and a real `POST /api/search`

Optional overrides:

```powershell
.\scripts\deploy-frontend.ps1 -StackName trace-eval -Region us-east-1
```

## Full stack deploy

From the repo root:

```powershell
.\scripts\deploy-full.ps1
```

What it does:

- runs `sam build --beta-features`
- deploys the current SAM template to `trace-eval` as part of the app publish flow
- converts blank secret-ref and JSON-key parameters to the sentinel
  `__EMPTY__` so SAM clears stale stack values instead of silently reusing an
  earlier secret configuration
- publishes the frontend only after the stack update succeeds
- runs the same post-publish smoke tests unless you opt out

Optional app-publish overrides:

```powershell
.\scripts\deploy-full.ps1 `
  -StackName trace-eval `
  -Region us-east-1 `
  -TraceDataBucketName trace-vault `
  -TraceLancePrefix trace/eval/lance `
  -OpenAiApiKeySecretRef trace/openai-api-key `
  -OpenAiApiKeySecretJsonKey ""
```

If you want to package and update the app-facing stack path without publishing the frontend yet:

```powershell
.\scripts\deploy-full.ps1 -SkipFrontendPublish
```

If you need to bypass smoke tests during an incident or partial backend outage:

```powershell
.\scripts\deploy-full.ps1 -SkipSmokeTest
.\scripts\deploy-frontend.ps1 -SkipSmokeTest
```

## Verify the deployment

After deploy, verify the stack outputs:

```powershell
aws cloudformation describe-stacks `
  --stack-name trace-eval `
  --region us-east-1 `
  --query "Stacks[0].Outputs"
```

Expected outputs include:

- `AppUrl`
- `AppApiBaseUrl`
- `FrontendBucketName`
- `TraceAppDistributionId`
- `AppApiSearchUrl`

If the change also touched shared search behavior, stack wiring, or the eval
dataset, return to
[docs/DEPLOYMENT_RUNBOOK.md](C:/Users/matth/Projects/Trace/Trace/docs/DEPLOYMENT_RUNBOOK.md)
for the proof rerun entrypoint and use
[docs/deployed-proof-runbook.md](C:/Users/matth/Projects/Trace/Trace/docs/deployed-proof-runbook.md)
for proof details and artifact review.

Open the live app:

- [AppUrl](https://d16y21pmy9pe9s.cloudfront.net)

Manual API smoke tests:

```powershell
Invoke-RestMethod https://d16y21pmy9pe9s.cloudfront.net/api/health
```

```powershell
$body = @{
  queryText = "recent vehicle inspection audit with overdue paperwork"
  filters = @{}
  limit = 3
} | ConvertTo-Json -Depth 5

Invoke-RestMethod `
  -Uri "https://d16y21pmy9pe9s.cloudfront.net/api/search" `
  -Method Post `
  -ContentType "application/json" `
  -Body $body
```

Expected smoke-test behavior:

- `/api/health` returns `ok: true` and `ready: true`
- `POST /api/search` returns `queryText`, `appliedFilter`, `results`, and `meta`
- a direct browser visit to `/api/search` still returns `Not Found` because that
  route expects `POST`, not `GET`

Current healthy response:

```json
{"ok":true,"service":"trace-app-api","ready":true,"checks":{"traceSearchUrl":true,"embeddingsConfigured":true}}
```

## Typical update workflow

### UI-only change

1. Edit files in `demo-ui/`.
2. Run `.\scripts\deploy-frontend.ps1`.
3. Refresh the CloudFront app URL.

### Backend or infra change

1. Edit files involved in the browser app publish path.
2. Run `.\scripts\deploy-full.ps1`.
3. Confirm the helper's root, health, and search smoke tests pass.
4. Return to the deployment and proof runbooks, then rerun deployed proof if the change touched shared search behavior or other search/eval behavior outside the browser app surface.
5. Refresh the live app and confirm the affected behavior.

## Troubleshooting

If `sam build` fails:

- confirm `esbuild` is installed globally
- confirm Rust and `cargo lambda` still resolve

If the frontend deploy succeeds but the app looks stale:

- wait for the CloudFront invalidation to finish
- hard refresh the browser

If the helper's `/api/search` smoke test fails:

- check `aws logs tail /aws/lambda/trace-eval-trace-app-api-v2 --since 15m --follow --region us-east-1`
- verify the OpenAI secret is plain text, not JSON
- confirm the stack parameters keep `OpenAiApiKeySecretJsonKey` empty
- confirm the live health endpoint still returns `ready: true`

If `/api/health` returns `{"message":"Internal Server Error"}` immediately after
deploy:

- check whether the app Lambda was packaged as CommonJS, not ESM
- confirm the packaged artifact is `.aws-sam/build/TraceAppApiFunctionV2/app-api.js`
- redeploy after rebuilding if you still see an old `app-api.mjs` artifact

## Manual emergency override

Use this only when you need the live app working immediately and the stack
parameter/secret wiring is still broken. This updates the deployed app API
Lambda directly rather than through CloudFormation.

```powershell
aws lambda update-function-configuration `
  --function-name trace-eval-trace-app-api-v2 `
  --environment "Variables={NODE_ENV=production,NODE_OPTIONS=--enable-source-maps,OPENAI_API_KEY=YOUR_REAL_OPENAI_KEY,OPENAI_API_KEY_SECRET_REF=trace/openai-api-key,OPENAI_API_KEY_SECRET_JSON_KEY=,OPENAI_EMBEDDING_MODEL=text-embedding-3-small,TRACE_API_KEY_SECRET_REF=,TRACE_API_KEY_SECRET_JSON_KEY=,TRACE_APP_ENABLE_FIXTURE_MODE=false,TRACE_SEARCH_URL=https://kqsqrljj11.execute-api.us-east-1.amazonaws.com/search}" `
  --region us-east-1
```

Wait for the config update to finish:

```powershell
aws lambda wait function-updated `
  --function-name trace-eval-trace-app-api-v2 `
  --region us-east-1
```

Then test the live app again.

Important behavior difference:

- `sam deploy` path: yes, redeploy is needed because the stack manages the
  Lambda environment
- direct `aws lambda update-function-configuration` path: no full redeploy is
  needed first

Important caution:

- this is a manual live override, not the preferred steady-state deployment path
- a future `sam deploy` can overwrite the manual Lambda environment unless the
  stack-managed secret-ref configuration is also fixed
- after using this escape hatch, bring the stack back into sync with the
  documented plain-text secret convention

If `/api/search` returns `{"message":"Not Found"}` in the browser:

- that is expected for a direct browser visit because the route expects `POST`
- use the UI itself, `/api/health`, or a PowerShell `POST` request to test it

If the proof runner fails:

- inspect the latest run under `artifacts/validation-runs/`
- compare stack outputs and dataset URI with the expected eval values
- then continue with
  [docs/deployed-proof-runbook.md](C:/Users/matth/Projects/Trace/Trace/docs/deployed-proof-runbook.md)
  for proof-specific debugging and acceptance checks
