use autocli_core::CliError;
use serde_json::Value;
use std::time::Duration;
use tracing::{debug, warn};

use crate::types::{DaemonCommand, DaemonResult};

/// HTTP client that communicates with the Daemon server.
pub struct DaemonClient {
    base_url: String,
    client: reqwest::Client,
}

/// Retry delays for transport failures. OpenCLI treats semantic browser
/// retries separately so a safe attach/tab retry gets one fresh command id.
const RETRY_DELAYS_MS: [u64; 3] = [200, 500, 1000];
const TRANSPORT_MAX_ATTEMPTS: usize = 4;
const SEMANTIC_RETRY_DELAY_MS: u64 = 1500;

fn is_semantic_retry_code(code: Option<&str>) -> bool {
    matches!(code, Some("attach_failed" | "tab_gone"))
}

fn browser_command_error(result: DaemonResult) -> CliError {
    CliError::browser_command(
        result.error.unwrap_or_else(|| "Unknown daemon error".into()),
        result.error_code,
        result.error_hint,
    )
}

impl DaemonClient {
    /// Create a new client pointing at the given port on localhost.
    pub fn new(port: u16) -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .expect("failed to build reqwest client");
        Self {
            base_url: format!("http://127.0.0.1:{port}"),
            client,
        }
    }

    /// Send a command to the daemon and return the result data.
    ///
    /// Current OpenCLI has two distinct retry classes:
    /// - transport retries keep the same command id;
    /// - one semantic retry for attach_failed/tab_gone gets a NEW id because
    ///   those failures happened before page code ran.
    pub async fn send_command(&self, mut cmd: DaemonCommand) -> Result<Value, CliError> {
        let url = format!("{}/command", self.base_url);
        let mut last_err: Option<String> = None;
        let mut transport_attempt = 1usize;
        let mut semantic_retry_used = false;

        loop {
            debug!(
                transport_attempt,
                semantic_retry_used,
                action = %cmd.action,
                id = %cmd.id,
                "sending daemon command"
            );

            let response = self
                .client
                .post(&url)
                .header("X-AutoCLI", "1")
                .json(&cmd)
                .send()
                .await;

            match response {
                Ok(resp) => {
                    let status = resp.status();
                    let body = resp.text().await.unwrap_or_default();

                    // Extension results are structured even when the daemon maps
                    // failures to HTTP 422. Parse the envelope first so the
                    // machine-readable errorCode survives into Rust.
                    if let Ok(result) = serde_json::from_str::<DaemonResult>(&body) {
                        if result.ok {
                            return Ok(result.data.unwrap_or(Value::Null));
                        }

                        if is_semantic_retry_code(result.error_code.as_deref())
                            && !semantic_retry_used
                        {
                            semantic_retry_used = true;
                            cmd.id = uuid::Uuid::new_v4().to_string();
                            warn!(
                                error_code = result.error_code.as_deref().unwrap_or("unknown"),
                                delay_ms = SEMANTIC_RETRY_DELAY_MS,
                                "browser command failed before page execution; retrying with a fresh command id"
                            );
                            tokio::time::sleep(Duration::from_millis(SEMANTIC_RETRY_DELAY_MS)).await;
                            continue;
                        }

                        return Err(browser_command_error(result));
                    }

                    if status.is_client_error() {
                        return Err(CliError::command_execution(format!(
                            "Command error (HTTP {status}): {body}"
                        )));
                    }

                    // 5xx / malformed success responses retain AutoCLI's
                    // transport retry behavior. This is separate from the
                    // semantic attach/tab retry above.
                    last_err = Some(if status.is_success() {
                        format!("Failed to parse daemon response: {body}")
                    } else {
                        format!("HTTP {status}: {body}")
                    });
                }
                Err(e) => {
                    last_err = Some(format!("Request error: {e}"));
                }
            }

            if transport_attempt >= TRANSPORT_MAX_ATTEMPTS {
                return Err(CliError::browser_connect(format!(
                    "Failed to send command after {TRANSPORT_MAX_ATTEMPTS} transport attempts: {}",
                    last_err.unwrap_or_else(|| "unknown error".into())
                )));
            }

            let delay_ms = RETRY_DELAYS_MS[transport_attempt - 1];
            warn!(
                transport_attempt,
                error = last_err.as_deref().unwrap_or("unknown"),
                delay_ms,
                "retrying daemon command transport"
            );
            transport_attempt += 1;
            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
        }
    }

    /// Check if something is listening on the daemon port.
    /// Tries our health endpoint first, then falls back to checking with X-AutoCLI header
    /// (needed for the original opencli daemon which requires it on all requests).
    pub async fn is_running(&self) -> bool {
        let url = format!("{}/health", self.base_url);
        // Try without header first (our daemon doesn't require it)
        if let Ok(resp) = self.client.get(&url).send().await {
            if resp.status().is_success() {
                return true;
            }
            // Got a response (even 403) means something is listening
            if resp.status().as_u16() == 403 {
                return true;
            }
        }
        false
    }

    /// Check if the Chrome extension is connected to the daemon.
    /// Compatible with both autocli (`extension` field) and original opencli (`extensionConnected` field).
    pub async fn is_extension_connected(&self) -> bool {
        let url = format!("{}/status", self.base_url);
        // Original OpenCLI requires X-AutoCLI header on all requests
        match self.client.get(&url).header("X-AutoCLI", "1").send().await {
            Ok(resp) if resp.status().is_success() => {
                if let Ok(json) = resp.json::<Value>().await {
                    // Our format: {"extension": bool}
                    // Original format: {"extensionConnected": bool}
                    json.get("extension")
                        .or_else(|| json.get("extensionConnected"))
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false)
                } else {
                    false
                }
            }
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        extract::State,
        http::StatusCode,
        routing::post,
        Json, Router,
    };
    use serde_json::json;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    };

    #[derive(Clone)]
    struct RetryServerState {
        calls: Arc<AtomicUsize>,
        ids: Arc<Mutex<Vec<String>>>,
        code: &'static str,
        recover: bool,
    }

    async fn retry_server_handler(
        State(state): State<RetryServerState>,
        Json(cmd): Json<DaemonCommand>,
    ) -> (StatusCode, Json<Value>) {
        let call = state.calls.fetch_add(1, Ordering::SeqCst);
        state.ids.lock().unwrap().push(cmd.id.clone());
        if state.recover && call > 0 {
            return (
                StatusCode::OK,
                Json(json!({ "id": cmd.id, "ok": true, "data": "recovered" })),
            );
        }
        (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(json!({
                "id": cmd.id,
                "ok": false,
                "error": "Debugger is not attached to the tab",
                "errorCode": state.code
            })),
        )
    }

    async fn spawn_retry_server(state: RetryServerState) -> u16 {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind retry test server");
        let port = listener.local_addr().unwrap().port();
        let app = Router::new()
            .route("/command", post(retry_server_handler))
            .with_state(state);
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        port
    }

    #[test]
    fn test_daemon_client_construction() {
        let client = DaemonClient::new(19925);
        assert_eq!(client.base_url, "http://127.0.0.1:19925");
    }

    #[tokio::test]
    async fn test_is_running_when_no_server() {
        // Pick a port that's almost certainly not in use
        let client = DaemonClient::new(19999);
        assert!(!client.is_running().await);
    }

    #[tokio::test]
    async fn test_is_extension_connected_when_no_server() {
        let client = DaemonClient::new(19999);
        assert!(!client.is_extension_connected().await);
    }
    #[tokio::test]
    async fn semantic_attach_retry_uses_one_fresh_command_id() {
        let calls = Arc::new(AtomicUsize::new(0));
        let ids = Arc::new(Mutex::new(Vec::new()));
        let port = spawn_retry_server(RetryServerState {
            calls: calls.clone(),
            ids: ids.clone(),
            code: "attach_failed",
            recover: true,
        })
        .await;
        let client = DaemonClient::new(port);
        let value = client
            .send_command(DaemonCommand::new("exec").with_code("1"))
            .await
            .expect("semantic retry should recover");

        assert_eq!(value, json!("recovered"));
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        let ids = ids.lock().unwrap();
        assert_eq!(ids.len(), 2);
        assert_ne!(ids[0], ids[1], "semantic retry must mint a fresh id");
    }

    #[tokio::test]
    async fn mid_command_timeout_is_not_semantically_retried() {
        let calls = Arc::new(AtomicUsize::new(0));
        let ids = Arc::new(Mutex::new(Vec::new()));
        let port = spawn_retry_server(RetryServerState {
            calls: calls.clone(),
            ids,
            code: "cdp_timeout",
            recover: false,
        })
        .await;
        let client = DaemonClient::new(port);
        let err = client
            .send_command(DaemonCommand::new("exec").with_code("1"))
            .await
            .unwrap_err();

        assert_eq!(err.browser_error_code(), Some("cdp_timeout"));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

}
