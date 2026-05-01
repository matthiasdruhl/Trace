# Rust crate documentation index

Reference links for the Rust crates that matter to the current Trace implementation.

## Primary crates

| Crate | Role | Docs |
| --- | --- | --- |
| `lance` | Dataset access and nearest-neighbor search | [https://lancedb.github.io/lance/rust/lance/index.html](https://lancedb.github.io/lance/rust/lance/index.html) |
| `lance-linalg` | Distance metric support used by the search path | [https://docs.rs/lance-linalg/latest/lance_linalg/](https://docs.rs/lance-linalg/latest/lance_linalg/) |
| `aws-sdk-s3` | S3 client access for dataset-backed execution | [https://docs.rs/aws-sdk-s3/latest/aws_sdk_s3/](https://docs.rs/aws-sdk-s3/latest/aws_sdk_s3/) |
| `lambda_runtime` | AWS Lambda runtime integration | [https://docs.rs/lambda_runtime/latest/lambda_runtime/](https://docs.rs/lambda_runtime/latest/lambda_runtime/) |
| `arrow-array` | Arrow array access during response serialization | [https://docs.rs/arrow-array/latest/arrow_array/](https://docs.rs/arrow-array/latest/arrow_array/) |
| `arrow-schema` | Arrow type inspection for projected result fields | [https://docs.rs/arrow-schema/latest/arrow_schema/](https://docs.rs/arrow-schema/latest/arrow_schema/) |

## Notes

- Older planning docs referenced DuckDB heavily, but the current implementation uses a constrained filter parser compiled into Lance/DataFusion-compatible predicates instead.
- Treat these links as implementation references, not product documentation.
