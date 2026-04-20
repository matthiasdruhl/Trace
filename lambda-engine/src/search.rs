//! Lance-first ANN search: IVF-PQ on column `vector` (L2), optional `text_content`.

use std::sync::{Arc, OnceLock};

use arrow_array::{
    Array, ArrayRef, Float32Array, Float64Array, Int32Array, Int64Array, LargeStringArray,
    RecordBatch, StringArray, StringViewArray, TimestampMicrosecondArray,
    TimestampMillisecondArray, TimestampNanosecondArray, TimestampSecondArray,
};
use arrow_schema::{DataType, TimeUnit};
use aws_sdk_s3::Client as S3Client;
use futures::TryStreamExt;
use lance_linalg::distance::MetricType;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tokio::sync::OnceCell;

use crate::config::EnvConfig;
use crate::error::ApiError;

pub use crate::config::DEFAULT_QUERY_VECTOR_DIM;

const DEFAULT_COLUMNS: &[&str] = &["incident_id", "timestamp", "city_code", "doc_type"];
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
    /// Optional `sql_filter` field (historical name). Empty / whitespace-only means no filter.
    /// Non-empty values must parse as the constrained filter language (see [`crate::filter`]);
    /// otherwise [`SearchRequest::validate`] returns **400** (`INVALID_SQL_FILTER` / `INVALID_FILTER_VALUE`).
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

        if !self.sql_filter.trim().is_empty() {
            crate::filter::parse_filter(&self.sql_filter)?;
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
    DimMismatch {
        expected: usize,
        actual: usize,
    },
    InvalidColumn(String),
    /// Dataset missing or could not be opened from storage (no URI or provider text retained).
    DatasetNotAvailable,
    /// Object storage denied access (permissions / 403-class).
    S3AccessDenied,
    /// Internal projection / conversion failures that are safe to log but not return to clients.
    Lance {
        detail: String,
    },
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
static LANCE_DATASET: OnceCell<Arc<lance::Dataset>> = OnceCell::const_new();

async fn get_or_open_dataset_with<'a, Open, Fut>(
    lance_uri: &str,
    canonical_uri: &'a OnceLock<String>,
    dataset_cell: &'a OnceCell<Arc<lance::Dataset>>,
    open_dataset: Open,
) -> Result<&'a Arc<lance::Dataset>, ApiError>
where
    Open: FnOnce(String) -> Fut,
    Fut: std::future::Future<Output = Result<Arc<lance::Dataset>, KernelError>>,
{
    let canonical = canonical_uri.get_or_init(|| lance_uri.to_string());
    if canonical.as_str() != lance_uri {
        return Err(ApiError::internal_categorized(
            "lance_uri_mismatch",
            "canonical dataset URI mismatch",
        ));
    }
    let uri = canonical.clone();
    dataset_cell
        .get_or_try_init(|| open_dataset(uri))
        .await
        .map_err(kernel_err_to_api)
}

