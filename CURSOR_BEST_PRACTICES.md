# Project Trace: Cursor Best Practices
## Optimizing the "Emergency Build" Experience

### 1. Context Control (The @ Rules)
Cursor is only as smart as the context you provide. In a high-stakes sprint, manage your context window to avoid hallucination.
* **@Files:** Always explicitly reference `@CURSOR_PROMPT.md` or `@DATA_SPEC.md` when starting a new task.
* **@Codebase:** Use sparingly. Only use this when you need the AI to understand cross-file dependencies (e.g., "How does my MCP server call my Rust Lambda?").
* **@Docs:** Add the documentation for `lance`, `duckdb`, and `aws-sdk-s3` directly. This ensures Cursor doesn't use outdated API methods.
* AWS S3 (Rust SDK): https://docs.rs/aws-sdk-s3/latest/aws_sdk_s3/

Lance (Core Engine): https://docs.rs/lance/latest/lance/

DuckDB (Metadata): https://docs.rs/duckdb/latest/duckdb/

### 2. The Composer Workflow (Cmd+I)
The **Composer** is your multi-file engine. Use it for high-level scaffolding.
* **Scaffolding:** "Based on @CURSOR_PROMPT.md, initialize the project structure and create the Cargo.toml for the /lambda-engine."
* **Incremental Implementation:** Don't ask for the whole project at once. Ask for the **S3 Fetch Logic**, then once that works, ask for the **Lance Search Logic**.
* **Immediate Review:** Always review the diffs. If Cursor suggests deleting a vital AWS configuration, hit "Reject" immediately.

### 3. The "3-Strike" Debugging Rule
If Cursor fails to fix a bug in three consecutive attempts, **stop**.
1. Copy the error message and the relevant code.
2. Paste it into **Gemini**.
3. Ask: "Identify the logical flaw Cursor is missing."
4. Bring the specific fix back to Cursor. This prevents wasting your Pro token limits on recursive loops.

### 4. Terminal Integration
* **Command Generation:** Use `Cmd+K` in the terminal to generate commands like `cargo lambda build --release`.
* **Auto-Fix:** When a build fails, click the "Fix with AI" button in the terminal. It is significantly faster at resolving dependency mismatches than manual chatting.

### 5. Housekeeping
* **Prune Cache:** Every morning, delete `target/` and `.cursor` cache if the AI starts acting sluggish.
* **Commit Often:** Use Cursor's built-in git integration to commit every time a feature (like "S3 Byte Range Fetch") works. This gives you a "Save Point" if a future prompt breaks the logic.
