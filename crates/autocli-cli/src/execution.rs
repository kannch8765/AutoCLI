use autocli_core::{CliCommand, CliError, IPage, SiteSession};
use autocli_pipeline::{execute_pipeline, steps::register_all_steps, StepRegistry};
use autocli_browser::BrowserBridge;
use serde_json::Value;
use std::sync::Arc;
use std::collections::HashMap;

/// Get daemon port from env or default
fn daemon_port() -> u16 {
    std::env::var("AUTOCLI_DAEMON_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(19925)
}

/// Get command timeout from env or command config or default (60s)
fn command_timeout(cmd: &CliCommand) -> u64 {
    std::env::var("AUTOCLI_BROWSER_COMMAND_TIMEOUT")
        .ok()
        .and_then(|s| s.parse().ok())
        .or(cmd.timeout_seconds)
        .unwrap_or(60)
}

fn validate_rednote_note_url(raw: &str) -> Result<(), CliError> {
    const HINT: &str = "Pass a full signed REDnote URL from rednote search/feed output (including xsec_token).";
    let url = reqwest::Url::parse(raw).map_err(|_| CliError::argument(format!(
        "rednote note URL is invalid. {HINT}"
    )))?;

    if url.scheme() != "https" {
        return Err(CliError::argument(format!(
            "rednote note URL must use https. {HINT}"
        )));
    }

    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    if host != "rednote.com" && !host.ends_with(".rednote.com") {
        return Err(CliError::argument(format!(
            "rednote note URL must be on rednote.com. {HINT}"
        )));
    }

    let segments: Vec<_> = url
        .path_segments()
        .map(|parts| parts.filter(|part| !part.is_empty()).collect())
        .unwrap_or_default();
    let is_hex = |value: &str| !value.is_empty() && value.chars().all(|ch| ch.is_ascii_hexdigit());
    let valid_path = match segments.as_slice() {
        [kind, id] if matches!(*kind, "explore" | "note" | "search_result") => is_hex(id),
        ["discovery", "item", id] => is_hex(id),
        ["user", "profile", profile_id, note_id] => !profile_id.is_empty() && is_hex(note_id),
        _ => false,
    };
    if !valid_path {
        return Err(CliError::argument(format!(
            "rednote note URL has an unsupported note path. {HINT}"
        )));
    }

    let token_ok = url.query_pairs().any(|(key, value)| key == "xsec_token" && !value.is_empty());
    if !token_ok {
        return Err(CliError::argument(format!(
            "rednote note URL is missing xsec_token. {HINT}"
        )));
    }

    Ok(())
}

fn validate_command_args(cmd: &CliCommand, kwargs: &HashMap<String, Value>) -> Result<(), CliError> {
    if cmd.site == "rednote" && matches!(cmd.name.as_str(), "note" | "comments") {
        let raw = kwargs
            .get("note_url")
            .and_then(Value::as_str)
            .ok_or_else(|| CliError::argument("rednote note_url must be a string"))?;
        validate_rednote_note_url(raw)?;
    }
    Ok(())
}

pub async fn execute_command(
    cmd: &CliCommand,
    kwargs: HashMap<String, Value>,
) -> Result<Value, CliError> {
    tracing::info!(site = %cmd.site, name = %cmd.name, "Executing command");

    let timeout_secs = command_timeout(cmd);

    let result = tokio::time::timeout(
        std::time::Duration::from_secs(timeout_secs),
        execute_command_inner(cmd, kwargs),
    )
    .await;

    match result {
        Ok(inner) => inner,
        Err(_) => Err(CliError::timeout(format!(
            "Command '{}' timed out after {}s",
            cmd.full_name(),
            timeout_secs
        ))),
    }
}

async fn execute_command_inner(
    cmd: &CliCommand,
    kwargs: HashMap<String, Value>,
) -> Result<Value, CliError> {
    // Validate adapter-specific arguments before any browser connection or navigation.
    validate_command_args(cmd, &kwargs)?;

    // Build step registry
    let mut registry = StepRegistry::new();
    register_all_steps(&mut registry);

    if cmd.needs_browser() {
        // Browser session
        let mut bridge = BrowserBridge::new(daemon_port());
        let persistent_site_session = cmd.site_session == SiteSession::Persistent;
        let page = if persistent_site_session {
            bridge.connect_with_workspace(&format!("site:{}", cmd.site)).await?
        } else {
            bridge.connect().await?
        };

        // Pre-navigate to domain if set, but ONLY if the pipeline doesn't
        // start with its own navigate step (to avoid double navigation).
        let pipeline_starts_with_navigate = cmd.pipeline.as_ref()
            .and_then(|steps| steps.first())
            .and_then(|step| step.as_object())
            .map_or(false, |obj| obj.contains_key("navigate"));

        if !pipeline_starts_with_navigate {
            if let Some(domain) = &cmd.domain {
                let url = format!("https://{}", domain);
                tracing::debug!(url = %url, "Pre-navigating to domain");
                page.goto(&url, None).await?;
            }
        }

        // Execute
        let result = if let Some(ref steps) = cmd.pipeline {
            execute_pipeline(Some(page.clone()), steps, &kwargs, &registry).await
        } else if cmd.func.is_some() {
            run_command(cmd, Some(page.clone()), &kwargs, &registry).await
        } else {
            Err(CliError::command_execution(format!(
                "Command '{}' has no pipeline or func",
                cmd.full_name()
            )))
        };

        // One-shot adapters release their automation window at command end.
        // Persistent site sessions intentionally retain the window/tab so sites
        // that keep auth in tab/session storage survive across CLI invocations.
        if !persistent_site_session {
            let _ = page.close().await;
        }

        result
    } else {
        run_command(cmd, None, &kwargs, &registry).await
    }
}


async fn run_command(
    cmd: &CliCommand,
    page: Option<Arc<dyn IPage>>,
    kwargs: &HashMap<String, Value>,
    registry: &StepRegistry,
) -> Result<Value, CliError> {
    if let Some(pipeline) = &cmd.pipeline {
        execute_pipeline(page, pipeline, kwargs, registry).await
    } else if let Some(func) = &cmd.func {
        func(page, kwargs.clone()).await
    } else {
        Err(CliError::command_execution(format!(
            "Command '{}' has no pipeline or func",
            cmd.full_name()
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::validate_rednote_note_url;

    #[test]
    fn accepts_rednote_explore_url_with_token() {
        assert!(validate_rednote_note_url(
            "https://www.rednote.com/explore/abc123?xsec_token=abc"
        )
        .is_ok());
    }

    #[test]
    fn accepts_rednote_user_profile_note_url_with_token() {
        assert!(validate_rednote_note_url(
            "https://www.rednote.com/user/profile/user123/0aBc9?xsec_token=abc"
        )
        .is_ok());
    }

    #[test]
    fn accepts_rednote_subdomain_note_url_with_token() {
        assert!(validate_rednote_note_url(
            "https://m.rednote.com/note/abcdef?xsec_token=abc"
        )
        .is_ok());
    }

    #[test]
    fn accepts_search_result_and_discovery_item_paths() {
        assert!(validate_rednote_note_url(
            "https://www.rednote.com/search_result/abc123?xsec_token=abc"
        )
        .is_ok());
        assert!(validate_rednote_note_url(
            "https://www.rednote.com/discovery/item/abc123?xsec_token=abc"
        )
        .is_ok());
    }

    #[test]
    fn rejects_bare_note_id() {
        assert!(validate_rednote_note_url("abc123").is_err());
    }

    #[test]
    fn rejects_missing_or_empty_xsec_token() {
        assert!(validate_rednote_note_url(
            "https://www.rednote.com/explore/abc123"
        )
        .is_err());
        assert!(validate_rednote_note_url(
            "https://www.rednote.com/explore/abc123?xsec_token="
        )
        .is_err());
    }

    #[test]
    fn rejects_xiaohongshu_host_even_with_valid_path_and_token() {
        assert!(validate_rednote_note_url(
            "https://www.xiaohongshu.com/explore/abc123?xsec_token=abc"
        )
        .is_err());
    }

    #[test]
    fn rejects_non_https_scheme() {
        assert!(validate_rednote_note_url(
            "http://www.rednote.com/explore/abc123?xsec_token=abc"
        )
        .is_err());
    }
}
