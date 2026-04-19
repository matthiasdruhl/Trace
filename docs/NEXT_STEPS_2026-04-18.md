# Trace — Next steps

**Last updated:** 2026-04-18  
**Purpose:** Explicit backlog for moving Trace from “working core” to a complete MVP and a maintainable repo. Adjust dates and items as work lands.

---

## 1. Core product (highest priority)

1. **Implement metadata filtering** — Apply `sql_filter` to retrieval (today it is validated but not used). Decide approach: **DuckDB** (per `docs/COMPREHENSIVE_PLAN.md`, `docs/cursor_prompt_trace.md`) vs **Lance-native predicates**, and document the choice in `docs/API_CONTRACT.md`.
2. **Add DuckDB (or chosen filter layer) to `lambda-engine`** — If using DuckDB: add the dependency, wire a safe subset of SQL or a structured filter AST, and integrate with the vector search path without opening arbitrary SQL injection.
3. **Align embedding story end-to-end** — Same dimension and model across: seeded Lance column, `TRACE_QUERY_VECTOR_DIM`, MCP bridge (`OPENAI_EMBEDDING_MODEL` / `USE_MOCK_EMBEDDINGS`), and `scripts/seed.py` (OpenAI vs random vectors per `docs/DATA_SPEC.md` vs master prompt). Document the canonical path in one place.

## 2. Quality, build, and ops

4. **Keep the tree green** — Run locally: `cargo fmt`, `cargo clippy --all-targets -- -D warnings`, `cargo test` in `lambda-engine/`; `sam validate --lint` at repo root; `npm run build` in `mcp-bridge/`. Fix any `KernelError` / enum mismatches or other compile errors until CI-equivalent commands pass.
5. **Lambda release profile** — Add `[profile.release]` tuning if needed (`lto`, `codegen-units`) per `docs/cursor_prompt_trace.md`; re-check binary size and cold start after changes.
6. **Validate guardrails** — Measure latency and memory (e.g. targets in `docs/COMPREHENSIVE_PLAN.md`: sub-800ms, 256MB experiment vs 512MB deploy). Record methodology and numbers in-repo or in demo notes.
7. **SAM / data** — Confirm deploy path: bucket exists or is created; `TRACE_LANCE_S3_URI` (or bucket + prefix) matches seeded data; IAM allows `GetObject`/`ListBucket` on that prefix.

## 3. MCP bridge and agent UX

8. **Decide LLM result cap** — `docs/cursor_prompt_trace.md` suggested capping returned rows for context safety; the bridge currently allows up to 50. Either implement a separate “model-facing” cap or document why 50 is acceptable.
9. **Document bridge env** — Single checklist: `TRACE_SEARCH_URL`, `TRACE_API_KEY` / `TRACE_MCP_API_KEY`, `OPENAI_API_KEY`, `TRACE_QUERY_VECTOR_DIM`, `TRACE_MCP_MOCK`, `USE_MOCK_EMBEDDINGS` (point to `docs/API_CONTRACT.md` where relevant).

## 4. Documentation and repository hygiene

10. **Refresh `docs/PROJECT_STATE.md`** — It is out of date vs the repo (Lance on S3, MCP, SAM, CI). Make it the single “what exists vs not” snapshot again.
11. **Deduplicate paths** — Resolve duplicate `docs/` / `lambda-engine/` file spellings (e.g. backslash vs slash) so Git does not carry accidental duplicates.

## 5. Optional sprint / demo artifacts (from `docs/COMPREHENSIVE_PLAN.md`)

12. **Benchmarking harness** — Cold vs warm Lambda, cost-per-query notes.
13. **Showcase UI** — Small dashboard if still in scope for submission or portfolio.
14. **Demo and narrative** — Record demo, finalize pitch; keep technical docs aligned with what is actually deployed.

## 6. Post-MVP (defer until hybrid search is stable)

See `docs/FUTURE_ROADMAP.md` (cache layer, PII scrubbing, tiering, multimodal, SIMD).

---

## Quick verification (repeat anytime)

| Check | Command / action |
|--------|------------------|
| Rust | `cd lambda-engine` → `cargo test` (and fmt/clippy as in CI) |
| SAM | `sam validate --lint` |
| MCP | `cd mcp-bridge` → `npm run build` |
| End-to-end | Deploy → `POST /search` per `docs/API_CONTRACT.md`; MCP with `TRACE_SEARCH_URL` (or `TRACE_MCP_MOCK=1` for smoke) |
