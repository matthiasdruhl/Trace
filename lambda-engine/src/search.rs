//! Lance-first ANN search: IVF-PQ on column `vector` (L2), optional `text_content`.

use std::sync::{Arc, OnceLock};

use arrow_array::{
    Array, ArrayRef, FixedSizeListArray, Float32Array, Float64Array, Int32Array, Int64Array,
    LargeStringArray, RecordBatch, StringArray, StringViewArray, TimestampMicrosecondArray,
    TimestampMillisecondArray, TimestampNanosecondArray, TimestampSecondArray,
};
use arrow_schema::{DataType, Field, TimeUnit};
use aws_sdk_s3::Client as S3Client;
use futures::TryStreamExt;
use lance_linalg::distance::MetricType;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tokio::sync::OnceCell;

use crate::config::EnvConfig;
use crate::error::ApiError;

pub use crate::config::DEFAULT_QUERY_VECTOR_DIM;

const DEFAULT_COLUMNS: &[&str] =
    &["incident_id", "timestamp", "city_code", "doc_type"];
const ALLOWED_COLUMNS: &[&str] = &[
    "incident_id",
    "timestamp",
    "city_code",
    "doc_type",
    "text_content",
];

fn default_k() -> u32 {
    10
}

/// Hard upper bound on `k` / `limit` after validation (Lambda protection).
pub const MAX_K: u32 = 50;

/// Max length of `sql_filter` in Unicode scalar values (what people usually mean by "characters").
pub const MAX_SQL_FILTER_CHARS: usize = 8192;

/// Caps `k` at [`MAX_K`]. Caller must ensure `k >= 1` first (see [`SearchRequest::validate`]).
fn normalize_k_upper(k: u32) -> u32 {
    k.min(MAX_K)
}

/// Search body (direct Lambda JSON or API Gateway `body` JSON).
#[derive(Debug, Deserialize)]
pub struct SearchRequest {
    pub query_vector: Vec<f32>,
    /// Result count. Omitted JSON → [`default_k`]. Use `k` or `limit` in JSON (`limit` is an alias).
    #[serde(default, alias = "limit")]
    pub k: Option<u32>,
    #[serde(default)]
    pub include_text: bool,
    #[serde(default)]
    pub columns: Option<Vec<String>>,
    /// Optional metadata filter expression (not yet applied to Lance scan).
    #[serde(default)]
    pub sql_filter: String,
}

impl SearchRequest {
    /// Returns the effective `k` after rejecting explicit zero and applying [`normalize_k_upper`].
    pub fn validate(&self) -> Result<u32, ApiError> {
        let n_chars = self.sql_filter.chars().count();
        if n_chars > MAX_SQL_FILTER_CHARS {
            return Err(ApiError::bad_request(
                "SQL_FILTER_TOO_LONG",
                format!(
                    "sql_filter must be at most {MAX_SQL_FILTER_CHARS} characters (got {n_chars})"
                ),
            ));
        }

        const MSG: &str = "Invalid limit: must be a positive integer greater than zero.";
        let k = match self.k {
            None => default_k(),
            Some(0) => {
                return Err(ApiError::bad_request("INVALID_LIMIT", MSG));
            }
            Some(k) => k,
        };
        debug_assert!(k >= 1);
        Ok(normalize_k_upper(k))
    }
}

/// JSON success envelope for `POST /search` (see `docs/API_CONTRACT.md`).
#[derive(Debug, Serialize)]
pub struct SearchResponse {
    pub ok: bool,
    pub results: Vec<Value>,
    pub query_dim: usize,
    pub k: usize,
    pub took_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stub: Option<String>,
}

pub struct RuntimeDeps<'a> {
    pub config: &'a EnvConfig,
    /// AWS S3 client (credentials chain); reserved for future object-store checks.
    #[allow(dead_code)]
    pub s3: &'a S3Client,
}

#[derive(Debug, Clone)]
enum KernelError {
    DimMismatch { expected: usize, actual: usize },
    InvalidColumn(String),
    /// Dataset missing or could not be opened from storage (no URI or provider text retained).
    DatasetNotAvailable,
    /// Object storage denied access (permissions / 403-class).
    S3AccessDenied,
    /// Internal projection / conversion failures that are safe to log but not return to clients.
    Lance { detail: String },
    /// Other Lance execution / IO failures (no raw backend message retained).
    LanceExecution,
}

