use std::collections::HashMap;

use constant_time_eq::constant_time_eq;

use crate::error::ApiError;

/// Looks up a header by ASCII case-insensitive name.
///
/// Returns `Err` if more than one map key matches (e.g. both `X-Trace-Api-Key` and `x-trace-api-key`),
/// which would make authentication non-deterministic.
pub fn header_ci<'a>(
    headers: &'a HashMap<String, String>,
    name: &str,
) -> Result<Option<&'a str>, ApiError> {
    let mut matches = headers.iter().filter(|(k, _)| k.eq_ignore_ascii_case(name));
    let first = matches.next();
    match first {
        None => Ok(None),
        Some((_, v)) => {
            if matches.next().is_some() {
                Err(ApiError::bad_request(
                    "DUPLICATE_API_KEY_HEADER",
                    "Ambiguous request: Duplicate API key headers detected with inconsistent casing.",
                ))
            } else {
                Ok(Some(v.as_str()))
            }
        }
    }
}

/// When `api_key_secret` is `None`, returns `Ok` immediately (IAM-only: no header required).
/// When `Some`, enforces [`require_api_key`] against `x-trace-api-key` (case-insensitive header name).
/// An empty or whitespace client header never succeeds unless the server secret is `None`.
pub fn enforce_http_api_key_if_configured(
    api_key_secret: Option<&str>,
    headers: Option<&HashMap<String, String>>,
) -> Result<(), ApiError> {
    let Some(expected) = api_key_secret else {
        return Ok(());
    };

    match headers {
        None => {
            let empty = HashMap::new();
            let provided = header_ci(&empty, "x-trace-api-key")?;
            require_api_key(provided, expected)
        }
        Some(h) => {
            let provided = header_ci(h, "x-trace-api-key")?;
            require_api_key(provided, expected)
        }
    }
}

/// Constant-time comparison when lengths match; rejects length mismatch without leaking key material via timing beyond length.
/// Empty or whitespace-only secrets never authenticate (even if two empty strings would have the same length).
pub fn require_api_key(provided: Option<&str>, expected: &str) -> Result<(), ApiError> {
    if expected.trim().is_empty() {
        return Err(ApiError::internal(
            "API key secret is not configured; refusing request",
        ));
    }

    let Some(got) = provided else {
        return Err(ApiError::unauthorized(
            "MISSING_API_KEY",
            "Missing X-TRACE-API-KEY header",
        ));
    };

    if got.trim().is_empty() {
        return Err(ApiError::unauthorized(
            "INVALID_API_KEY",
            "Invalid X-TRACE-API-KEY",
        ));
    }

    if got.len() != expected.len() {
        return Err(ApiError::unauthorized(
            "INVALID_API_KEY",
            "Invalid X-TRACE-API-KEY",
        ));
    }

    if constant_time_eq(got.as_bytes(), expected.as_bytes()) {
        Ok(())
    } else {
        Err(ApiError::unauthorized(
            "INVALID_API_KEY",
            "Invalid X-TRACE-API-KEY",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_ci_rejects_duplicate_casings() {
        let mut headers = HashMap::new();
        headers.insert("X-TRACE-API-KEY".to_string(), "a".to_string());
        headers.insert("x-trace-api-key".to_string(), "b".to_string());
        let err = header_ci(&headers, "X-Trace-Api-Key").unwrap_err();
        assert_eq!(err.status, 400);
        assert_eq!(err.code, "DUPLICATE_API_KEY_HEADER");
    }

    #[test]
    fn header_ci_single_match_ok() {
        let mut headers = HashMap::new();
        headers.insert("X-Trace-Api-Key".to_string(), "secret".to_string());
        assert_eq!(
            header_ci(&headers, "x-trace-api-key").unwrap(),
            Some("secret")
        );
    }

    #[test]
    fn header_ci_missing_ok() {
        let headers = HashMap::new();
        assert_eq!(header_ci(&headers, "x-trace-api-key").unwrap(), None);
    }

    #[test]
    fn rejects_missing() {
        assert!(require_api_key(None, "secret").is_err());
    }

    #[test]
    fn accepts_match() {
        assert!(require_api_key(Some("abc"), "abc").is_ok());
    }

    #[test]
    fn rejects_mismatch_same_len() {
        assert!(require_api_key(Some("abd"), "abc").is_err());
    }

    #[test]
    fn rejects_empty_header_when_secret_nonempty() {
        assert!(require_api_key(Some(""), "secret").is_err());
    }

    #[test]
    fn rejects_whitespace_only_header() {
        assert!(require_api_key(Some("   "), "secret").is_err());
    }

    #[test]
    fn rejects_empty_secret_even_if_header_empty() {
        assert!(require_api_key(Some(""), "").is_err());
    }

    #[test]
    fn rejects_empty_secret_when_header_matches_nonempty_pattern() {
        assert!(require_api_key(Some("x"), "").is_err());
    }

    #[test]
    fn iam_only_skips_header_check() {
        let mut headers = HashMap::new();
        headers.insert("x-trace-api-key".to_string(), String::new());
        assert!(enforce_http_api_key_if_configured(None, Some(&headers)).is_ok());
    }

    #[test]
    fn iam_only_ok_without_headers_map() {
        assert!(enforce_http_api_key_if_configured(None, None).is_ok());
    }

    #[test]
    fn api_key_mode_rejects_empty_header_even_if_secret_nonempty() {
        let mut headers = HashMap::new();
        headers.insert("x-trace-api-key".to_string(), String::new());
        assert!(enforce_http_api_key_if_configured(Some("secret"), Some(&headers)).is_err());
    }

    #[test]
    fn api_key_mode_without_headers_map_returns_missing_api_key() {
        let err = enforce_http_api_key_if_configured(Some("secret"), None).unwrap_err();
        assert_eq!(err.status, 401);
        assert_eq!(err.code, "MISSING_API_KEY");
    }
}
