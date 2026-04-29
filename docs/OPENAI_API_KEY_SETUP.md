# OpenAI API Key Setup

Last updated: 2026-04-29

Use [README.md](C:/Users/matth/Projects/Trace/Trace/README.md) to choose the
right workflow and
[docs/DEPLOYMENT_RUNBOOK.md](C:/Users/matth/Projects/Trace/Trace/docs/DEPLOYMENT_RUNBOOK.md)
for the main operator path. This document is the credential setup reference for
local embedding-backed commands only.

## Purpose

Use this document only to put `OPENAI_API_KEY` into your local shell and verify
that local embedding-backed commands can see it.

If `OPENAI_API_KEY` is missing in a fresh shell, local embedding-backed commands will fail:

```powershell
.\.venv-seed\Scripts\python.exe scripts\seed.py --embedding-mode openai --rows 5 --output-dir .test-tmp\openai-seed-check --table-name openai_check --force
```

That is expected until the key is added for the current shell or persisted at
the user level. For the full eval dataset workflow, return to
[docs/DEPLOYMENT_RUNBOOK.md](C:/Users/matth/Projects/Trace/Trace/docs/DEPLOYMENT_RUNBOOK.md).

## What the key is needed for

The key is required for:

- `scripts/seed.py` when using the default `--embedding-mode openai`
- `mcp-bridge` when generating real embeddings
- deployed-proof flows that use real embeddings instead of mock mode

The key is **not** required for:

- `scripts/seed.py --embedding-mode random`
- `mcp-bridge` when `USE_MOCK_EMBEDDINGS=true`

## Step by step

### 1. Create or find your OpenAI API key

1. Sign in to the OpenAI platform.
2. Open the API keys page.
3. Create a new secret key if you do not already have one.
4. Copy the key immediately and keep it somewhere secure.

## 2. Set the key for the current PowerShell session

Run this in the repo root PowerShell window:

```powershell
$env:OPENAI_API_KEY = "your_openai_api_key_here"
```

This makes the key available only in the current terminal session.

## 3. Verify the key is available

Run:

```powershell
echo $env:OPENAI_API_KEY
```

You should see the key value echoed back.

## 4. Test it in the existing Trace environment

Run a small embedding-backed seed build only as a credential visibility check:

```powershell
.\.venv-seed\Scripts\python.exe scripts\seed.py --embedding-mode openai --rows 5 --output-dir .test-tmp\openai-seed-check --table-name openai_check --force
```

If the key is configured correctly, the script should:

- build deterministic source records
- generate OpenAI embeddings
- write a `.source.parquet` file
- write a `.seed-manifest.json` file
- write a local `.lance` dataset

## 5. Optional: keep the key across new PowerShell sessions

If you want the variable to persist for your Windows user account, run:

```powershell
[System.Environment]::SetEnvironmentVariable("OPENAI_API_KEY", "your_openai_api_key_here", "User")
```

Then close and reopen PowerShell.

Verify it loaded in the new shell:

```powershell
echo $env:OPENAI_API_KEY
```

## 6. Return to the canonical workflow

Once the key is set, use
[docs/DEPLOYMENT_RUNBOOK.md](C:/Users/matth/Projects/Trace/Trace/docs/DEPLOYMENT_RUNBOOK.md)
for the canonical eval dataset, validation, promotion, and proof workflow
instead of treating this document as the main procedure guide.

## Environment notes

- This repo uses PowerShell on Windows.
- `scripts/seed.py` reads `OPENAI_API_KEY` directly from the environment.
- No `.env` file or repo config file is required for the current seed flow.
- Do not commit your API key into the repository, docs, or scripts.

## Quick fallback

If you do not want to set up the key yet, you can still run smoke mode:

```powershell
.\.venv-seed\Scripts\python.exe scripts\seed.py --embedding-mode random --rows 5 --output-dir .test-tmp\seed-smoke --table-name smoke_demo --force
```

That path works without OpenAI credentials, but it is only for smoke and
infrastructure validation, not semantic evaluation.
