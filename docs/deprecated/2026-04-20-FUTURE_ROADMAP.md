# Project Trace: Future Roadmap & Feature Rankings
## Post-MVP Scalability and Enterprise Readiness

This document outlines high-impact features to be implemented after the core MVP is stable, ranked by the ROI (Importance vs. Ease of Implementation).

### 🏆 The Priority Matrix

| Rank | Feature | Importance | Ease | ROI Score |
| :--- | :--- | :--- | :--- | :--- |
| **1** | **Hybrid Cache Layer** | High | High | **95/100** |
| **2** | **JIT PII Scrubbing** | Very High | Medium | **85/100** |
| **3** | **Automated Tiering** | Medium | Medium | **70/100** |
| **4** | **Multi-Modal Support** | Medium | Low | **50/100** |
| **5** | **Hardware Kernels** | Low | Very Low | **30/100** |

---

### 1. Hybrid Cache Layer (Rank: 1)
**Summary:** Implements a "Warm" path for frequently accessed data.
* **Concept:** Before querying S3, the Lambda checks its local `/tmp` directory or an attached EFS volume for existing index fragments or results.
* **Why it wins:** Drastically reduces latency for repeated queries (from 800ms to <50ms) and reduces S3 GET request costs.
* **Implementation:** Simple file-system check in Rust before the S3 client call.

### 2. Just-In-Time (JIT) PII Scrubbing (Rank: 2)
**Summary:** Enhances data privacy by sanitizing sensitive information before it hits the LLM.
* **Concept:** A regex-based or lightweight NLP scrubber inside the Rust Lambda that masks emails, phone numbers, and VINs in search results.
* **Why it wins:** Essential for regulated industries (Finance/Healthcare). It ensures "Zero-Trust" retrieval where private data never leaves the VPC.
* **Implementation:** Integrated into the search result serialization logic.

### 3. Automated Tiering Logic (Rank: 3)
**Summary:** Self-optimizing storage management based on query patterns.
* **Concept:** Monitors query frequency for specific S3 prefixes. If a "cold" archive becomes "hot," it triggers a migration to a more performant storage tier or a dedicated database instance.
* **Why it wins:** Balances performance and cost automatically, fulfilling the promise of "predictable infrastructure."
* **Implementation:** Requires a tracking database (e.g., DynamoDB) and an orchestration Lambda.

### 4. Multi-Modal Support (Rank: 4)
**Summary:** Expanding Trace beyond text logs.
* **Concept:** Utilizing Lance's native support for multi-modal data to store and search image (CLIP) or audio embeddings.
* **Why it wins:** Positions Trace as the unified archive for all enterprise "dark data" (e.g., Uber dashcam footage).
* **Implementation:** Requires new embedding pipelines and updated frontend visualization.

### 5. Hardware-Native Kernels (Rank: 5)
**Summary:** Extreme performance optimization for vector math.
* **Concept:** Writing custom SIMD (AVX-512 / NEON) assembly kernels for distance calculations.
* **Why it wins:** Provides a massive technical "flex" for big-tech judges, proving 5x-10x performance gains over standard libraries.
* **Implementation:** High complexity; requires low-level C/Assembly integration and hardware-specific testing.