fn lance_source_hint_access_denied(source: &dyn std::error::Error) -> bool {
    let mut cur: Option<&dyn std::error::Error> = Some(source);
    let mut seen = 0u8;
    while let Some(e) = cur {
        let s = e.to_string();
        if s.contains("403")
            || s.contains("AccessDenied")
            || s.contains("access denied")
            || s.contains("Access Denied")
        {
            return true;
        }
        cur = e.source();
        seen = seen.saturating_add(1);
        if seen > 8 {
            break;
        }
    }
    false
}

fn map_lance_err(err: lance::Error) -> KernelError {
    use lance::Error as E;
    match err {
        E::DatasetNotFound { source, .. } => {
            if lance_source_hint_access_denied(&*source) {
                KernelError::S3AccessDenied
            } else {
                KernelError::DatasetNotAvailable
            }
        }
        E::NotFound { .. } => KernelError::DatasetNotAvailable,
        E::IO { source, .. } => {
            if lance_source_hint_access_denied(&*source) {
                KernelError::S3AccessDenied
            } else {
                KernelError::LanceExecution
            }
        }
        E::External { source } => {
            if lance_source_hint_access_denied(&*source) {
                KernelError::S3AccessDenied
            } else {
                KernelError::LanceExecution
            }
        }
        E::Wrapped { error, .. } => {
            if lance_source_hint_access_denied(&*error) {
                KernelError::S3AccessDenied
            } else {
                KernelError::LanceExecution
            }
        }
        E::Namespace { source, .. } => {
            if lance_source_hint_access_denied(&*source) {
                KernelError::S3AccessDenied
            } else {
                KernelError::LanceExecution
            }
        }
        E::InvalidInput { source, .. } | E::NotSupported { source, .. } => {
            if lance_source_hint_access_denied(&*source) {
                KernelError::S3AccessDenied
            } else {
                KernelError::LanceExecution
            }
        }
        E::CorruptFile { source, .. }
        | E::CommitConflict { source, .. }
        | E::IncompatibleTransaction { source, .. }
        | E::RetryableCommitConflict { source, .. } => {
            if lance_source_hint_access_denied(&*source) {
                KernelError::S3AccessDenied
            } else {
                KernelError::LanceExecution
            }
        }
        E::Schema { .. }
        | E::Index { .. }
        | E::Arrow { .. }
        | E::Execution { .. }
        | E::Unprocessable { .. } => KernelError::LanceExecution,
        _ => KernelError::LanceExecution,
    }
}

fn kernel_err_to_api(e: KernelError) -> ApiError {
    match e {
        KernelError::DimMismatch { expected, actual } => ApiError::bad_request(
            "INVALID_VECTOR_DIM",
            format!("query_vector must have length {expected}, got {actual}"),
        ),
        KernelError::InvalidColumn(msg) => ApiError::bad_request("INVALID_COLUMN", msg),
        KernelError::DatasetNotAvailable => {
            ApiError::internal_categorized("dataset_not_available", "")
        }
        KernelError::S3AccessDenied => ApiError::internal_categorized("s3_access_denied", ""),
        KernelError::Lance { detail } => {
            ApiError::internal_categorized("lance_execution_error", detail)
        }
        KernelError::LanceExecution => ApiError::internal_categorized("lance_execution_error", ""),
    }
}

/// Canonical Lance URI for this runtime (first successful `run` wins).
static LANCE_CANONICAL_URI: OnceLock<String> = OnceLock::new();
static LANCE_DATASET: OnceCell<Result<Arc<lance::Dataset>, KernelError>> = OnceCell::const_new();

