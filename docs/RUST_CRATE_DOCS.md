# Rust crate API documentation index

Canonical entry points for Trace’s primary Rust dependencies. Use these URLs with Cursor **@Docs**, team bookmarks, or when cross-checking signatures while implementing the Lambda search engine.

## Index

| Crate | Role in Trace | API documentation |
| :--- | :--- | :--- |
| **lance** | Columnar vector dataset format, IVF-PQ search, and range-friendly I/O against object storage. | [lancedb.github.io — `lance` crate](https://lancedb.github.io/lance/rust/lance/index.html) |
| **duckdb** | Embedded SQL over metadata and pre-filtering before or alongside vector retrieval. | [docs.rs — `duckdb`](https://docs.rs/duckdb/latest/duckdb/) |
| **aws-sdk-s3** | S3 object and byte-range access without pulling full archives into Lambda memory. | [docs.rs — `aws-sdk-s3`](https://docs.rs/aws-sdk-s3/latest/aws_sdk_s3/) |

## Notes

- **Lance:** The project-hosted Rust API book at `lancedb.github.io` tracks the same crate as [docs.rs `lance`](https://docs.rs/lance/latest/lance/); prefer whichever layout your tools index best, but treat the hosted book as the primary navigation target when it is available.
- **DuckDB:** The Rust crate wraps the embedded DuckDB engine; refer to type and function docs on docs.rs for connection, prepared statements, and Arrow integration.
- **AWS SDK for S3:** Use the client and operation builders in this crate for `GetObject` with range headers, retries, and regional configuration consistent with AWS Lambda’s execution role.
