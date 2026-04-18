# Project Trace: Resource & Phase Allocation Plan
## 14-Day Sprint (Codex, Cursor, Gemini)

### Phase 1: Architecture & Strategic Design (Days 1-3)
**Tool:** Gemini (Primary)
**Focus:** Low-token research and structural planning.
* **Tasks:**
    - Refine DuckDB + Lance schema for S3.
    - Draft the "Uber Michelangelo" alignment strategy.
    - Create the "Synthetic Dataset" JSON structure.
* **Token Management:** Use Gemini to "compress" ideas into 1-page specs. This prevents feeding bloated or vague prompts to Codex later.

### Phase 2: Engine Construction (Days 4-8)
**Tool:** Cursor Pro (Primary)
**Focus:** High-context codebase building.
* **Tasks:**
    - Initialize Rust Lambda project.
    - Implement S3 range-request fetching.
    - Integrate IVF-PQ logic via the Lance library.
* **Token Management:**
    - Use `@Codebase` sparingly. Index only the `/src` folder.
    - Leverage the **Cursor Pro** plan's "premium small model" for boilerplate and "Claude 3.5/GPT-4" for the core vector math logic.
    - Always "Accept" or "Reject" diffs immediately to keep the context window clean.

### Phase 3: Integration & Agentic Interface (Days 9-12)
**Tool:** Codex (Primary - Challenge Credits)
**Focus:** Automation and Agentic Skills (MCP).
* **Tasks:**
    - Build the MCP Server (Model Context Protocol).
    - Create the "Agent Skill" for OpenAI Codex.
    - Automate the ingestion pipeline (Python/Docling).
* **Token Management ($100 Budget):**
    - Use the **Codex-Mini** model for repetitive Python scripts (cheapest).
    - Use the **Codex-High-O** model only for the complex MCP server-client handshake logic.
    - Target: $5-$7 per day. You should end the challenge with $20+ remaining.

### Phase 4: Benchmarking & Submission (Days 13-14)
**Tool:** Gemini (Pitch) + Cursor (Debugging)
**Focus:** Final polish and performance validation.
* **Tasks:**
    - Run final latency tests.
    - Generate performance charts via Gemini/Code Interpreter.
    - Draft the final README and Submission Video script.

### Token Optimization Hard Rules:
1. **Never re-generate:** If Codex writes a function that works but is ugly, keep it. Don't waste tokens on "beautifying" code during a 2-week sprint.
2. **The 3-Error Rule:** If Cursor/Codex fails to fix a bug 3 times, **STOP**. Copy the error into Gemini to get a fresh perspective, then go back with the fix.
3. **Context Pruning:** Every 3 days, delete your `target/` and `.cache` folders to ensure the AI isn't indexing thousands of lines of useless build logs.
