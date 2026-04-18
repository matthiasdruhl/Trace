# Project Trace: 5-Day Emergency Sprint & Submission Plan
## Codex Creator Challenge (Deadline: April 21)

### 1. Project Vision
**Trace** is a serverless, cold-storage vector search engine designed for high-scale agentic memory. It enables AI agents to query massive archives on S3 with sub-second latency and zero idle costs.

---

### 2. Technical Stack & Architecture
* **Storage:** AWS S3 (Native Lance format).
* **Search Engine:** Rust-based AWS Lambda (ARM64) using `lance` (IVF-PQ) and `duckdb`.
* **Interface:** Model Context Protocol (MCP) Node.js Server.
* **Infrastructure:** AWS SAM (Serverless Application Model).

---

### 3. Comprehensive Implementation Schedule

#### Day 1: Data Infrastructure (Friday)
* **Goal:** Populate S3 with the 100,000-record "Uber Audit" dataset.
* **Tasks:**
    - Initialize S3 bucket `trace-vault`.
    - Build `/scripts/seed.py` using **Cursor** + `@DATA_SPEC.md`.
    - Run ingestion and verify `.lance` files in S3.
* **Delegation:** Cursor (Scripts), Gemini (AWS CLI commands).

#### Day 2: The Core Search Kernel (Saturday)
* **Goal:** Implement the Rust search Lambda.
* **Tasks:**
    - Scaffolding with `cargo-lambda`.
    - Implement S3 Byte-Range requests for stateless Lance index access.
    - Embed DuckDB for SQL metadata pre-filtering.
* **Delegation:** Cursor (Primary Coding), Gemini (Rust Logic/Error Review).

#### Day 3: The Agent Interface (Sunday)
* **Goal:** Connect the engine to the AI Agent ecosystem.
* **Tasks:**
    - Build Node.js MCP Server bridge.
    - Map `search_cold_archive` tool.
    - Implement OpenAI `text-embedding-3-small` vectorization in the bridge.
* **Delegation:** Codex (MCP Protocol logic), Cursor (Bridge implementation).

#### Day 4: Benchmarking & Dashboard (Monday)
* **Goal:** Validate performance and create a "Showcase" UI.
* **Tasks:**
    - Latency testing (Cold vs. Warm start).
    - Cost-per-query calculation.
    - Build simple web dashboard for visualization.
* **Delegation:** Gemini (Data Analysis), Cursor (Frontend).

#### Day 5: Submission Production (Tuesday)
* **Goal:** Finalize the pitch and record the demo.
* **Tasks:**
    - Record 2-minute "Wow" demo video.
    - Finalize technical documentation.
    - Submit via Codex Creator Challenge portal.
* **Delegation:** Gemini (Pitch Copywriting).

---

### 4. Technical Guardrails & Constraints
* **Memory Limit:** Lambda must stay within 256MB RAM.
* **Performance:** Sub-800ms end-to-end query time.
* **Cost:** $0.00 idle cost, <$0.0001 per query.
* **Security:** `X-TRACE-API-KEY` header authentication mandatory.

---

### 5. Final Delegation Table
| Domain | Lead Tool | Input Resource |
| :--- | :--- | :--- |
| System Architecture | Gemini | `README.md` |
| Rust/AWS Engineering | Cursor | `CURSOR_PROMPT.md` |
| Synthetic Data | Cursor | `DATA_SPEC.md` |
| Agent Interactivity | Codex | Challenge Credits |
