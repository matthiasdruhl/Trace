# Trace - Next steps

**Last updated:** 2026-04-20  
**Purpose:** Execution-ordered backlog for taking Trace from "working core" to a submission-ready MVP and a stronger startup prototype.

This file is intentionally opinionated. It prioritizes the next steps that matter most for the current repository state:

- the Rust Lambda search kernel exists and tests pass
- the MCP bridge exists
- the SAM template exists
- the main remaining risk is not scaffolding, but proving the real end-to-end product story

---

## 1. Must do now: finish the core product proof

These are the highest-leverage tasks. Do them before UI polish, roadmap expansion, or broad refactors.

### 1. Implement real metadata filtering in `lambda-engine`

**Why this is first:** Trace's core pitch is hybrid retrieval: semantic search plus structured metadata filtering. Right now `sql_filter` is validated, but the docs and code indicate it is not yet applied in the search path. Until this lands, the product story is only partially true.

**Required decisions**

1. Choose the filtering approach:
   - `DuckDB` for SQL-style filtering
   - Lance-native predicates if they are sufficient for the current MVP
2. Define the safe public contract:
   - limited SQL subset, or
   - structured filter AST / constrained expression grammar
3. Document the canonical behavior in `docs/API_CONTRACT.md`

**Definition of done**

- `sql_filter` changes the returned result set
- invalid or unsafe filters fail predictably
- the implementation is covered by tests
- docs no longer describe filtering as "accepted but not applied"

### 2. Prove deployed end-to-end correctness

**Why this is second:** The repository now has the pieces of the system, but the biggest remaining confidence gap is integration. The project should be able to demonstrate one real flow:

`seeded Lance dataset -> deployed Lambda -> HTTP search -> MCP bridge -> successful query`

**Required work**

1. Confirm the seeded data path matches Lambda configuration
2. Deploy the stack with the real `TRACE_LANCE_S3_URI`
3. Execute canonical queries through:
   - HTTP `POST /search`
   - the MCP bridge
4. Save one or two "golden path" examples for demo and regression testing

**Definition of done**

- the deployed search endpoint returns real Lance-backed results
- the MCP bridge successfully embeds a query and calls the endpoint
- at least one demo query is repeatable and documented

### 3. Align the embedding story end-to-end

**Why this is third:** A mismatch between seeded vectors, runtime query dimension, and MCP embeddings is one of the easiest ways to ship a demo that looks complete but fails in practice.

**Required work**

1. Pick the canonical embedding path for the MVP:
   - mock vectors for local/offline only
   - OpenAI embeddings for the real demo path
2. Ensure the same dimension and model assumptions are used across:
   - `scripts/seed.py`
   - `lambda-engine`
   - `mcp-bridge`
   - `docs/API_CONTRACT.md`
3. Make the docs explicit about what is production/demo behavior vs local-only behavior

**Definition of done**

- there is one clearly documented source of truth for vector dimension and embedding model
- local mock mode is still available for development
- the real demo path does not rely on hidden assumptions

---

## 2. Must do next: make the MVP trustworthy and demo-safe

Once the product proof is real, the next job is making the system reliable enough to show, submit, and iterate on with confidence.

### 4. Keep the tree green with CI-equivalent checks

**Required checks**

- `cargo fmt --all -- --check`
- `cargo clippy --all-targets -- -D warnings`
- `cargo test` in `lambda-engine/`
- `npm run build` in `mcp-bridge/`
- `sam validate --lint`
- `sam build --beta-features`

**Definition of done**

- local and CI behavior match as closely as possible
- build failures are treated as top-priority regressions

### 5. Validate the deployment and runtime guardrails

**Why this matters:** The challenge and startup story both depend on measurable claims, not just architecture diagrams.

**Required work**

1. Measure:
   - cold start latency
   - warm latency
   - memory usage
   - practical result counts
2. Verify:
   - the current Lambda memory setting
   - binary size / startup characteristics
   - the API key / IAM behavior
3. Record the methodology and numbers in-repo

**Definition of done**

- you can defend latency and efficiency claims with real measurements
- the project has a benchmark story suitable for a demo, README, or submission form

### 6. Tighten MCP bridge behavior for agent-facing use

**Required work**

1. Decide the model-facing result cap
2. Confirm timeout / retry behavior is sane for demos
3. Finalize the bridge environment checklist
4. Ensure the bridge exposes only the inputs you want an agent to rely on

**Definition of done**

- the bridge is predictable under normal failure modes
- environment setup is easy to reproduce
- the agent-facing interface feels intentional, not accidental

---

## 3. Should do soon: improve docs and repository hygiene

These are important, but they should follow the core product proof and deployment validation.

### 7. Refresh `docs/PROJECT_STATE.md`

This file is currently behind the repo. It should again become the single source of truth for:

- what exists
- what is partial
- what is still missing

At minimum, update it to reflect:

- the existing MCP bridge
- the existing SAM template
- the real Lance-backed search path
- any remaining filtering and deployment gaps

### 8. Refresh `README.md` for the actual MVP

The README should be submission-friendly and reality-based:

- what Trace does today
- how the system is deployed
- how to run the demo path
- what remains roadmap vs shipped

### 9. Consolidate environment and setup docs

Create or improve one clear setup checklist covering:

- Lambda env vars
- MCP bridge env vars
- seed script behavior
- local mock mode vs real cloud mode

---

## 4. Nice to have after the MVP is real

These can add polish or long-term value, but they should not delay the highest-priority work above.

### 10. Small showcase UI

A simple interface can materially improve demo quality, but only after the backend proof is real and stable.

### 11. Benchmark dashboard or cost comparison artifact

Helpful for submissions, investor conversations, and product marketing once the numbers are real.

### 12. Broader roadmap work

Defer these until the current MVP is proven:

- multicloud storage support
- multimodal retrieval
- Docling-based ingestion
- cache layers
- SIMD / deeper low-level optimization

These are strong roadmap items, but they are not the next best implementation steps for the current architecture.

---

## Recommended execution order

If time is limited, follow this order exactly:

1. real metadata filtering
2. deployed end-to-end validation
3. embedding alignment
4. CI-equivalent green builds
5. benchmark and guardrail validation
6. MCP bridge hardening
7. documentation refresh
8. demo/UI polish

---

## Quick verification checklist

Use this after each major change:

| Area | Check |
|------|-------|
| Search kernel | `cargo test` |
| Rust quality | `cargo fmt --all -- --check` and `cargo clippy --all-targets -- -D warnings` |
| MCP bridge | `npm run build` |
| SAM template | `sam validate --lint` |
| Packaging | `sam build --beta-features` |
| End-to-end | deployed `POST /search` plus one MCP query |

---

## Strategic note

For the current state of Trace, the right question is not "what else can we add?" It is:

**Can we prove the core promise clearly, reliably, and measurably?**

Until the answer is yes, the best next step is almost always to finish and validate the current hybrid search path rather than expanding the platform surface area.
