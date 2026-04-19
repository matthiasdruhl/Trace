use std::env::VarError;
use std::sync::{Once, OnceLock};

use aws_config::BehaviorVersion;
use aws_sdk_s3::Client as S3Client;
use tokio::sync::OnceCell;

static AUTH_MODE_LOGGED: Once = Once::new();

/// `TRACE_MAX_PAYLOAD_BYTES` was set but is not a positive integer byte count.
pub const ERR_MAX_PAYLOAD_BYTES: &str =
    "Invalid TRACE_MAX_PAYLOAD_BYTES: Must be a positive integer representing bytes.";

const DEFAULT_MAX_PAYLOAD_BYTES: usize = 256 * 1024;

/// Default query/embedding dimension when `TRACE_QUERY_VECTOR_DIM` is unset (e.g. OpenAI
/// `text-embedding-3-small`–sized vectors). Must match the Lance column width and index.
pub const DEFAULT_QUERY_VECTOR_DIM: usize = 1536;

/// Exclusive upper bound for [`EnvConfig::query_vector_dim`] (sanity check vs index / column).
const MAX_QUERY_VECTOR_DIM: usize = 10_000;

fn parse_query_vector_dim() -> Result<usize, String> {
    const VAR: &str = "TRACE_QUERY_VECTOR_DIM";
    const ERR_DIM_NOT_INT: &str =
        "Invalid TRACE_QUERY_VECTOR_DIM: must be a positive integer less than 10000";
    let raw = match std::env::var(VAR) {
        Err(VarError::NotPresent) => return Ok(DEFAULT_QUERY_VECTOR_DIM),
        Err(e) => return Err(format!("{VAR}: {e}")),
        Ok(s) => s,
    };
    let t = raw.trim();
    if t.is_empty() {
        return Ok(DEFAULT_QUERY_VECTOR_DIM);
    }
    let n = t.parse::<usize>().map_err(|_| ERR_DIM_NOT_INT.to_string())?;
    if n == 0 {
        return Err(ERR_DIM_NOT_INT.to_string());
    }
    if n >= MAX_QUERY_VECTOR_DIM {
        return Err(format!(
            "Invalid {VAR}: must be less than {MAX_QUERY_VECTOR_DIM} (must match Lance index column width)"
        ));
    }
    Ok(n)
}

const ERR_LANCE_S3_URI_SHAPE: &str =
    "Invalid Configuration: TRACE_LANCE_S3_URI must be a valid s3:// path and cannot be blank.";

fn env_nonempty(name: &'static str, raw: Result<String, std::env::VarError>) -> Result<String, String> {
    let s = raw.map_err(|e| format!("{name}: {e}"))?;
    let t = s.trim();
    if t.is_empty() {
        return Err(format!("Invalid Configuration: {name} cannot be blank."));
    }
    Ok(t.to_string())
}

/// Parses `s3://bucket` or `s3://bucket/key/parts`, trims slashes, returns normalized URI and bucket + key prefix.
fn validate_normalize_s3_lance_uri(raw: &str) -> Result<(String, String, String), String> {
    let t = raw.trim();
    if t.is_empty() {
        return Err(ERR_LANCE_S3_URI_SHAPE.to_string());
    }
    if !t.starts_with("s3://") {
        return Err(ERR_LANCE_S3_URI_SHAPE.to_string());
    }
    let after_scheme = t.strip_prefix("s3://").unwrap_or("");
    let after_scheme = after_scheme.trim_start_matches('/');
    if after_scheme.is_empty() {
        return Err(ERR_LANCE_S3_URI_SHAPE.to_string());
    }

    let (bucket_raw, key_raw) = match after_scheme.find('/') {
        None => (after_scheme, ""),
        Some(i) => (&after_scheme[..i], &after_scheme[i + 1..]),
    };

    let bucket = bucket_raw.trim().trim_end_matches('/');
    let key = key_raw.trim().trim_start_matches('/').trim_end_matches('/');

    if bucket.is_empty() {
        return Err(ERR_LANCE_S3_URI_SHAPE.to_string());
    }

    let lance_uri = if key.is_empty() {
        format!("s3://{}", bucket)
    } else {
        format!("s3://{}/{}", bucket, key)
    };

    Ok((lance_uri, bucket.to_string(), key.to_string()))
}

fn lance_uri_from_bucket_and_prefix(bucket: &str, prefix: &str) -> Result<(String, String, String), String> {
    let bucket = bucket.trim().trim_end_matches('/');
    let prefix = prefix.trim().trim_start_matches('/').trim_end_matches('/');
    if bucket.is_empty() {
        return Err("Invalid Configuration: TRACE_S3_BUCKET cannot be blank.".to_string());
    }
    if prefix.is_empty() {
        return Err("Invalid Configuration: TRACE_LANCE_PREFIX cannot be blank.".to_string());
    }
    let lance_uri = format!("s3://{}/{}", bucket, prefix);
    Ok((lance_uri, bucket.to_string(), prefix.to_string()))
}

