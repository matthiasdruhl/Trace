# Project Trace: Codex Best Practices
## Strategy for the $100 Challenge Credit Allocation

### 1. The Token Economy
Since you have a specific $100 budget for the Codex Creator Challenge, you must treat tokens as a finite resource.
* **Small Model for Iteration:** Use the smaller, cheaper Codex-mini (or equivalent) for repetitive boilerplate, unit tests, and JSON schema generation.
* **Large Model for Logic:** Save the high-reasoning Codex-O (or equivalent) for the "Agentic Handshake" (MCP Server logic) and the core Rust-to-S3 streaming logic.
* **Context Pruning:** Do not send 2,000 lines of code if you only need a 50-line function fixed. Summarize the context manually to save 80% of token costs.

### 2. Prompt Engineering for Infrastructure
Codex excels when given a high degree of technical specificity.
* **Provide Type Definitions:** Before asking Codex to write a function, provide the Rust structs or TypeScript interfaces. It grounds the model in your specific data types.
* **Chain-of-Thought Execution:** Ask Codex to "Plan the steps for the S3 Byte-Range fetch before writing any code." Review the plan first; it's cheaper to correct a plan than to debug 200 lines of wrong code.
* **Comment-Driven Development:** Write your function headers and docstrings first, then ask Codex to "Complete the implementation."

### 3. The MCP Specialization
The Model Context Protocol (MCP) is likely a core judging pillar.
* **Focus Codex on "Skills":** Use Codex specifically to design the `tools` and `resources` definitions for the MCP server. It understands the OpenAI-standard interaction patterns better than generic IDE models.
* **Verification Logic:** Ask Codex to "Write an automated test suite for this MCP tool to ensure it handles malformed JSON inputs gracefully."

### 4. Integration with Cursor
* **Codex as the "Senior Reviewer":** Use Cursor for the bulk of the coding, but take your most complex, high-risk logic to the Codex Playground.
* **Final Audit:** Before submission, take your core Rust engine code and ask Codex: "Identify potential concurrency issues or memory leaks in this Lambda-native streaming logic."