async fn get_or_open_dataset(lance_uri: &str) -> Result<&'static Arc<lance::Dataset>, ApiError> {
    let canonical = LANCE_CANONICAL_URI.get_or_init(|| lance_uri.to_string());
    if canonical.as_str() != lance_uri {
        return Err(ApiError::internal_categorized(
            "lance_uri_mismatch",
            "canonical dataset URI mismatch",
        ));
    }
    let uri = canonical.clone();
    let res = LANCE_DATASET
        .get_or_init(|| async move {
            lance::Dataset::open(uri.as_str())
                .await
                .map(Arc::new)
                .map_err(map_lance_err)
        })
        .await;
    match res {
        Ok(ds) => Ok(ds),
        Err(ke) => Err(kernel_err_to_api(ke.clone())),
    }
}

fn resolve_projection(req: &SearchRequest) -> Result<Vec<String>, KernelError> {
    let mut proj: Vec<String> = if let Some(cols) = &req.columns {
        if cols.is_empty() {
            return Err(KernelError::InvalidColumn(
                "`columns` must not be empty when provided".to_string(),
            ));
        }
        for c in cols {
            if !ALLOWED_COLUMNS.contains(&c.as_str()) {
                return Err(KernelError::InvalidColumn(format!(
                    "{c} is not an allowed column (allowed: {ALLOWED_COLUMNS:?})"
                )));
            }
            if c == "text_content" && !req.include_text {
                return Err(KernelError::InvalidColumn(
                    "text_content requested in `columns` but include_text is false".to_string(),
                ));
            }
        }
        cols.clone()
    } else {
        DEFAULT_COLUMNS.iter().map(|s| (*s).to_string()).collect()
    };

    if req.include_text && !proj.iter().any(|c| c == "text_content") {
        proj.push("text_content".to_string());
    }

    proj.push("_distance".to_string());
    Ok(proj)
}

fn arrow_scalar_to_json(
    col: &ArrayRef,
    row: usize,
    data_type: &DataType,
) -> Result<Value, KernelError> {
    if col.is_null(row) {
        return Ok(Value::Null);
    }
    match data_type {
        DataType::Utf8 => {
            let a = col.as_any().downcast_ref::<StringArray>().ok_or_else(|| {
                KernelError::Lance {
                    detail: "expected Utf8 (StringArray)".to_string(),
                }
            })?;
            Ok(Value::String(a.value(row).to_string()))
        }
        DataType::LargeUtf8 => {
            let a = col.as_any().downcast_ref::<LargeStringArray>().ok_or_else(|| {
                KernelError::Lance {
                    detail: "expected LargeUtf8".to_string(),
                }
            })?;
            Ok(Value::String(a.value(row).to_string()))
        }
        DataType::Utf8View => {
            let a = col.as_any().downcast_ref::<StringViewArray>().ok_or_else(|| {
                KernelError::Lance {
                    detail: "expected Utf8View".to_string(),
                }
            })?;
            Ok(Value::String(a.value(row).to_string()))
        }
        DataType::Timestamp(unit, _tz) => {
            let micros: i64 = match unit {
                TimeUnit::Second => {
                    let a = col.as_any().downcast_ref::<TimestampSecondArray>().ok_or_else(|| {
                        KernelError::Lance {
                            detail: "expected TimestampSecondArray".to_string(),
                        }
                    })?;
                    a.value(row).saturating_mul(1_000_000)
                }
                TimeUnit::Millisecond => {
                    let a = col
                        .as_any()
                        .downcast_ref::<TimestampMillisecondArray>()
                        .ok_or_else(|| KernelError::Lance {
                            detail: "expected TimestampMillisecondArray".to_string(),
                        })?;
                    a.value(row).saturating_mul(1_000)
                }
                TimeUnit::Microsecond => {
                    let a = col
                        .as_any()
                        .downcast_ref::<TimestampMicrosecondArray>()
                        .ok_or_else(|| KernelError::Lance {
                            detail: "expected TimestampMicrosecondArray".to_string(),
                        })?;
                    a.value(row)
                }
                TimeUnit::Nanosecond => {
                    let a = col
                        .as_any()
                        .downcast_ref::<TimestampNanosecondArray>()
                        .ok_or_else(|| KernelError::Lance {
                            detail: "expected TimestampNanosecondArray".to_string(),
                        })?;
                    a.value(row) / 1_000
                }
            };
            let dt = chrono::DateTime::<chrono::Utc>::from_timestamp_micros(micros).ok_or_else(|| {
                KernelError::Lance {
                    detail: "timestamp out of range".to_string(),
                }
            })?;
            // Public contract: always RFC 3339 with explicit UTC offset (`Z`).
            Ok(Value::String(dt.to_rfc3339()))
        }
        DataType::Float32 => {
            let a = col.as_any().downcast_ref::<Float32Array>().ok_or_else(|| {
                KernelError::Lance {
                    detail: "expected Float32Array".to_string(),
                }
            })?;
            Ok(serde_json::Number::from_f64(a.value(row) as f64)
                .map(Value::Number)
                .unwrap_or(Value::Null))
        }
        DataType::Float64 => {
            let a = col.as_any().downcast_ref::<Float64Array>().ok_or_else(|| {
                KernelError::Lance {
                    detail: "expected Float64Array".to_string(),
                }
            })?;
            Ok(serde_json::Number::from_f64(a.value(row))
                .map(Value::Number)
                .unwrap_or(Value::Null))
        }
        DataType::Int32 => {
            let a = col.as_any().downcast_ref::<Int32Array>().ok_or_else(|| {
                KernelError::Lance {
                    detail: "expected Int32Array".to_string(),
                }
            })?;
            Ok(Value::Number(a.value(row).into()))
        }
        DataType::Int64 => {
            let a = col.as_any().downcast_ref::<Int64Array>().ok_or_else(|| {
                KernelError::Lance {
                    detail: "expected Int64Array".to_string(),
                }
            })?;
            Ok(Value::Number(a.value(row).into()))
        }
        other => Err(KernelError::Lance {
            detail: format!("unsupported Arrow type for JSON projection: {other:?}"),
        }),
    }
}