/// Environment configuration for the Lambda (see template.yaml and docs/API_CONTRACT.md).
#[derive(Clone, Debug)]
pub struct EnvConfig {
    /// Normalized `s3://bucket` or `s3://bucket/prefix/...` for Lance (single source of truth).
    pub lance_uri: String,
    /// Bucket name, aligned with `lance_uri` (no trailing slash).
    pub s3_bucket: String,
    /// Object key prefix under the bucket, aligned with `lance_uri` (no leading or trailing slashes).
    pub lance_prefix: String,
    /// When `Some`, HTTP API invocations must send `X-TRACE-API-KEY` matching this value (constant-time compare).
    /// When `None`, header checks are skipped (rely on IAM / resource policies).
    /// In SAM, this can be injected from Secrets Manager via a template dynamic reference (no runtime Secrets SDK).
    pub api_key_secret: Option<String>,
    pub max_payload_bytes: usize,
    /// Expected `query_vector` length; must match Lance `vector` column / IVF-PQ index (`TRACE_QUERY_VECTOR_DIM`).
    pub query_vector_dim: usize,
}

impl EnvConfig {
    pub fn from_env() -> Result<Self, String> {
        let (lance_uri, s3_bucket, lance_prefix) =
            match std::env::var("TRACE_LANCE_S3_URI") {
                Err(VarError::NotPresent) => {
                    let bucket = env_nonempty("TRACE_S3_BUCKET", std::env::var("TRACE_S3_BUCKET"))?;
                    let prefix =
                        env_nonempty("TRACE_LANCE_PREFIX", std::env::var("TRACE_LANCE_PREFIX"))?;
                    lance_uri_from_bucket_and_prefix(&bucket, &prefix)?
                }
                Err(e) => {
                    return Err(format!("TRACE_LANCE_S3_URI: {e}"));
                }
                Ok(s) => {
                    if s.trim().is_empty() {
                        return Err(ERR_LANCE_S3_URI_SHAPE.to_string());
                    }
                    validate_normalize_s3_lance_uri(&s)?
                }
            };

        let api_key_secret = std::env::var("TRACE_API_KEY_SECRET")
            .ok()
            .and_then(|s| {
                let t = s.trim();
                if t.is_empty() {
                    None
                } else {
                    Some(t.to_string())
                }
            });

        AUTH_MODE_LOGGED.call_once(|| {
            match &api_key_secret {
                None => tracing::info!("AUTH MODE: IAM-only (No API Key required)"),
                Some(_) => tracing::info!("AUTH MODE: API Key + IAM"),
            }
        });

        let max_payload_bytes = match std::env::var("TRACE_MAX_PAYLOAD_BYTES") {
            Err(VarError::NotPresent) => DEFAULT_MAX_PAYLOAD_BYTES,
            Err(e) => {
                return Err(format!("TRACE_MAX_PAYLOAD_BYTES: {e}"));
            }
            Ok(s) => {
                let n = s
                    .trim()
                    .parse::<usize>()
                    .map_err(|e| format!("{ERR_MAX_PAYLOAD_BYTES} ({e})"))?;
                if n == 0 {
                    return Err(ERR_MAX_PAYLOAD_BYTES.to_string());
                }
                n
            }
        };

        let query_vector_dim = parse_query_vector_dim()?;

        Ok(Self {
            lance_uri,
            s3_bucket,
            lance_prefix,
            api_key_secret,
            max_payload_bytes,
            query_vector_dim,
        })
    }
}

static RUNTIME_CONFIG: OnceLock<EnvConfig> = OnceLock::new();

/// Call once from the Lambda binary `main` after a successful [`EnvConfig::from_env`].
pub fn set_runtime_config(cfg: EnvConfig) {
    tracing::info!(
        query_vector_dim = cfg.query_vector_dim,
        max_payload_bytes = cfg.max_payload_bytes,
        "runtime configuration loaded"
    );
    RUNTIME_CONFIG
        .set(cfg)
        .expect("set_runtime_config: configuration already initialized");
}

/// Configuration loaded at process start ([`set_runtime_config`]).
pub fn runtime_config() -> &'static EnvConfig {
    RUNTIME_CONFIG
        .get()
        .expect("set_runtime_config must be called from main before handling requests")
}

static SDK_CONFIG: OnceCell<aws_config::SdkConfig> = OnceCell::const_new();
static S3_CLIENT: OnceCell<S3Client> = OnceCell::const_new();

pub async fn sdk_config() -> &'static aws_config::SdkConfig {
    SDK_CONFIG
        .get_or_init(|| async {
            aws_config::defaults(BehaviorVersion::latest())
                .load()
                .await
        })
        .await
}

pub async fn s3_client() -> &'static S3Client {
    S3_CLIENT
        .get_or_init(|| async { S3Client::new(sdk_config().await) })
        .await
}

/// Small delay so cold-start benchmarks stay honest; no-op at runtime.
pub async fn warmup_clients() {
    let _ = s3_client().await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_explicit_uri_trailing_slashes() {
        let (uri, bucket, prefix) =
            validate_normalize_s3_lance_uri("s3://my-bucket///data/lance///").unwrap();
        assert_eq!(uri, "s3://my-bucket/data/lance");
        assert_eq!(bucket, "my-bucket");
        assert_eq!(prefix, "data/lance");
    }

    #[test]
    fn rejects_non_s3_uri() {
        assert!(validate_normalize_s3_lance_uri("https://x").is_err());
    }

    #[test]
    fn bucket_prefix_builds_uri() {
        let (uri, b, p) = lance_uri_from_bucket_and_prefix("  b ", " /p/ ").unwrap();
        assert_eq!(uri, "s3://b/p");
        assert_eq!(b, "b");
        assert_eq!(p, "p");
    }
}
