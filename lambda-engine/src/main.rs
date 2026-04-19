//! Lambda bootstrap: load config, run Lance search from `search::run`.

use lambda_runtime::{run as run_lambda_runtime, service_fn, Error, LambdaEvent};
use serde_json::Value;
use tracing_subscriber::EnvFilter;

use lambda_engine::auth::enforce_http_api_key_if_configured;
use lambda_engine::config::{self, EnvConfig, set_runtime_config};
use lambda_engine::error::{sanitize_for_log, ApiError};
use lambda_engine::http::{
    apigw_api_error_response, apigw_json_response, invocation_context, parse_json_request_body,
    InvocationContext,
};
use lambda_engine::search::{run as run_search_kernel, RuntimeDeps, SearchRequest};

fn respond_success(
    ctx: &InvocationContext,
    body: Value,
) -> Result<Value, Error> {
    if ctx.is_http_api {
        apigw_json_response(200, body).map_err(|e| Error::from(e.to_string()))
    } else {
        Ok(body)
    }
}

/// Application-level errors: always **`Ok(Value)`** so API Gateway receives `statusCode` on HTTP API
/// invocations. Direct invoke clients get `{ "ok": false, "error": { ... } }` without a failed Lambda result.
/// Use **`Err`** only when the HTTP API v2 envelope cannot be serialized (rare).
fn respond_api_error(ctx: &InvocationContext, e: ApiError) -> Result<Value, Error> {
    if ctx.is_http_api {
        apigw_api_error_response(&e).map_err(|se| Error::from(se.to_string()))
    } else {
        Ok(e.to_json_value())
    }
}

async fn handler(event: LambdaEvent<Value>) -> Result<Value, Error> {
    let payload = event.payload;
    let ctx = invocation_context(&payload);

    let config = config::runtime_config();

    if ctx.is_http_api {
        if let Err(e) = enforce_http_api_key_if_configured(
            config.api_key_secret.as_deref(),
            ctx.headers.as_ref(),
        ) {
            return respond_api_error(&ctx, e);
        }
    }

    let req = match parse_json_request_body::<SearchRequest>(
        &payload,
        &ctx,
        config.max_payload_bytes,
    ) {
        Ok(r) => r,
        Err(e) => return respond_api_error(&ctx, e),
    };

    let s3 = config::s3_client().await;
    let deps = RuntimeDeps {
        config: &config,
        s3: &s3,
    };

    match run_search_kernel(&req, &deps).await {
        Ok(resp) => {
            let body = match serde_json::to_value(&resp) {
                Ok(v) => v,
                Err(e) => {
                    return respond_api_error(
                        &ctx,
                        ApiError::internal_categorized("response_serialization", e.to_string()),
                    );
                }
            };
            respond_success(&ctx, body)
        }
        Err(e) => respond_api_error(&ctx, e),
    }
}

/// CloudWatch-friendly JSON logs. `RUST_LOG` when set (e.g. `trace`, `lambda_engine=debug`);
/// otherwise defaults to **`info`**. Ignores duplicate init (`try_init`).
fn init_tracing() {
    let filter = match std::env::var("RUST_LOG") {
        Ok(s) => EnvFilter::try_new(&s).unwrap_or_else(|_| EnvFilter::new("info")),
        Err(_) => EnvFilter::new("info"),
    };
    let _ = tracing_subscriber::fmt()
        .json()
        .with_env_filter(filter)
        .try_init();
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    init_tracing();
    match EnvConfig::from_env() {
        Err(e) => {
            tracing::error!(
                category = "invalid_config",
                detail_sanitized = %sanitize_for_log(&e),
                "invalid environment configuration"
            );
            std::process::exit(1);
        }
        Ok(cfg) => set_runtime_config(cfg),
    }
    run_lambda_runtime(service_fn(handler)).await
}
