# Trace Web App Deployment

Last updated: 2026-04-27

This guide covers the browser-facing Trace app deployment workflow for the
current stack shape:

- static frontend in `demo-ui/`
- app API Lambda in `mcp-bridge/`
- Rust search Lambda in `lambda-engine/`
- CloudFront + frontend bucket provisioned by `template.yaml`

Use this guide when you want to update the live web app. Use
[docs/DEPLOYMENT_RUNBOOK.md](C:/Users/matth/Projects/Trace/Trace/docs/DEPLOYMENT_RUNBOOK.md)
for dataset generation, eval proof workflow, and smoke/eval rollout details.

## Current production-style stack values

- stack: `trace-eval`
- region: `us-east-1`
- dataset bucket: `trace-vault`
- dataset prefix: `trace/eval/lance`
- OpenAI secret ref: `trace/openai-api-key`
- OpenAI JSON key: `openaiApiKey`

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

## Which deploy path to use

Use `scripts/deploy-frontend.ps1` when you changed only files in `demo-ui/`.

Use `scripts/deploy-full.ps1` when you changed any of:

- `mcp-bridge/`
- `lambda-engine/`
- `template.yaml`
- frontend and backend together

## Frontend-only deploy

From the repo root:

```powershell
.\scripts\deploy-frontend.ps1
```

What it does:

- reads `AppApiBaseUrl`, `FrontendBucketName`, and `TraceAppDistributionId`
  from the CloudFormation stack
- sets `VITE_TRACE_API_BASE_URL`
- runs `npm.cmd run build` in `demo-ui/`
- syncs `demo-ui/dist` to the frontend bucket
- invalidates CloudFront

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
- deploys the current SAM template to `trace-eval`
- publishes the frontend after the stack update succeeds

Optional overrides:

```powershell
.\scripts\deploy-full.ps1 `
  -StackName trace-eval `
  -Region us-east-1 `
  -TraceDataBucketName trace-vault `
  -TraceLancePrefix trace/eval/lance `
  -OpenAiApiKeySecretRef trace/openai-api-key `
  -OpenAiApiKeySecretJsonKey openaiApiKey
```

If you want to update infrastructure without publishing the frontend yet:

```powershell
.\scripts\deploy-full.ps1 -SkipFrontendPublish
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

Run the deployed proof:

```powershell
python scripts\prove_deployed_path.py --stack-name trace-eval --region us-east-1 --repo-root .
```

Open the live app:

- [AppUrl](https://d16y21pmy9pe9s.cloudfront.net)

## Typical update workflow

### UI-only change

1. Edit files in `demo-ui/`.
2. Run `.\scripts\deploy-frontend.ps1`.
3. Refresh the CloudFront app URL.

### Backend or infra change

1. Edit files in `mcp-bridge/`, `lambda-engine/`, or `template.yaml`.
2. Run `.\scripts\deploy-full.ps1`.
3. Run the deployed proof.
4. Refresh the live app and confirm the affected behavior.

## Troubleshooting

If `sam build` fails:

- confirm `esbuild` is installed globally
- confirm Rust and `cargo lambda` still resolve

If the frontend deploy succeeds but the app looks stale:

- wait for the CloudFront invalidation to finish
- hard refresh the browser

If `/api/search` returns `{"message":"Not Found"}` in the browser:

- that is expected for a direct browser visit because the route expects `POST`
- use the UI itself, `/api/health`, or a PowerShell `POST` request to test it

If the proof runner fails:

- inspect the latest run under `artifacts/validation-runs/`
- compare stack outputs and dataset URI with the expected eval values