fn record_batch_row_to_object(
    batch: &RecordBatch,
    row: usize,
) -> Result<Value, KernelError> {
    let schema = batch.schema();
    let mut map = Map::new();
    for (col_idx, field) in schema.fields().iter().enumerate() {
        let col = batch.column(col_idx);
        let name = field.name();
        let out_key = if name == "_distance" {
            "score"
        } else {
            name
        };
        let v = arrow_scalar_to_json(col, row, field.data_type())?;
        map.insert(out_key.to_string(), v);
    }
    Ok(Value::Object(map))
}

async fn run_vector_search(
    dataset: &lance::Dataset,
    req: &SearchRequest,
    k: usize,
    dim: usize,
) -> Result<Vec<Value>, KernelError> {
    if req.query_vector.len() != dim {
        return Err(KernelError::DimMismatch {
            expected: dim,
            actual: req.query_vector.len(),
        });
    }
    debug_assert!(k >= 1, "k must be validated before calling run_vector_search");

    let projection = resolve_projection(req)?;
    let proj_refs: Vec<&str> = projection.iter().map(|s| s.as_str()).collect();

    let flat = Float32Array::from_iter_values(req.query_vector.iter().copied());
    let item_field = Arc::new(Field::new("item", DataType::Float32, true));
    let query = FixedSizeListArray::try_new(
        item_field,
        dim as i32,
        Arc::new(flat),
        None,
    )
    .map_err(|e| KernelError::Lance {
        detail: format!("query vector (FixedSizeList): {e}"),
    })?;

    let mut stream = dataset
        .scan()
        .nearest("vector", &query, k)
        .map_err(map_lance_err)?
        .distance_metric(MetricType::L2)
        .use_index(true)
        .disable_scoring_autoprojection()
        .project(&proj_refs)
        .map_err(map_lance_err)?
        .try_into_stream()
        .await
        .map_err(map_lance_err)?;

    let mut hits = Vec::with_capacity(k);
    while let Some(batch) = stream.try_next().await.map_err(map_lance_err)? {
        let n = batch.num_rows();
        for row in 0..n {
            if hits.len() >= k {
                return Ok(hits);
            }
            hits.push(record_batch_row_to_object(&batch, row)?);
        }
    }

    Ok(hits)
}

