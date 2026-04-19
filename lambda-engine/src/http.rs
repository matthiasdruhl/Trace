use std::collections::HashMap;

use base64::Engine;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::ApiError;

/// Client-facing message for JSON parse + request deserialization failures after successful transport decode.
pub const INVALID_JSON_MSG: &str =
    "Request body is not valid JSON or does not match the search request schema.";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiGatewayHttpV2Event {
    pub body: Option<String>,
    pub is_base64_encoded: Option<bool>,
    pub headers: Option<HashMap<String, String>>,
}

#[derive(Debug)]
pub struct InvocationContext {
    pub is_http_api: bool,
    pub headers: Option<HashMap<String, String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiGatewayHttpV2Response {
    pub status_code: u16,
    pub headers: HashMap<String, String>,
    pub body: String,
}

pub fn is_api_gateway_http_v2(payload: &Value) -> bool {
    payload
        .get("version")
        .and_then(|v| v.as_str())
        .is_some_and(|v| v == "2.0")
}

pub fn invocation_context(payload: &Value) -> InvocationContext {
    if is_api_gateway_http_v2(payload) {
        let headers = payload
            .get("headers")
            .and_then(|h| serde_json::from_value(h.clone()).ok());
        InvocationContext {
            is_http_api: true,
            headers,
        }
    } else {
        InvocationContext {
            is_http_api: false,
            headers: None,
        }
    }
}

/// Decodes API Gateway `body` + `isBase64Encoded`; for direct invoke, uses a nested string `body` + optional
/// `isBase64Encoded` when present, otherwise serializes the whole value to JSON bytes.
pub fn request_body_bytes(
    payload: &Value,
    ctx: &InvocationContext,
    max_bytes: usize,
) -> Result<Vec<u8>, ApiError> {
    if !ctx.is_http_api {
        if let Some(body_val) = payload.get("body") {
            if let Some(s) = body_val.as_str() {
                let is_b64 = payload
                    .get("isBase64Encoded")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                let bytes: Vec<u8> = if is_b64 {
                    base64::engine::general_purpose::STANDARD
                        .decode(s.trim().as_bytes())
                        .map_err(|_| {
                            ApiError::bad_request("INVALID_BASE64", "Request body is not valid Base64")
                        })?
                } else {
                    s.as_bytes().to_vec()
                };
                if bytes.len() > max_bytes {
                    return Err(ApiError::payload_too_large(format!(
                        "Payload exceeds max {max_bytes} bytes"
                    )));
                }
                return Ok(bytes);
            }
        }

        let bytes = serde_json::to_vec(payload).map_err(|e| {
            ApiError::bad_request(
                "INVALID_DIRECT_PAYLOAD",
                format!("Could not serialize payload: {e}"),
            )
        })?;
        if bytes.len() > max_bytes {
            return Err(ApiError::payload_too_large(format!(
                "Payload exceeds max {max_bytes} bytes"
            )));
        }
        return Ok(bytes);
    }

    let event: ApiGatewayHttpV2Event = serde_json::from_value(payload.clone()).map_err(|e| {
        ApiError::bad_request(
            "INVALID_APIGW_EVENT",
            format!("Malformed API Gateway event: {e}"),
        )
    })?;

    let Some(body) = event.body else {
        return Err(ApiError::bad_request(
            "EMPTY_BODY",
            "API Gateway request body is empty",
        ));
    };

    let bytes = if event.is_base64_encoded.unwrap_or(false) {
        base64::engine::general_purpose::STANDARD
            .decode(body.trim().as_bytes())
            .map_err(|_| {
                ApiError::bad_request("INVALID_BASE64", "Request body is not valid Base64")
            })?
    } else {
        body.into_bytes()
    };

    if bytes.len() > max_bytes {
        return Err(ApiError::payload_too_large(format!(
            "Body exceeds max {max_bytes} bytes"
        )));
    }

    Ok(bytes)
}

/// Decoded, size-checked request bytes (API Gateway body with optional Base64, or serialized direct-invoke payload).
/// Prefer this name at call sites that only need bytes; see also [`parse_json_request_body`].
#[inline]
pub fn extract_request_body(
    payload: &Value,
    ctx: &InvocationContext,
    max_bytes: usize,
) -> Result<Vec<u8>, ApiError> {
    request_body_bytes(payload, ctx, max_bytes)
}

/// Runs [`extract_request_body`] then deserializes `T` from the byte slice (single JSON parse, no extra string copies).
/// Returns [`ApiError::payload_too_large`] (413) when over limit; propagates other transport/decode errors from
/// [`extract_request_body`] (e.g. `EMPTY_BODY`, `INVALID_BASE64`, `INVALID_APIGW_EVENT`). JSON syntax failures use
/// [`INVALID_JSON_MSG`] with code `INVALID_JSON`.
pub fn parse_json_request_body<T: DeserializeOwned>(
    payload: &Value,
    ctx: &InvocationContext,
    max_bytes: usize,
) -> Result<T, ApiError> {
    let bytes = extract_request_body(payload, ctx, max_bytes)?;
    serde_json::from_slice(&bytes)
        .map_err(|_| ApiError::bad_request("INVALID_JSON", INVALID_JSON_MSG))
}

/// HTTP API v2 envelope with [`ApiError::status`] and the standard `{ ok: false, error: { ... } }` body.
pub fn apigw_api_error_response(e: &ApiError) -> Result<Value, serde_json::Error> {
    apigw_json_response(e.status, e.to_json_value())
}

pub fn apigw_json_response(status: u16, body: Value) -> Result<Value, serde_json::Error> {
    let mut headers = HashMap::new();
    headers.insert(
        "content-type".to_string(),
        "application/json; charset=utf-8".to_string(),
    );
    headers.insert("access-control-allow-origin".to_string(), "*".to_string());
    headers.insert(
        "access-control-allow-methods".to_string(),
        "OPTIONS,POST".to_string(),
    );
    headers.insert(
        "access-control-allow-headers".to_string(),
        "content-type,x-trace-api-key".to_string(),
    );

    let resp = ApiGatewayHttpV2Response {
        status_code: status,
        headers,
        body: serde_json::to_string(&body)?,
    };
    serde_json::to_value(resp)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn decodes_plain_body() {
        let payload = json!({
            "version": "2.0",
            "body": "{\"query_vector\":[0.0],\"limit\":1}",
            "isBase64Encoded": false,
            "headers": {}
        });
        let ctx = invocation_context(&payload);
        assert!(ctx.is_http_api);
        let bytes = request_body_bytes(&payload, &ctx, 1024).unwrap();
        assert!(bytes.starts_with(b"{"));
    }

    #[test]
    fn decodes_base64_body() {
        let inner = r#"{"query_vector":[0.0],"limit":1}"#;
        let b64 = base64::engine::general_purpose::STANDARD.encode(inner.as_bytes());
        let payload = json!({
            "version": "2.0",
            "body": b64,
            "isBase64Encoded": true,
            "headers": {}
        });
        let ctx = invocation_context(&payload);
        let bytes = extract_request_body(&payload, &ctx, 4096).unwrap();
        assert_eq!(bytes, inner.as_bytes());
    }

    #[test]
    fn oversized_body_is_413() {
        let payload = json!({
            "version": "2.0",
            "body": "e30=",
            "isBase64Encoded": true,
            "headers": {}
        });
        let ctx = invocation_context(&payload);
        let err = extract_request_body(&payload, &ctx, 1).unwrap_err();
        assert_eq!(err.status, 413);
    }

    #[test]
    fn empty_apigw_body_is_empty_body_code() {
        let payload = json!({
            "version": "2.0",
            "headers": {}
        });
        let ctx = invocation_context(&payload);
        let err = parse_json_request_body::<serde_json::Value>(&payload, &ctx, 1024).unwrap_err();
        assert_eq!(err.status, 400);
        assert_eq!(err.code, "EMPTY_BODY");
    }

    #[test]
    fn invalid_json_uses_invalid_json_code() {
        let payload = json!({
            "version": "2.0",
            "body": "{not json",
            "isBase64Encoded": false,
            "headers": {}
        });
        let ctx = invocation_context(&payload);
        let err = parse_json_request_body::<serde_json::Value>(&payload, &ctx, 1024).unwrap_err();
        assert_eq!(err.status, 400);
        assert_eq!(err.code, "INVALID_JSON");
    }
}
