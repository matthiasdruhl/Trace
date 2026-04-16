# Project Trace: Master Cursor System Prompt
## Instructions for Codex Creator Challenge Build

### 1. Implementation Context
This document contains the Master System Prompt to be used in **Cursor Composer (Cmd+I)**. This prompt is designed to bypass boilerplate and force the AI to implement the high-performance, serverless architecture optimized for AWS Lambda and S3.

### 2. The Master Prompt
**Paste the following directly into Cursor Composer:**

---

**CORE DIRECTIVE:** Implement "Project Trace," a serverless vector search engine for cold data on S3. Adhere to a 5-day emergency sprint deadline (April 21).

**STACK:**
- **Language:** Rust (Stable)
- **Runtime:** AWS Lambda (ARM64 / `provided.al2023`)
- **Build Tool:** `cargo lambda`
- **Storage:** AWS S3 (Native Lance format)
- **Vector Engine:** `lance` (Rust crate) for IVF-PQ search
- **Metadata Engine:** `duckdb` (Rust crate) for SQL filtering
- **Interface:** MCP (Model Context Protocol) via Node.js/TypeScript wrapper
- **Infrastructure:** AWS SAM (`template.yaml`)

**PHASE 1: SCAFFOLDING**
1. Initialize workspace: `/lambda-engine` (Rust), `/mcp-bridge` (Node.js/TS), and `/scripts` (Python/Ingestion).

**PHASE 2: RUST LAMBDA ENGINE (`/lambda-engine`)**
1. Create async Lambda handler using `lambda_runtime` and `tokio`. Use `cargo lambda` for the build process.
2. Implement **S3 Byte-Range Requests** using `aws-sdk-s3`. Do NOT download full files. Implement robust error handling for S3 network timeouts.
3. Integrate `lance` to perform vector search directly on S3 fragments.
4. Integrate `duckdb` for relational SQL metadata filtering.
5. Expected input: OpenAI `text-embedding-3-small` (1536-dim).
6. Target memory: 512MB (to accommodate DuckDB + Lance overhead). Target execution: <800ms for 100k records. Ensure graceful degradation on OOM limits.

**PHASE 3: MCP BRIDGE (`/mcp-bridge`)**
1. Build Node.js server using `@modelcontextprotocol/sdk`.
2. Expose tool: `search_cold_archive(query_text, sql_filter, limit)`.
3. **Context Protection:** Hard-cap the returned results to a maximum of 5 records to prevent LLM context window overflow.
4. **Security:** Validate an `X-TRACE-API-KEY` header from a local `.env` file before executing any logic or calling the Lambda.
5. Handle calling the OpenAI Embedding API within this bridge before triggering the Lambda.

**PHASE 4: INGESTION SCRIPT (`/scripts/seed.py`)**
1. Python script using `lancedb` and `pandas`.
2. Load `OPENAI_API_KEY` via `python-dotenv` for embedding generation.
3. Generate **100,000 synthetic records** mimicking "Uber Regulatory & Compliance Logs."
4. Fields: `id`, `timestamp`, `city`, `document_type`, `text_content`, `vector`.
5. Upload result to S3 bucket `trace-vault`.

**PHASE 5: DEPLOYMENT (AWS SAM)**
1. Generate a `template.yaml` file in the project root.
2. Define the `trace-vault` S3 Bucket.
3. Define the Rust Lambda function, ensuring the architecture is set to `arm64` and memory is `512MB`.
4. Define the API Gateway to route requests to the Lambda function securely.

---

### 3. Usage Guidelines
* **Reference this file:** Tell Cursor to `@README.md` and `@cursor_prompt_trace.md` before starting.
* **Release Profile:** Ensure Cursor adds `lto = true` and `codegen-units = 1` to the `Cargo.toml` to minimize binary size for Lambda performance.
