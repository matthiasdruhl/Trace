# Cold-Storage Semantic Search Engine

### **Enterprise Intelligence at S3 Prices**

The **Cold-Storage Semantic Search Engine** is a high-performance, cloud-native infrastructure tool designed to solve the "Digital Hoarding" crisis. It allows enterprises to perform natural language, semantic searches across massive, "cold" data archives (S3/Object Storage) without the $1,000+/month price tag of traditional "always-on" vector databases.

---

## 🚀 The Core Ideas

### **1. "Zero-Idle" Infrastructure**
Traditional vector databases (Pinecone, Weaviate) are "always-on," charging for compute even when no one is searching. This project utilizes a **Serverless-First** approach where the engine only "wakes up" via AWS Lambda to handle a query, resulting in **$0.00 idle costs**.

### **2. Object-Storage Native Indexing**
Instead of keeping expensive vectors in RAM or on high-speed SSDs, this architecture treats **Amazon S3** as the primary database. By using the **Lance** columnar format, the system can perform "random access" scans on multi-terabyte files without downloading the entire dataset, cutting storage costs by up to **90%**.

### **3. Hybrid Analytical Retrieval**
The breakthrough isn't just searching vectors; it's combining them with structured data. By integrating **DuckDB**, the engine can filter metadata (e.g., "Find files from *Project X* in *2023*") while simultaneously performing a semantic search (e.g., "...about *structural failure*").

### **4. "Dark Data" Illumination**
Enterprises sit on petabytes of "Dark Data"—unstructured logs, legal depositions, and old project archives that are too expensive to index but too risky to delete. This product provides a cost-effective way to make these archives searchable for **Legal Discovery, Audits, and Historical Research**.

---

## 🏗️ System Architecture Highlights
* **Event-Driven Ingestion:** Automated vectorization triggered by S3 file uploads.
* **Decoupled Storage & Compute:** Scale your data to petabytes without needing to manage a single server.
* **Latency Optimization:** Achieves sub-300ms retrieval by utilizing range-requests and local caching within ephemeral Lambda environments.

---

## 📊 The "Efficiency" Moat
| Metric | Industry Standard | **Cold-Storage Search** |
| :--- | :--- | :--- |
| **Storage Tier** | High-Speed RAM/SSD | **S3 / Object Storage** |
| **Monthly Cost (1TB)** | ~$600.00+ | **~$5.00 - $40.00** |
| **Maintenance** | Cluster Management | **Zero-Ops (Serverless)** |

---

## 🛡️ Strategic Roadmap
* **Multi-Cloud Portability:** Seamless search across AWS, Azure, and Google Cloud.
* **Privacy-First Design:** Deployment within a private VPC to ensure data never leaves the enterprise boundary.
* **Local-Daemon Sync:** A Rust-based service to bridge local desktop files with cloud archives.

---

## Rust API documentation

Indexed links for the core crates (**Lance**, **DuckDB**, **AWS SDK for S3**) used by the search engine are in [`docs/RUST_CRATE_DOCS.md`](docs/RUST_CRATE_DOCS.md).

---

## Python: synthetic data seed (`scripts/seed.py`)

Install dependencies with the **transitive lock** so every sub-dependency matches CI and other machines:

```bash
pip install -r scripts/requirements.txt -c scripts/constraints.txt
```

Direct dependencies are listed in `scripts/requirements.txt`; exact versions of all transitive packages are pinned in `scripts/constraints.txt`. Regenerate the lock after changing bounds in `requirements.txt` (use a clean virtual environment, `pip install -r scripts/requirements.txt`, then `pip freeze` into `scripts/constraints.txt` and restore the first-line comment in that file).

### Regenerating local Lance datasets

`scripts/seed.py` writes **generated** Lance tables under `./lance_seed/` by default (100k rows; large on disk). Optional paths such as `./_smoke_lance_seed/` are for smaller local or smoke runs. These directories are **gitignored**; they are not part of the source tree—clone the repo and regenerate when you need data.

From the repository root:

```bash
pip install -r scripts/requirements.txt -c scripts/constraints.txt

# Default: 100k rows → ./lance_seed/ (IVF-PQ index; expect hundreds of MB on disk)
python scripts/seed.py

# Smaller local dataset (example: 2k rows, separate output directory)
python scripts/seed.py --rows 2000 --output-dir _smoke_lance_seed --force
```

Use `--force` when overwriting an existing table in the same directory. Upload to S3 is off by default (`--skip-upload`); see `python scripts/seed.py --help` and `docs/DATA_SPEC.md` for column layout and optional staging or promotion flags.

---