/// Opens the Lance dataset (lazy, once per runtime) and runs IVF-PQ ANN search.
pub async fn run(req: &SearchRequest, deps: &RuntimeDeps<'_>) -> Result<SearchResponse, ApiError> {
    let k = req.validate()?;
    let k_usize = k as usize;
    let start = std::time::Instant::now();
    let dataset = get_or_open_dataset(deps.config.lance_uri.as_str()).await?;
    let dim = deps.config.query_vector_dim;
    let results = run_vector_search(dataset.as_ref(), req, k_usize, dim)
        .await
        .map_err(kernel_err_to_api)?;
    Ok(SearchResponse {
        ok: true,
        results,
        query_dim: dim,
        k: k_usize,
        took_ms: start.elapsed().as_millis() as u64,
        stub: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(dim: usize, k: Option<u32>) -> SearchRequest {
        SearchRequest {
            query_vector: vec![0.0; dim],
            k,
            include_text: false,
            columns: None,
            sql_filter: String::new(),
        }
    }

    #[test]
    fn validate_defaults_k_when_omitted() {
        let r = req(DEFAULT_QUERY_VECTOR_DIM, None);
        assert_eq!(r.validate().unwrap(), default_k());
    }

    #[test]
    fn validate_rejects_explicit_zero() {
        let r = req(DEFAULT_QUERY_VECTOR_DIM, Some(0));
        let e = r.validate().unwrap_err();
        assert_eq!(e.status, 400);
        assert_eq!(e.code, "INVALID_LIMIT");
        assert_eq!(
            e.message,
            "Invalid limit: must be a positive integer greater than zero."
        );
    }

    #[test]
    fn validate_clamps_upper_bound() {
        let r = req(DEFAULT_QUERY_VECTOR_DIM, Some(999));
        assert_eq!(r.validate().unwrap(), MAX_K);
    }

    #[test]
    fn serde_omitted_k_uses_default() {
        let j = format!(
            "{{\"query_vector\":{}}}",
            serde_json::to_string(&vec![0.0f32; DEFAULT_QUERY_VECTOR_DIM]).unwrap()
        );
        let r: SearchRequest = serde_json::from_str(&j).unwrap();
        assert!(r.k.is_none());
        assert_eq!(r.validate().unwrap(), default_k());
    }

    #[test]
    fn serde_limit_alias() {
        let j = format!(
            "{{\"query_vector\":{},\"limit\":3}}",
            serde_json::to_string(&vec![0.0f32; DEFAULT_QUERY_VECTOR_DIM]).unwrap()
        );
        let r: SearchRequest = serde_json::from_str(&j).unwrap();
        assert_eq!(r.k, Some(3));
        assert_eq!(r.validate().unwrap(), 3);
    }

    #[test]
    fn sql_filter_limit_counts_chars_not_utf8_bytes() {
        let mut r = req(DEFAULT_QUERY_VECTOR_DIM, None);
        // 3 UTF-8 bytes per "é" but one char each — stay under char cap even if bytes > 8192
        r.sql_filter = "é".repeat(4000);
        assert!(r.sql_filter.len() > 8192);
        assert_eq!(r.sql_filter.chars().count(), 4000);
        r.validate().unwrap();

        r.sql_filter.push_str(&"a".repeat(MAX_SQL_FILTER_CHARS - 4000 + 1));
        assert!(r.validate().is_err());
    }

    #[test]
    fn search_response_json_matches_public_contract() {
        let r = SearchResponse {
            ok: true,
            results: vec![],
            query_dim: DEFAULT_QUERY_VECTOR_DIM,
            k: 10,
            took_ms: 2,
            stub: None,
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["ok"], true);
        assert!(v["results"].is_array());
        assert_eq!(v["query_dim"], DEFAULT_QUERY_VECTOR_DIM);
        assert_eq!(v["k"], 10);
        assert_eq!(v["took_ms"], 2);
        assert!(v.get("stub").is_none());
    }

    #[test]
    fn search_response_stub_serializes_when_set() {
        let r = SearchResponse {
            ok: true,
            results: vec![],
            query_dim: 1,
            k: 1,
            took_ms: 0,
            stub: Some("placeholder".to_string()),
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["stub"], "placeholder");
    }
}
