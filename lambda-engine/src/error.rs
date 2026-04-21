/// Client-visible message for any HTTP 500 response (no stack traces, paths, or bucket names).
pub const INTERNAL_CLIENT_MESSAGE: &str = "Internal Server Error";

const LOG_DETAIL_MAX_CHARS: usize = 512;

/// Redacts obvious storage URIs and caps length so backend/`Display` strings are safe for CloudWatch.
pub fn sanitize_for_log(input: &str) -> String {
    let mut s = input.to_string();
    while let Some(pos) = s.find("s3://") {
        let after = pos + "s3://".len();
        let end = s[after..]
            .char_indices()
            .find(|(_, c)| c.is_whitespace() || matches!(c, ')' | ']' | '"' | '\'' | ',' | ';'))
            .map(|(i, _)| after + i)
            .unwrap_or(s.len());
        s.replace_range(pos..end, "<redacted-s3-uri>");
    }
    if s.len() > LOG_DETAIL_MAX_CHARS {
        s.truncate(LOG_DETAIL_MAX_CHARS.saturating_sub(3));
        s.push_str("...");
    }
    s
}

#[derive(Debug)]
pub struct ApiError {
    pub status: u16,
    pub code: &'static str,
    /// User-facing text for non-5xx errors; for `internal()` this is always [`INTERNAL_CLIENT_MESSAGE`].
    pub message: String,
}

impl ApiError {
    pub fn bad_request(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status: 400,
            code,
            message: message.into(),
        }
    }

    pub fn unauthorized(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status: 401,
            code,
            message: message.into(),
        }
    }

    pub fn payload_too_large(message: impl Into<String>) -> Self {
        Self {
            status: 413,
            code: "PAYLOAD_TOO_LARGE",
            message: message.into(),
        }
    }

    /// Logs a sanitized detail string under a stable `category` (CloudWatch). The JSON API response is always generic.
    pub fn internal_categorized(category: &'static str, detail_for_log: impl Into<String>) -> Self {
        let raw = detail_for_log.into();
        let sanitized = sanitize_for_log(&raw);
        if sanitized.is_empty() {
            tracing::error!(category, "internal error");
        } else {
            tracing::error!(category, detail_sanitized = %sanitized, "internal error");
        }
        Self {
            status: 500,
            code: "INTERNAL",
            message: INTERNAL_CLIENT_MESSAGE.to_string(),
        }
    }

    /// Same client behavior as [`Self::internal_categorized`] with category `"internal"`.
    pub fn internal(detail: impl Into<String>) -> Self {
        Self::internal_categorized("internal", detail)
    }

    fn client_safe_message(&self) -> &str {
        if self.status >= 500 {
            INTERNAL_CLIENT_MESSAGE
        } else {
            self.message.as_str()
        }
    }

    pub fn to_json_value(&self) -> serde_json::Value {
        serde_json::json!({
            "ok": false,
            "error": {
                "code": self.code,
                "message": self.client_safe_message(),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_masks_500_message_even_if_struct_message_leaked() {
        let e = ApiError {
            status: 500,
            code: "INTERNAL",
            message: "s3://bucket/secret/path".to_string(),
        };
        let v = e.to_json_value();
        assert_eq!(
            v["error"]["message"].as_str(),
            Some(INTERNAL_CLIENT_MESSAGE)
        );
    }

    #[test]
    fn json_keeps_400_message() {
        let e = ApiError::bad_request("BAD", "Invalid query vector");
        let v = e.to_json_value();
        assert_eq!(v["error"]["message"].as_str(), Some("Invalid query vector"));
    }

    #[test]
    fn sanitize_redacts_s3_uri() {
        let s = sanitize_for_log("open s3://my-bucket/secret/path failed");
        assert!(!s.contains("my-bucket"));
        assert!(s.contains("<redacted-s3-uri>"));
    }

    #[test]
    fn sanitize_truncates_long_strings() {
        let long = "x".repeat(600);
        assert!(sanitize_for_log(&long).len() <= 512);
    }

    #[test]
    fn sanitize_redacts_multiple_s3_uris() {
        let s = sanitize_for_log("copy s3://bucket-a/a then s3://bucket-b/b");
        assert!(!s.contains("bucket-a"));
        assert!(!s.contains("bucket-b"));
        assert_eq!(s.matches("<redacted-s3-uri>").count(), 2);
    }

    #[test]
    fn sanitize_stops_at_punctuation_boundaries() {
        let s = sanitize_for_log("failed (s3://bucket/secret/path), retrying");
        assert!(s.contains("(<redacted-s3-uri>),"));
    }
}