async fn get_or_open_dataset(lance_uri: &str) -> Result<&'static Arc<lance::Dataset>, ApiError> {
    get_or_open_dataset_with(
        lance_uri,
        &LANCE_CANONICAL_URI,
        &LANCE_DATASET,
        |uri| async move {
            lance::Dataset::open(uri.as_str())
                .await
                .map(Arc::new)
                .map_err(map_lance_err)
        },
    )
    .await
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
            let a =
                col.as_any()
                    .downcast_ref::<StringArray>()
                    .ok_or_else(|| KernelError::Lance {
                        detail: "expected Utf8 (StringArray)".to_string(),
                    })?;
            Ok(Value::String(a.value(row).to_string()))
        }
        DataType::LargeUtf8 => {
            let a = col
                .as_any()
                .downcast_ref::<LargeStringArray>()
                .ok_or_else(|| KernelError::Lance {
                    detail: "expected LargeUtf8".to_string(),
                })?;
            Ok(Value::String(a.value(row).to_string()))
        }
        DataType::Utf8View => {
            let a = col
                .as_any()
                .downcast_ref::<StringViewArray>()
                .ok_or_else(|| KernelError::Lance {
                    detail: "expected Utf8View".to_string(),
                })?;
            Ok(Value::String(a.value(row).to_string()))
        }
        DataType::Timestamp(unit, _tz) => {
            let micros: i64 = match unit {
                TimeUnit::Second => {
                    let a = col
                        .as_any()
                        .downcast_ref::<TimestampSecondArray>()
                        .ok_or_else(|| KernelError::Lance {
                            detail: "expected TimestampSecondArray".to_string(),
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
            let dt = chrono::DateTime::<chrono::Utc>::from_timestamp_micros(micros).ok_or_else(
                || KernelError::Lance {
                    detail: "timestamp out of range".to_string(),
                },
            )?;
            // Public contract: always RFC 3339 with explicit UTC offset (`Z`).
            Ok(Value::String(dt.to_rfc3339()))
        }
        DataType::Float32 => {
            let a =
                col.as_any()
                    .downcast_ref::<Float32Array>()
                    .ok_or_else(|| KernelError::Lance {
                        detail: "expected Float32Array".to_string(),
                    })?;
            Ok(serde_json::Number::from_f64(a.value(row) as f64)
                .map(Value::Number)
                .unwrap_or(Value::Null))
        }
        DataType::Float64 => {
            let a =
                col.as_any()
                    .downcast_ref::<Float64Array>()
                    .ok_or_else(|| KernelError::Lance {
                        detail: "expected Float64Array".to_string(),
                    })?;
            Ok(serde_json::Number::from_f64(a.value(row))
                .map(Value::Number)
                .unwrap_or(Value::Null))
        }
        DataType::Int32 => {
            let a =
                col.as_any()
                    .downcast_ref::<Int32Array>()
                    .ok_or_else(|| KernelError::Lance {
                        detail: "expected Int32Array".to_string(),
                    })?;
            Ok(Value::Number(a.value(row).into()))
        }
        DataType::Int64 => {
            let a =
                col.as_any()
                    .downcast_ref::<Int64Array>()
                    .ok_or_else(|| KernelError::Lance {
                        detail: "expected Int64Array".to_string(),
                    })?;
            Ok(Value::Number(a.value(row).into()))
        }
        other => Err(KernelError::Lance {
            detail: format!("unsupported Arrow type for JSON projection: {other:?}"),
        }),
    }
}

fn record_batch_row_to_object(batch: &RecordBatch, row: usize) -> Result<Value, KernelError> {
    let schema = batch.schema();
    let mut map = Map::new();
    for (col_idx, field) in schema.fields().iter().enumerate() {
        let col = batch.column(col_idx);
        let name = field.name();
        let out_key = if name == "_distance" { "score" } else { name };
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
    // Compiler-generated Lance `scan().filter(...)` predicate (`crate::filter::parse_and_compile`), never raw user text.
    sql_predicate: Option<&str>,
    // When false, nearest-neighbor runs without a vector index (used by small local test datasets).
    use_vector_index: bool,
) -> Result<Vec<Value>, KernelError> {
    if req.query_vector.len() != dim {
        return Err(KernelError::DimMismatch {
            expected: dim,
            actual: req.query_vector.len(),
        });
    }
    debug_assert!(
        k >= 1,
        "k must be validated before calling run_vector_search"
    );

    let projection = resolve_projection(req)?;
    let proj_refs: Vec<&str> = projection.iter().map(|s| s.as_str()).collect();

    // Lance 4 `nearest`: pass a flat primitive array for `FixedSizeList` columns; passing
    // `FixedSizeListArray` is reserved for multivector (`List`) columns.
    let query = Float32Array::from_iter_values(req.query_vector.iter().copied());

    let mut scan = dataset.scan();
    if let Some(pred) = sql_predicate {
        scan.filter(pred).map_err(map_lance_err)?;
    }
    let mut stream = scan
        .nearest("vector", &query, k)
        .map_err(map_lance_err)?
        .distance_metric(MetricType::L2)
        .use_index(use_vector_index)
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
    let compiled_filter = crate::filter::parse_and_compile(&req.sql_filter)?;
    let dataset = get_or_open_dataset(deps.config.lance_uri.as_str()).await?;
    let dim = deps.config.query_vector_dim;
    let results = run_vector_search(
        dataset.as_ref(),
        req,
        k_usize,
        dim,
        compiled_filter.as_deref(),
        true,
    )
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
    use arrow_array::{
        FixedSizeListArray, Float32Array, Float64Array, RecordBatch, RecordBatchIterator,
        StringArray, TimestampMillisecondArray,
    };
    use arrow_schema::{DataType, Field, Schema, TimeUnit};
    use lance::dataset::WriteParams;
    use lance::Dataset;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use tempfile::tempdir;

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
        // U+20AC is 3 UTF-8 bytes but one Unicode scalar value, so bytes can exceed the cap
        // while the character count remains below it.
        r.sql_filter = "\u{20AC}".repeat(3000);
        assert!(r.sql_filter.len() > 8192);
        assert_eq!(r.sql_filter.chars().count(), 3000);
        let e = r.validate().unwrap_err();
        assert_eq!(e.code, "INVALID_SQL_FILTER");

        r.sql_filter = "\u{20AC}".repeat(3000);
        r.sql_filter
            .push_str(&"a".repeat(MAX_SQL_FILTER_CHARS - 3000 + 1));
        let e = r.validate().unwrap_err();
        assert_eq!(e.code, "SQL_FILTER_TOO_LONG");
    }

    #[test]
    fn sql_filter_exact_char_limit_is_allowed_when_trim_empty() {
        let mut r = req(DEFAULT_QUERY_VECTOR_DIM, None);
        r.sql_filter = " ".repeat(MAX_SQL_FILTER_CHARS);
        assert_eq!(r.sql_filter.chars().count(), MAX_SQL_FILTER_CHARS);
        assert_eq!(r.validate().unwrap(), default_k());
    }

    #[test]
    fn validate_accepts_supported_sql_filter() {
        let mut r = req(DEFAULT_QUERY_VECTOR_DIM, None);
        r.sql_filter = "city_code = 'NYC-TLC'".to_string();
        assert_eq!(r.validate().unwrap(), default_k());
    }

    #[test]
    fn validate_rejects_malformed_sql_filter() {
        let mut r = req(DEFAULT_QUERY_VECTOR_DIM, None);
        r.sql_filter = "city_code = 'NYC-TLC'; DROP TABLE foo;".to_string();
        let e = r.validate().unwrap_err();
        assert_eq!(e.code, "INVALID_SQL_FILTER");
    }

    #[test]
    fn validate_rejects_empty_in_list() {
        let mut r = req(DEFAULT_QUERY_VECTOR_DIM, None);
        r.sql_filter = "city_code IN ()".to_string();
        let e = r.validate().unwrap_err();
        assert_eq!(e.status, 400);
        assert_eq!(e.code, "INVALID_SQL_FILTER");
    }

    #[test]
    fn validate_accepts_whitespace_only_sql_filter() {
        let mut r = req(DEFAULT_QUERY_VECTOR_DIM, None);
        r.sql_filter = "  \n\t  ".to_string();
        assert_eq!(r.validate().unwrap(), default_k());
    }

    #[test]
    fn resolve_projection_rejects_empty_columns() {
        let mut r = req(DEFAULT_QUERY_VECTOR_DIM, None);
        r.columns = Some(vec![]);
        let err = resolve_projection(&r).unwrap_err();
        match err {
            KernelError::InvalidColumn(msg) => assert!(msg.contains("must not be empty")),
            other => panic!("expected invalid column error, got {other:?}"),
        }
    }

    #[test]
    fn resolve_projection_rejects_unknown_column() {
        let mut r = req(DEFAULT_QUERY_VECTOR_DIM, None);
        r.columns = Some(vec!["unknown".to_string()]);
        let err = resolve_projection(&r).unwrap_err();
        match err {
            KernelError::InvalidColumn(msg) => assert!(msg.contains("unknown")),
            other => panic!("expected invalid column error, got {other:?}"),
        }
    }

    #[test]
    fn resolve_projection_rejects_text_without_include_text() {
        let mut r = req(DEFAULT_QUERY_VECTOR_DIM, None);
        r.columns = Some(vec!["text_content".to_string()]);
        let err = resolve_projection(&r).unwrap_err();
        match err {
            KernelError::InvalidColumn(msg) => assert!(msg.contains("include_text is false")),
            other => panic!("expected invalid column error, got {other:?}"),
        }
    }

    #[test]
    fn resolve_projection_auto_adds_text_content_when_include_text_true() {
        let mut r = req(DEFAULT_QUERY_VECTOR_DIM, None);
        r.include_text = true;
        let proj = resolve_projection(&r).unwrap();
        assert!(proj.iter().any(|c| c == "text_content"));
        assert!(proj.iter().any(|c| c == "_distance"));
    }

    #[test]
    fn record_batch_row_to_object_renames_distance_and_formats_timestamp() {
        let schema = Arc::new(Schema::new(vec![
            Field::new("incident_id", DataType::Utf8, true),
            Field::new("_distance", DataType::Float64, false),
            Field::new(
                "timestamp",
                DataType::Timestamp(TimeUnit::Millisecond, None),
                true,
            ),
        ]));
        let batch = RecordBatch::try_new(
            schema,
            vec![
                Arc::new(StringArray::from(vec![None::<&str>])),
                Arc::new(Float64Array::from(vec![0.25])),
                Arc::new(TimestampMillisecondArray::from(vec![Some(
                    1_700_000_000_000i64,
                )])),
            ],
        )
        .unwrap();

        let row = record_batch_row_to_object(&batch, 0).unwrap();
        assert_eq!(row["incident_id"], Value::Null);
        assert_eq!(row["score"], json!(0.25));
        assert_eq!(
            row["timestamp"],
            Value::String(
                chrono::DateTime::<chrono::Utc>::from_timestamp_millis(1_700_000_000_000)
                    .unwrap()
                    .to_rfc3339()
            )
        );
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

    /// Small vector width for local Lance fixtures (production uses [`DEFAULT_QUERY_VECTOR_DIM`]).
    const FILTER_FIXTURE_DIM: usize = 8;

    fn millis_rfc3339(s: &str) -> i64 {
        chrono::DateTime::parse_from_rfc3339(s)
            .unwrap()
            .timestamp_millis()
    }

    async fn write_filter_fixture_dataset(uri: &str) -> Dataset {
        let dim = FILTER_FIXTURE_DIM as i32;
        let item = Arc::new(Field::new("item", DataType::Float32, true));
        let schema = Arc::new(Schema::new(vec![
            Field::new("incident_id", DataType::Utf8, false),
            Field::new(
                "timestamp",
                DataType::Timestamp(TimeUnit::Millisecond, None),
                false,
            ),
            Field::new("city_code", DataType::Utf8, false),
            Field::new("doc_type", DataType::Utf8, false),
            Field::new("vector", DataType::FixedSizeList(item.clone(), dim), false),
        ]));

        let v_nyc_a: Vec<f32> = vec![1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0];
        let v_sf: Vec<f32> = vec![0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0];
        let v_nyc_b: Vec<f32> = vec![0.9, 0.1, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0];
        let v_unicode: Vec<f32> = vec![0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0];

        let flat: Vec<f32> = v_nyc_a
            .iter()
            .chain(v_sf.iter())
            .chain(v_nyc_b.iter())
            .chain(v_unicode.iter())
            .copied()
            .collect();
        let vec_field = Arc::new(Field::new("item", DataType::Float32, true));
        let vectors =
            FixedSizeListArray::try_new(vec_field, dim, Arc::new(Float32Array::from(flat)), None)
                .unwrap();

        let batch = RecordBatch::try_new(
            schema.clone(),
            vec![
                Arc::new(StringArray::from(vec!["inc-1", "inc-2", "inc-3", "inc-4"])),
                Arc::new(TimestampMillisecondArray::from(vec![
                    millis_rfc3339("2025-06-01T12:00:00Z"),
                    millis_rfc3339("2025-06-15T12:00:00Z"),
                    millis_rfc3339("2025-07-01T12:00:00Z"),
                    millis_rfc3339("2025-08-01T12:00:00Z"),
                ])),
                Arc::new(StringArray::from(vec![
                    "NYC-TLC", "SF-CPUC", "NYC-TLC", "NYC-TLC",
                ])),
                Arc::new(StringArray::from(vec![
                    "Insurance_Lapse_Report",
                    "Safety_Incident_Log",
                    "Safety_Incident_Log",
                    "报告",
                ])),
                Arc::new(vectors),
            ],
        )
        .unwrap();

        let reader = RecordBatchIterator::new(vec![Ok(batch)], schema);
        Dataset::write(reader, uri, Some(WriteParams::default()))
            .await
            .unwrap()
    }

    fn incident_set(results: &[Value]) -> std::collections::HashSet<String> {
        results
            .iter()
            .map(|r| r["incident_id"].as_str().unwrap().to_string())
            .collect()
    }

    async fn search_fixture(
        dataset: &Dataset,
        query: Vec<f32>,
        k: u32,
        sql_filter: &str,
    ) -> Result<Vec<Value>, ApiError> {
        let req = SearchRequest {
            query_vector: query,
            k: Some(k),
            include_text: false,
            columns: None,
            sql_filter: sql_filter.to_string(),
        };
        let k = req.validate()? as usize;
        let compiled = crate::filter::parse_and_compile(&req.sql_filter)?;
        run_vector_search(
            dataset,
            &req,
            k,
            FILTER_FIXTURE_DIM,
            compiled.as_deref(),
            false,
        )
        .await
        .map_err(kernel_err_to_api)
    }

    #[tokio::test]
    async fn filter_narrows_lance_scan_before_nearest() {
        let tmp = tempdir().unwrap();
        let uri = tmp.path().to_str().unwrap();
        let ds = write_filter_fixture_dataset(uri).await;

        let query: Vec<f32> = vec![1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0];
        let all = search_fixture(&ds, query.clone(), 10, "").await.unwrap();
        let nyc = search_fixture(&ds, query.clone(), 10, "city_code = 'NYC-TLC'")
            .await
            .unwrap();
        let in_types = search_fixture(
            &ds,
            query.clone(),
            10,
            "doc_type IN ('Insurance_Lapse_Report', '报告')",
        )
        .await
        .unwrap();
        let july = search_fixture(
            &ds,
            query,
            10,
            "timestamp >= '2025-07-01T00:00:00Z' AND timestamp < '2025-09-01T00:00:00Z'",
        )
        .await
        .unwrap();

        assert!(
            all.len() >= 3,
            "unfiltered search should return multiple candidates"
        );
        let all_ids = incident_set(&all);
        assert!(all_ids.contains("inc-1"));
        assert!(all_ids.contains("inc-2"));

        assert_eq!(
            incident_set(&nyc),
            ["inc-1", "inc-3", "inc-4"]
                .into_iter()
                .map(String::from)
                .collect()
        );
        assert_eq!(
            incident_set(&in_types),
            ["inc-1", "inc-4"].into_iter().map(String::from).collect()
        );
        assert_eq!(
            incident_set(&july),
            ["inc-3", "inc-4"].into_iter().map(String::from).collect()
        );
    }

    #[tokio::test]
    async fn omitting_scan_filter_includes_excluded_rows_regression_guard() {
        let tmp = tempdir().unwrap();
        let uri = tmp.path().to_str().unwrap();
        let ds = write_filter_fixture_dataset(uri).await;

        let req = SearchRequest {
            query_vector: vec![1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
            k: Some(10),
            include_text: false,
            columns: None,
            sql_filter: "city_code = 'SF-CPUC'".to_string(),
        };
        let k = req.validate().unwrap() as usize;
        let pred = crate::filter::parse_and_compile(&req.sql_filter)
            .unwrap()
            .unwrap();

        let with_filter = run_vector_search(&ds, &req, k, FILTER_FIXTURE_DIM, Some(&pred), false)
            .await
            .unwrap();
        let without = run_vector_search(&ds, &req, k, FILTER_FIXTURE_DIM, None, false)
            .await
            .unwrap();

        assert_eq!(
            incident_set(&with_filter),
            ["inc-2"].into_iter().map(String::from).collect()
        );
        assert!(incident_set(&without).contains("inc-1"));
        assert!(incident_set(&without).len() > with_filter.len());
    }

    #[tokio::test]
    async fn invalid_filter_request_path_returns_400() {
        let tmp = tempdir().unwrap();
        let uri = tmp.path().to_str().unwrap();
        let ds = write_filter_fixture_dataset(uri).await;

        let err = search_fixture(&ds, vec![1.0; FILTER_FIXTURE_DIM], 5, "city_code IN ()")
            .await
            .unwrap_err();
        assert_eq!(err.status, 400);
        assert_eq!(err.code, "INVALID_SQL_FILTER");
    }

    #[tokio::test]
    async fn filter_unicode_literal_end_to_end() {
        let tmp = tempdir().unwrap();
        let uri = tmp.path().to_str().unwrap();
        let ds = write_filter_fixture_dataset(uri).await;

        let hits = search_fixture(
            &ds,
            vec![0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0],
            5,
            "doc_type = '报告'",
        )
        .await
        .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0]["incident_id"], json!("inc-4"));
    }

    #[tokio::test]
    async fn filter_escaped_quote_literal_end_to_end() {
        let tmp = tempdir().unwrap();
        let uri = tmp.path().to_str().unwrap();
        let dim = FILTER_FIXTURE_DIM as i32;
        let item = Arc::new(Field::new("item", DataType::Float32, true));
        let schema = Arc::new(Schema::new(vec![
            Field::new("incident_id", DataType::Utf8, false),
            Field::new(
                "timestamp",
                DataType::Timestamp(TimeUnit::Millisecond, None),
                false,
            ),
            Field::new("city_code", DataType::Utf8, false),
            Field::new("doc_type", DataType::Utf8, false),
            Field::new("vector", DataType::FixedSizeList(item.clone(), dim), false),
        ]));
        let v: Vec<f32> = vec![1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0];
        let vec_col =
            FixedSizeListArray::try_new(item, dim, Arc::new(Float32Array::from(v)), None).unwrap();
        let batch = RecordBatch::try_new(
            schema.clone(),
            vec![
                Arc::new(StringArray::from(vec!["oq"])),
                Arc::new(TimestampMillisecondArray::from(vec![millis_rfc3339(
                    "2025-01-01T00:00:00Z",
                )])),
                Arc::new(StringArray::from(vec!["O'Reilly-TLC"])),
                Arc::new(StringArray::from(vec!["Insurance_Lapse_Report"])),
                Arc::new(vec_col),
            ],
        )
        .unwrap();
        let reader = RecordBatchIterator::new(vec![Ok(batch)], schema);
        let ds = Dataset::write(reader, uri, Some(WriteParams::default()))
            .await
            .unwrap();

        let hits = search_fixture(
            &ds,
            vec![1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
            5,
            "city_code = 'O''Reilly-TLC'",
        )
        .await
        .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0]["incident_id"], json!("oq"));
    }

    #[tokio::test]
    async fn dataset_open_failures_are_not_cached() {
        let tmp = tempdir().unwrap();
        let uri = tmp.path().to_str().unwrap().to_string();
        let dataset = Arc::new(write_filter_fixture_dataset(uri.as_str()).await);
        let canonical_uri = OnceLock::new();
        let dataset_cell = OnceCell::new();
        let open_attempts = Arc::new(AtomicUsize::new(0));

        let err = get_or_open_dataset_with(uri.as_str(), &canonical_uri, &dataset_cell, {
            let dataset = Arc::clone(&dataset);
            let open_attempts = Arc::clone(&open_attempts);
            move |_opened_uri| {
                let dataset = Arc::clone(&dataset);
                let open_attempts = Arc::clone(&open_attempts);
                async move {
                    let attempt = open_attempts.fetch_add(1, Ordering::SeqCst);
                    if attempt == 0 {
                        Err(KernelError::LanceExecution)
                    } else {
                        Ok(dataset)
                    }
                }
            }
        })
        .await
        .unwrap_err();
        assert_eq!(err.status, 500);
        assert_eq!(err.code, "INTERNAL");
        assert_eq!(open_attempts.load(Ordering::SeqCst), 1);

        let reopened = get_or_open_dataset_with(uri.as_str(), &canonical_uri, &dataset_cell, {
            let dataset = Arc::clone(&dataset);
            let open_attempts = Arc::clone(&open_attempts);
            move |_opened_uri| {
                let dataset = Arc::clone(&dataset);
                let open_attempts = Arc::clone(&open_attempts);
                async move {
                    open_attempts.fetch_add(1, Ordering::SeqCst);
                    Ok(dataset)
                }
            }
        })
        .await
        .unwrap();
        assert!(Arc::ptr_eq(reopened, &dataset));
        assert_eq!(open_attempts.load(Ordering::SeqCst), 2);

        let cached = get_or_open_dataset_with(
            uri.as_str(),
            &canonical_uri,
            &dataset_cell,
            |_opened_uri| async move {
                panic!("cached dataset should be reused without reopening");
            },
        )
        .await
        .unwrap();
        assert!(Arc::ptr_eq(cached, &dataset));
        assert_eq!(open_attempts.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn dataset_open_preserves_canonical_uri_guard() {
        let tmp = tempdir().unwrap();
        let uri = tmp.path().to_str().unwrap().to_string();
        let dataset = Arc::new(write_filter_fixture_dataset(uri.as_str()).await);
        let canonical_uri = OnceLock::new();
        let dataset_cell = OnceCell::new();
        let open_attempts = Arc::new(AtomicUsize::new(0));

        let opened = get_or_open_dataset_with(uri.as_str(), &canonical_uri, &dataset_cell, {
            let dataset = Arc::clone(&dataset);
            let open_attempts = Arc::clone(&open_attempts);
            move |_opened_uri| {
                let dataset = Arc::clone(&dataset);
                let open_attempts = Arc::clone(&open_attempts);
                async move {
                    open_attempts.fetch_add(1, Ordering::SeqCst);
                    Ok(dataset)
                }
            }
        })
        .await
        .unwrap();
        assert!(Arc::ptr_eq(opened, &dataset));

        let err = get_or_open_dataset_with(
            "file:///different-dataset",
            &canonical_uri,
            &dataset_cell,
            |_opened_uri| async move {
                panic!("canonical URI mismatch should fail before opening");
            },
        )
        .await
        .unwrap_err();
        assert_eq!(err.status, 500);
        assert_eq!(err.code, "INTERNAL");
        assert_eq!(open_attempts.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn filter_not_nested_excludes_match() {
        let tmp = tempdir().unwrap();
        let uri = tmp.path().to_str().unwrap();
        let ds = write_filter_fixture_dataset(uri).await;

        let hits = search_fixture(
            &ds,
            vec![1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
            10,
            "city_code = 'NYC-TLC' AND NOT doc_type = 'Insurance_Lapse_Report'",
        )
        .await
        .unwrap();
        assert_eq!(
            incident_set(&hits),
            ["inc-3", "inc-4"].into_iter().map(String::from).collect()
        );
    }

    #[test]
    fn filter_keyword_boundary_and_is_not_suffix_of_ident() {
        let err = crate::filter::parse_filter("city_codeAND = 'X'").unwrap_err();
        assert_eq!(err.code, "INVALID_SQL_FILTER");
    }

    #[test]
    fn filter_keyword_boundary_not_prefix_of_ident() {
        let e = crate::filter::parse_filter("NOTcity_code = 'X'").unwrap_err();
        assert_eq!(e.code, "INVALID_SQL_FILTER");
    }
}
