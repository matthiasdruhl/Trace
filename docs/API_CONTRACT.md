# Trace API contract (Lambda + MCP bridge)

Authoritative JSON shapes for the **Rust Lambda** (`lambda-engine`) and the **MCP bridge** (`mcp-bridge`). Search is **Lance-backed** IVF-PQ ANN over the configured S3 dataset; responses are not placeholder stubs except when the MCP tool runs with `TRACE_MCP_MOCK=1` (see [MCP bridge tool](#mcp-bridge-tool)).

## Surface area

| Transport | Route / payload | Purpose |
| --- | --- | --- |
| **HTTP API (API Gateway HTTP API v2)** | `POST /search` on the deployed API base URL (`SearchUrl` stack output) | Primary JSON API; CORS preflight via `OPTIONS` is supported for the same path. |
| **Direct Lambda invoke** | JSON event (optional nested `body` / `isBase64Encoded` for JSON-in-string) | IAM credentials apply; API key headers are **not** evaluated. |

There is **no** `GET` search handler; do not rely on `GET` for queries.

---

## Authentication (HTTP only)

- **Header:** `X-TRACE-API-KEY` (name is matched **ASCII case-insensitively** against the header map; any of `X-TRACE-API-KEY`, `x-trace-api-key`, etc. is accepted **if** there is only one matching entry).
- **Duplicate header casings:** If two or more header keys match the API key name when compared case-insensitively (e.g. both `X-TRACE-API-KEY` and `x-trace-api-key`), the Lambda returns **400** with `error.code` **`DUPLICATE_API_KEY_HEADER`** (non-deterministic auth is rejected).
- **IAM-only mode:** If `TRACE_API_KEY_SECRET` is **unset or blank** after trim, the Lambda does **not** require `X-TRACE-API-KEY` (use IAM, resource policies, private API, or network controls). This matches SAM when **`TraceApiKeySecretRef`** is left empty (no secret resolved into the environment).
- **API-key mode:** If `TRACE_API_KEY_SECRET` is **non-empty**, HTTP invocations **must** include a matching `X-TRACE-API-KEY` (constant-time compare on the raw string; length mismatch fails). Missing → **401** `MISSING_API_KEY`; wrong/empty → **401** `INVALID_API_KEY`.
- **SAM / Secrets Manager:** Set **`TraceApiKeySecretRef`** (and optionally **`TraceApiKeySecretJsonKey`**) so CloudFormation injects the resolved secret into **`TRACE_API_KEY_SECRET`** at deploy time. The template does **not** use a parameter named `TraceApiKeySecret`.
- **Direct invoke:** IAM only; **`TRACE_API_KEY_SECRET` is ignored** for authorization (no API Gateway headers).

---

## Request JSON (`POST` body or direct-invoke JSON)

All successful parses deserialize to [`SearchRequest`](../lambda-engine/src/search.rs): a single JSON object with:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `query_vector` | `number[]` (**`f32`**) | **yes** | Length **must** equal the runtime’s expected dimension (**[`TRACE_QUERY_VECTOR_DIM`](#environment-variables-lambda)** / `query_dim` in responses). Default deployment dimension is **1536** (e.g. `text-embedding-3-small`). |
| `k` | `number` (integer **≥ 1**) | no | Neighbor count **before** upper bound clamp. **Stable public field.** |
| `limit` | `number` | no | **Serde alias for `k`** (same semantic). Prefer one of `k` or `limit` in a single object. |
| `include_text` | `boolean` | no | Default **`false`**. If `true`, `text_content` is included in the projection (and may be added to the column list automatically). |
| `columns` | `string[]` | no | Optional explicit projection. When **omitted**, the server projects the default set: `incident_id`, `timestamp`, `city_code`, `doc_type` (and adds `text_content` when `include_text` is true). When provided, must be non-empty; each name must be one of: `incident_id`, `timestamp`, `city_code`, `doc_type`, `text_content`. Requesting `text_content` here requires `include_text: true`. |
| `sql_filter` | `string` | no | Optional metadata filter expression (max **8192 Unicode scalar values**). Empty or whitespace-only means **no filter**. When non-empty, the Lambda parses a constrained filter language, compiles it to a Lance-compatible predicate, and applies it through `scan().filter(...)` before nearest-neighbor search. |

### Semantics: `k` / `limit`

- **Omitted:** effective `k` = **10** (Lambda default).
- **Explicit `0`:** **400** `INVALID_LIMIT` — `"Invalid limit: must be a positive integer greater than zero."`
- **After validation:** `k` is capped at **50** ([`MAX_K`](../lambda-engine/src/search.rs)). Request **100** → effective **50**; response `k` reflects the **effective** value.

For API Gateway, the event may use a Base64-encoded `body` when `isBase64Encoded` is true; the Lambda decodes it before JSON parsing.

### `sql_filter` grammar

The field name is historical. The value is **not** arbitrary SQL. The Lambda accepts a **small constrained filter language**, parses it to a typed AST, compiles it into a Lance/DataFusion-compatible predicate string, and applies it to the dataset scanner before nearest-neighbor search.

**Allowed fields**

- `incident_id`
- `timestamp`
- `city_code`
- `doc_type`

Field names are matched **ASCII case-insensitively**, so `city_code` and `CITY_CODE` are treated the same.

**Allowed operators**

- comparison: `=`, `!=`, `<`, `<=`, `>`, `>=`
- set membership: `IN (...)`
- boolean: `AND`, `OR`
- unary: `NOT`
- grouping with parentheses

**Literals**

- literals are single-quoted strings
- embedded single quotes are escaped as `''`
- `timestamp` literals must be valid **RFC 3339**
- `timestamp` values are compiled as typed timestamp expressions for the underlying Lance/DataFusion predicate

**Unsupported constructs**

The Lambda rejects unsupported syntax with **400** `INVALID_SQL_FILTER`, including:

- semicolons outside quoted strings
- multi-statement input
- functions such as `LOWER(...)`
- operators such as `LIKE`
- unknown fields such as `text_content`
- arbitrary SQL such as `SELECT ...`

**400 behavior**

| Situation | HTTP | `error.code` |
| --- | --- | --- |
| `sql_filter` longer than 8192 Unicode scalars (character count) | 400 | `SQL_FILTER_TOO_LONG` |
| Unsupported syntax, unknown fields, unsupported operators, empty `IN ()`, function-like input, semicolon-delimited input, trailing garbage | 400 | `INVALID_SQL_FILTER` |
| Invalid `timestamp` literal (not RFC 3339) | 400 | `INVALID_FILTER_VALUE` |

**Example (filtered search)**

```json
{
  "query_vector": [0.01, -0.02, 0.03],
  "sql_filter": "city_code = 'NYC-TLC' AND doc_type = 'Insurance_Lapse_Report'",
  "limit": 5,
  "include_text": false
}
```

---

## Success response JSON

HTTP **200** (API Gateway) or raw JSON for direct invoke:

| Field | Type | Notes |
| --- | --- | --- |
| `ok` | `boolean` | Always **`true`** for success bodies (mirrors error envelope `ok: false`). |
| `results` | `object[]` | Ranked rows (see [Row objects](#row-objects-results)). |
| `query_dim` | `number` | Expected / validated embedding dimension for this runtime (from **`TRACE_QUERY_VECTOR_DIM`**; default **1536**). |
| `k` | `number` | Effective neighbor count **after** validation and clamping (1–50). |
| `took_ms` | `number` | Wall time spent in the search path (milliseconds). |
| `stub` | `string` | **Optional.** Omitted by the Lance handler. May appear in MCP mock mode (`TRACE_MCP_MOCK`) for testing. |

**Example (empty result)**

```json
{
  "ok": true,
  "results": [],
  "query_dim": 1536,
  "k": 10,
  "took_ms": 3
}
```

### Row objects (`results[]`)

Rows are JSON objects built from Arrow projection. Field presence depends on **`columns`** / **`include_text`** (see above).

| Field | When present | Type | Notes |
| --- | --- | --- | --- |
| `incident_id` | Default or when listed in `columns` | `string` or `null` | Nullable if the underlying column is null. |
| `timestamp` | Default or when listed in `columns` | `string` or `null` | When non-null, **RFC 3339** in **UTC** with `Z` offset (e.g. `2024-01-15T12:30:00.000000Z`). |
| `city_code` | Default or when listed in `columns` | `string` or `null` | |
| `doc_type` | Default or when listed in `columns` | `string` or `null` | |
| `text_content` | Only when included in the projection (`include_text` / `columns`) | `string` or `null` | Omitted from the default projection unless `include_text` is true. |
| `score` | Always (from `_distance`) | `number` or `null` | **L2 distance** between the query vector and the row’s `vector` (ANN metric); **smaller = closer**. Not a 0–1 similarity score. |

---

## Error response JSON

Same logical envelope for HTTP and direct invoke (API Gateway wraps it in `statusCode` / `body` for HTTP API v2 proxy integrations).

```json
{
  "ok": false,
  "error": {
    "code": "INVALID_VECTOR_DIM",
    "message": "query_vector must have length 1536, got 128"
  }
}
```

- **4xx:** `error.message` is the specific client-safe explanation.
- **5xx:** `error.message` is always the generic **`Internal Server Error`** (details are logged server-side only).

### Common `error.code` values

| Code | Typical HTTP | Meaning |
| --- | --- | --- |
| `MISSING_API_KEY` | 401 | API key required but header absent. |
| `INVALID_API_KEY` | 401 | Header present but secret mismatch or invalid (non-empty secret configured). |
| `DUPLICATE_API_KEY_HEADER` | 400 | Multiple header keys match `X-TRACE-API-KEY` case-insensitively. |
| `EMPTY_BODY` | 400 | API Gateway request has no body where one is required. |
| `INVALID_BASE64` | 400 | Base64 body could not be decoded. |
| `INVALID_APIGW_EVENT` | 400 | API Gateway event JSON could not be parsed as the HTTP API v2 shape. |
| `INVALID_DIRECT_PAYLOAD` | 400 | Direct-invoke payload could not be serialized to bytes as expected. |
| `INVALID_JSON` | 400 | Bytes are not valid JSON, or JSON does not match the request schema. |
| `PAYLOAD_TOO_LARGE` | 413 | Decoded body exceeds `TRACE_MAX_PAYLOAD_BYTES`. |
| `INVALID_LIMIT` | 400 | `k` / `limit` was **0**. |
| `INVALID_COLUMN` | 400 | Invalid `columns` / `include_text` combination or unknown column. |
| `INVALID_VECTOR_DIM` | 400 | `query_vector` length ≠ runtime `query_dim`. |
| `SQL_FILTER_TOO_LONG` | 400 | `sql_filter` exceeds max length. |
| `INVALID_SQL_FILTER` | 400 | Filter string is not valid for the supported constrained grammar (unknown field, unsupported operator/syntax, empty `IN ()`, etc.). |
| `INVALID_FILTER_VALUE` | 400 | Invalid value for a typed field, currently malformed `timestamp` literals. |
| `INTERNAL` | 500 | Unexpected failure (message masked). |

---

## Environment variables (Lambda)

| Variable | Description |
| --- | --- |
| `TRACE_S3_BUCKET` | Bucket containing the Lance dataset tree (if not using `TRACE_LANCE_S3_URI` alone). |
| `TRACE_LANCE_PREFIX` | Prefix for dataset root (e.g. `uber_audit.lance`). |
| `TRACE_LANCE_S3_URI` | Optional full `s3://bucket/prefix` URI (overrides bucket/prefix pair when set). |
| `TRACE_QUERY_VECTOR_DIM` | Optional. Expected length of `query_vector` and Lance `vector` column width. Default **1536**. Must match the deployed embedding model / index. |
| `TRACE_API_KEY_SECRET` | Shared secret for `X-TRACE-API-KEY`; empty/omitted disables header enforcement (IAM-only). In SAM, populated from Secrets Manager via **`TraceApiKeySecretRef`**. |
| `TRACE_MAX_PAYLOAD_BYTES` | Max decoded JSON body size (default **262144**). |

---

## CORS (HTTP)

Lambda JSON responses include:

- `Access-Control-Allow-Origin: *`
- `Access-Control-Allow-Methods: OPTIONS,POST`
- `Access-Control-Allow-Headers: content-type,x-trace-api-key`

This matches the **POST**-only search route and **OPTIONS** preflight. SAM `HttpApi` CorsConfiguration uses **`POST`** and **`OPTIONS`** only.

---

## MCP bridge tool

- **Name:** `search_cold_archive`
- **To Lambda:** Sends a JSON body compatible with [`SearchRequest`](#request-json-post-body-or-direct-invoke-json): `query_vector` (from OpenAI embeddings or **`USE_MOCK_EMBEDDINGS`** zero vector), `sql_filter`, **`limit`** (integer **1–50**; default **10** when omitted), `include_text`. The bridge uses the field name **`limit`** (equivalent to Lambda’s `limit` alias for `k`).
- **Auth:** Sends `x-trace-api-key` when **`TRACE_API_KEY`** or **`TRACE_MCP_API_KEY`** is set (must match Lambda `TRACE_API_KEY_SECRET` when that is configured).
- **Mock:** If **`TRACE_MCP_MOCK`** is `1` / `true` / `yes` / `on`, returns a synthetic success envelope **without** calling HTTP (includes a `stub` string for visibility).
- **Embeddings:** **`OPENAI_API_KEY`** is required unless **`USE_MOCK_EMBEDDINGS=true`**. **`TRACE_QUERY_VECTOR_DIM`**, when set on the bridge, must match the resolved embedding dimension for the chosen **`OPENAI_EMBEDDING_MODEL`** (same rules as Lambda’s dimension).

**Bridge environment**

| Variable | Purpose |
| --- | --- |
| `TRACE_SEARCH_URL` | Full URL to `POST /search` (e.g. `SearchUrl`). Required unless `TRACE_MCP_MOCK=1`. |
| `TRACE_API_KEY` / `TRACE_MCP_API_KEY` | Optional; sent as `x-trace-api-key`. |
| `TRACE_MCP_MOCK` | If truthy, local mock response (no Lambda). |
| `OPENAI_API_KEY` | Required for real embeddings unless `USE_MOCK_EMBEDDINGS`. |
| `OPENAI_EMBEDDING_MODEL` | Optional (default `text-embedding-3-small`). |
| `TRACE_QUERY_VECTOR_DIM` | Optional cross-check against embedding size / Lambda. |
| `USE_MOCK_EMBEDDINGS` | If truthy, fills a zero vector of the expected dimension (dev/test only). |
| `OVERRIDE_VECTOR_DIM` | Optional bridge-only override for embedding dimension resolution. |

---

## Deploy (AWS SAM)

From the repository root (Rust `cargo-lambda` required for `Metadata: BuildMethod: cargo-lambda`):

```bash
sam build
sam deploy --guided
```

Stack outputs include **`SearchUrl`** (`POST /search`). Set **`TraceApiKeySecretRef`** (and optional **`TraceApiKeySecretJsonKey`**) to enable **`X-TRACE-API-KEY`** enforcement on the HTTP route.
