use autocli_core::{SiteSession, Strategy};
use autocli_discovery::yaml_parser::parse_yaml_adapter;

fn pipeline_text(command: &autocli_core::CliCommand) -> String {
    serde_json::to_string(command.pipeline.as_ref().expect("browser adapter pipeline"))
        .expect("serialize pipeline")
}

#[test]
fn rednote_search_stays_on_rednote_host_with_ephemeral_session() {
    let command = parse_yaml_adapter(include_str!("../../../adapters/rednote/search.yaml"))
        .expect("parse rednote search adapter");

    assert_eq!(command.site, "rednote");
    assert_eq!(command.name, "search");
    assert_eq!(command.domain.as_deref(), Some("www.rednote.com"));
    assert_eq!(command.strategy, Strategy::Cookie);
    assert_eq!(command.site_session, SiteSession::Ephemeral);

    let pipeline = pipeline_text(&command);
    assert!(pipeline.contains("https://www.rednote.com/search_result"));
    assert!(pipeline.contains("login-modal"));
    assert!(!pipeline.contains("www.xiaohongshu.com"));
}

#[test]
fn rednote_feed_builds_signed_rednote_urls_with_ephemeral_session() {
    let command = parse_yaml_adapter(include_str!("../../../adapters/rednote/feed.yaml"))
        .expect("parse rednote feed adapter");

    assert_eq!(command.site, "rednote");
    assert_eq!(command.name, "feed");
    assert_eq!(command.domain.as_deref(), Some("www.rednote.com"));
    assert_eq!(command.strategy, Strategy::Cookie);
    assert_eq!(command.site_session, SiteSession::Ephemeral);

    let pipeline = pipeline_text(&command);
    assert!(pipeline.contains("https://www.rednote.com/explore"));
    assert!(pipeline.contains("xsec_token"));
    assert!(pipeline.contains("entry.xsecToken"));
    assert!(!pipeline.contains("www.xiaohongshu.com"));
}

fn assert_rednote_detail_adapter(name: &str, yaml: &str) {
    let command = parse_yaml_adapter(yaml).expect("parse rednote detail adapter");
    assert_eq!(command.site, "rednote");
    assert_eq!(command.name, name);
    assert_eq!(command.domain.as_deref(), Some("www.rednote.com"));
    assert_eq!(command.strategy, Strategy::Cookie);
    assert_eq!(command.site_session, SiteSession::Ephemeral);
    let pipeline = pipeline_text(&command);
    assert!(pipeline.contains("args.note_url"));
    assert!(pipeline.contains("SECURITY_BLOCK"));
    assert!(!pipeline.contains("www.xiaohongshu.com"));
}

#[test]
fn rednote_note_stays_on_rednote_host_with_ephemeral_session() {
    assert_rednote_detail_adapter(
        "note",
        include_str!("../../../adapters/rednote/note.yaml"),
    );
}

#[test]
fn rednote_comments_stays_on_rednote_host_with_ephemeral_session() {
    let yaml = include_str!("../../../adapters/rednote/comments.yaml");
    assert_rednote_detail_adapter("comments", yaml);
    let command = parse_yaml_adapter(yaml).expect("parse rednote comments adapter");
    let pipeline = pipeline_text(&command);
    assert!(pipeline.contains("stall >= 6"));
    assert!(pipeline.contains("i < 60"));
    assert!(pipeline.contains("Math.random() * 1200"));
    assert!(pipeline.contains("reply_to"));
    assert!(pipeline.contains("MALFORMED_ROW"));
}
