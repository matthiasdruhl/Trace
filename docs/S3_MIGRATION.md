# Trace S3 migration guide

Last updated: 2026-04-24

## Purpose

This document records the current smoke-versus-eval S3 layout for Trace and
the rules operators should follow when refreshing or replacing datasets.

## Current AWS layout

Use these URIs consistently:

| Role | S3 URI | Status |
| --- | --- | --- |
| Random-vector smoke dataset | `s3://trace-vault/uber_audit.lance/` | Active smoke / infra dataset |
| Embedding-backed eval dataset | `s3://trace-vault/trace/eval/lance/` | Active eval / demo dataset |

## Current migration status

The primary migration is complete:

- the legacy random-vector dataset remains preserved at `s3://trace-vault/uber_audit.lance/`
- the embedding-backed eval dataset is live at `s3://trace-vault/trace/eval/lance/`
- the current deployed layout uses separate `trace-smoke` and `trace-eval` stacks in `us-east-1`

This means Trace now has a clean separation between:

- smoke / infrastructure validation
- semantic evaluation and judge-facing demos

## What each dataset is for

### Smoke dataset

Use `s3://trace-vault/uber_audit.lance/` for:

- IAM and S3 access debugging
- dataset-open and cache debugging
- API Gateway, Lambda, and MCP plumbing checks
- rollback-safe infrastructure verification

Do not use it for:

- semantic-quality claims
- benchmark relevance claims
- judge-facing demo evidence

### Eval dataset

Use `s3://trace-vault/trace/eval/lance/` for:

- deployed proof runs
- stable fixture generation
- local-versus-deployed evaluation discussion
- honest semantic retrieval demos

## Operator rules

Follow these rules whenever datasets change:

- keep the smoke dataset at `s3://trace-vault/uber_audit.lance/`
- keep eval data at a separate prefix from smoke data
- do not overwrite the smoke dataset in place to "upgrade" it
- prefer new prefixes or explicit rebuilds over mutating objects in place
- treat the eval dataset as the only acceptable source for semantic-quality demo claims

## Why the separation matters

This separation keeps Trace honest and easier to operate:

- smoke checks remain cheap and rollback-safe
- semantic demos stay grounded in real embeddings
- deployment/debugging claims do not get mixed up with retrieval-quality claims
- cache and cutover behavior stay more predictable

## What is still separate from migration

These are still important, but they are no longer migration blockers:

- broader benchmark evidence
- expanded relevance evaluation coverage
- additional operator and release-process hardening

Use `docs/NEXT_STEPS.md`, `docs/deployed-proof-runbook.md`, and
`docs/retrieval-eval-runbook.md` for the current follow-on work.
