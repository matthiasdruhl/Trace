# Trace API contract

This document defines the active request and response contract for the Trace Rust Lambda and the MCP bridge that calls it.

## Search surfaces

| Surface | Shape | Notes |
| --- | --- | --- |
| HTTP API | `POST /search` | API Gateway HTTP API v2 proxy integration |
| Direct Lambda invoke | JSON event | Supports direct JSON payloads or nested `body` strings |
| MCP bridge | `search_cold_archive` | Embeds query text, then calls the HTTP API |

There is no supported `GET` search route.

## Authentication

### HTTP API

- Header name: `X-TRACE-API-KEY`
- Header lookup is ASCII case-insensitive
- Duplicate case-variant matches are rejected with `400 DUPLICATE_API_KEY_HEADER`
- If `TRACE_API_KEY_SECRET` is blank or unset, HTTP requests run in IAM-only mode and no API key is required
- If `TRACE_API_KEY_SECRET` is set, missing keys return `401 MISSING_API_KEY` and invalid keys return `401 INVALID_API_KEY`

### Direct Lambda invoke

Direct invoke does not evaluate HTTP headers for authorization.

## Request JSON

The request body is a JSON object with these fields:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `query_vector` | `number[]` | yes | Must match the configured query dimension |
| `k` | integer | no | Requested result count |
| `limit` | integer | no | Alias for `k` |
| `include_text` | boolean | no | Includes `text_content` in the projection when true |
| `columns` | `string[]` | no | Explicit projection from the allowed field list |
| `sql_filter` | string | no | Optional constrained metadata filter |

### `k` and `limit`

- If omitted, the effective limit is `10`
- `0` is rejected with `400 INVALID_LIMIT`
- The effective limit is capped at `50`

### Allowed projection columns

- `incident_id`
- `timestamp`
- `city_code`
- `doc_type`
- `text_content`

If `columns` is omitted, the default projection is:

- `incident_id`
- `timestamp`
- `city_code`
- `doc_type`

If `include_text` is true, `text_content` is added automatically.

## `sql_filter` grammar

`sql_filter` is a constrained expression language, not arbitrary SQL.

Allowed fields:

- `incident_id`
- `timestamp`
- `city_code`
- `doc_type`

Allowed operators:

- `=`, `!=`, `<`, `<=`, `>`, `>=`
- `IN (...)`
- `AND`, `OR`, `NOT`
- parentheses

Rules:

- field names are matched ASCII case-insensitively
- string literals use single quotes
- embedded single quotes are escaped as `''`
- timestamp literals must be valid RFC 3339 strings
- semicolons outside quoted strings are rejected
- unsupported functions, raw SQL statements, and unknown fields are rejected

Example:

```json
{
  "query_vector": [0.01, -0.02, 0.03],
  "limit": 5,
  "sql_filter": "city_code = 'NYC-TLC' AND doc_type IN ('Safety_Incident_Log', 'Insurance_Lapse_Report')"
}
```

## Success response

Successful responses return:

```json
{
  "ok": true,
  "results": [],
  "query_dim": 1536,
  "k": 10,
  "took_ms": 3
}
```

Fields:

| Field | Type | Notes |
| --- | --- | --- |
| `ok` | boolean | Always `true` on success |
| `results` | object[] | Ranked result rows |
| `query_dim` | integer | Effective vector dimension for the runtime |
| `k` | integer | Effective limit after validation and clamping |
| `took_ms` | integer | Search path execution time in milliseconds |
| `stub` | string | Present only in mock/test flows |

### Result row fields

Result rows can contain:

- `incident_id`
- `timestamp`
- `city_code`
- `doc_type`
- `text_content`
- `score`

`score` is the projected `_distance` from Lance and represents L2 distance. Smaller values are closer matches.

## Error response

Error bodies use this shape:

```json
{
  "ok": false,
  "error": {
    "code": "INVALID_VECTOR_DIM",
    "message": "query_vector must have length 1536, got 128"
  }
}
```

Common error codes:

| Code | HTTP | Meaning |
| --- | --- | --- |
| `MISSING_API_KEY` | 401 | API key required but missing |
| `INVALID_API_KEY` | 401 | API key invalid |
| `DUPLICATE_API_KEY_HEADER` | 400 | Conflicting case variants of the API key header |
| `EMPTY_BODY` | 400 | API Gateway request body missing |
| `INVALID_BASE64` | 400 | Base64 body decode failed |
| `INVALID_APIGW_EVENT` | 400 | Event did not match the expected API Gateway shape |
| `INVALID_DIRECT_PAYLOAD` | 400 | Direct invoke payload serialization failed |
| `INVALID_JSON` | 400 | Request body was not valid JSON or did not match the schema |
| `PAYLOAD_TOO_LARGE` | 413 | Request exceeded the configured payload limit |
| `INVALID_LIMIT` | 400 | `k` or `limit` was zero |
| `INVALID_COLUMN` | 400 | Unsupported projection field or invalid `include_text` combination |
| `INVALID_VECTOR_DIM` | 400 | Query vector length mismatch |
| `SQL_FILTER_TOO_LONG` | 400 | `sql_filter` exceeded the maximum length |
| `INVALID_SQL_FILTER` | 400 | Filter syntax or field usage was unsupported |
| `INVALID_FILTER_VALUE` | 400 | Filter literal value was invalid, usually a bad timestamp |
| `INTERNAL` | 500 | Internal server failure with masked client message |

## MCP bridge contract

The MCP bridge exposes `search_cold_archive` with these arguments:

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `query_text` | string | yes | Natural-language search input |
| `sql_filter` | string | no | Forwarded to the Lambda search API |
| `limit` | integer | no | Must be between `1` and `50` |
| `include_text` | boolean | no | Requests `text_content` in the results |

The bridge generates an embedding, converts the request to the Lambda search JSON shape, and returns the raw JSON response as text to the MCP caller.
