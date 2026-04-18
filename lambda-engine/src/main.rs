use aws_config::BehaviorVersion;
use aws_sdk_s3::Client as S3Client;
use duckdb::Connection;
use lambda_runtime::{run, service_fn, Error, LambdaEvent};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// Direct Lambda JSON payload (or API Gateway HTTP API v2 envelope).
#[derive(Debug, Deserialize)]
struct SearchRequest {
    query_vector: Vec<f32>,
    sql_filter: String,
}

#[derive(Debug, Serialize)]
struct SearchResponse {
    message: &'static str,
    query_dim: usize,
    sql_filter: String,
}

fn parse_search_request(payload: &Value) -> Result<SearchRequest, Error> {
    if let Some(body) = payload.get("body").and_then(|b| b.as_str()) {
        return Ok(serde_json::from_str(body)?);
    }
    Ok(serde_json::from_value(payload.clone())?)
}

async fn handler(event: LambdaEvent<Value>) -> Result<Value, Error> {
    let payload = event.payload;
    let req = parse_search_request(&payload)?;

    // AWS clients (configured via standard Lambda env / IAM role).
    let sdk_config = aws_config::defaults(BehaviorVersion::latest())
        .load()
        .await;
    let _s3 = S3Client::new(&sdk_config);

    // Metadata path: DuckDB is available for SQL over manifests / sidecar tables.
    let _duckdb = Connection::open_in_memory()?;

    // Vector path: Lance will open datasets from S3 URIs in a follow-up.
    let _lance_dataset: std::marker::PhantomData<lance::Dataset> = std::marker::PhantomData;

    let body = SearchResponse {
        message: "Hello from lambda-engine",
        query_dim: req.query_vector.len(),
        sql_filter: req.sql_filter,
    };

    Ok(json!(body))
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    run(service_fn(handler)).await
}
