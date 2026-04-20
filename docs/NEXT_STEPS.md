# Trace next steps

Last updated: 2026-04-20

This is the active prioritized backlog for the current implementation, not a sprint-era planning memo.

## 1. Prove the deployed path end to end

Highest priority:

- deploy the current SAM stack against a real S3-backed Lance dataset
- confirm `POST /search` returns real results in the deployed environment
- exercise the same endpoint through the MCP bridge
- capture one or two golden-path example queries for repeatable demos and regression checks

## 2. Align the ingestion and retrieval story

The current codebase is structurally sound, but the seed script still generates random vectors. Decide whether the next milestone should:

- keep random vectors strictly for structural/local testing and document that clearly, or
- add a real embedding-backed ingestion mode for a more faithful demo pipeline

## 3. Add deployment and operations documentation

Useful follow-up docs:

- environment setup checklist for Lambda and MCP bridge
- deployment steps from local seed to SAM deploy
- rollback and troubleshooting notes for common failures

## 4. Add benchmark evidence

The code supports the architecture claims, but the repository would benefit from measured evidence:

- cold start versus warm path timing
- latency by dataset size
- memory footprint during search
- cost-per-query estimates grounded in actual Lambda and S3 usage

## 5. Decide on the next product surface

After deployment proof is stable, choose one of:

- a small operator-facing web UI
- richer MCP ergonomics and tool outputs
- stronger ingestion realism and benchmark automation

The main rule is to extend from the current working core rather than reopening broad planning exploration.
