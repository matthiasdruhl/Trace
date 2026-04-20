# Project Trace (formerly IceVault)
## Serverless "Cold Search" Vector Infrastructure for Agentic Memory

### 1. Executive Summary
**Trace** is a high-performance, zero-idle-cost vector search engine designed specifically for "Dark Data" stored in cloud object storage (AWS S3). Unlike traditional vector databases (Pinecone, Databricks) that require always-on clusters, Trace utilizes a decoupled architecture—leveraging AWS Lambda and the Lance file format—to enable billion-scale search with 90% lower operational costs.

### 2. The Core Problem
* **The "AI Tax":** Enterprises pay thousands per month to keep "Cold Data" (historical logs, compliance archives, legal documents) indexed in memory-resident databases.
* **Agentic Memory Gap:** AI Agents struggle to access massive S3 archives because the latency and cost of traditional retrieval-augmented generation (RAG) at scale are prohibitive.
* **System Lock-in:** Current solutions require moving sensitive data into third-party managed clouds.

### 3. Technical Architecture (The "Winning" Stack)
* **Storage Layer:** AWS S3 (Standard/Intelligent-Tiering) utilizing the **Lance** columnar format for high-speed range requests.
* **Compute Layer:** **AWS Lambda** (Stateless) running an optimized **Rust binary**.
* **Query Engine:** * **Algorithm:** IVF-PQ (Inverted File Index with Product Quantization) to allow searching without loading the full index into RAM.
    * **Metadata Filtering:** **DuckDB** embedded within the Lambda for full SQL-power over vector metadata.
* **Integration Layer:** **Model Context Protocol (MCP)** Server, allowing OpenAI Codex/GPT agents to call Trace as a native tool.

### 4. Competitive Moat
| Feature | Competitors (Pinecone/Databricks) | Trace |
| :--- | :--- | :--- |
| **Idle Cost** | $200 - $1,000+ / month | **$0.00** |
| **Data Privacy** | Third-party Managed Cloud | **In-VPC (Your AWS Account)** |
| **Metadata** | Basic Key-Value | **Full SQL (DuckDB)** |
| **Ingestion** | User-managed ETL | **High-Fidelity PDF (Docling/Marker)** |

### 5. Deployment & Scalability
* **Automated Tiering:** Automatically handles data movement between RAM (Warm), S3 (Cold), and Glacier (Frozen) based on query heatmaps.
* **Hardware Optimization:** Architecture optimized for **AWS Graviton (ARM64)** using SIMD/NEON intrinsics for hardware-accelerated math.

### 6. Codex Creator Challenge 2026 Strategy (Uber Sponsorship)
* **The Angle:** "Predictable Infrastructure for Agentic Memory."
* **Uber Alignment:** Built to complement Uber’s **Michelangelo** platform by handling the "Long-Tail" of regulatory and driver support data.
* **Key Submission Piece:** A functioning **MCP Server** that enables a Codex agent to perform deep-archive compliance searches in sub-second timeframes.

### 7. Two-Week Sprint Roadmap
* **Week 1 (Engine):** * Rust-based Lambda for S3 range-request fetching.
    * Lance/DuckDB integration for IVF-PQ search logic.
    * Docling ingestion pipeline for PDF-to-Vector conversion.
* **Week 2 (Interface & Pitch):**
    * MCP Server implementation for Codex integration.
    * Synthetic "Uber Regulatory" dataset generation.
    * Final benchmarks (Latency/Cost/Memory footprint).

### 8. Reference Notes for Codex
* **Preferred Libraries:** `lance`, `duckdb`, `lambda_runtime`, `aws-sdk-s3`.
* **Hardware Target:** ARM64 (Graviton 3/4).
* **Constraints:** 128MB - 512MB RAM target for Lambda to ensure lowest cost-per-query.