use autocli_discovery::yaml_parser::parse_yaml_adapter;

fn pipeline_text(command: &autocli_core::CliCommand) -> String {
    serde_json::to_string(command.pipeline.as_ref().expect("browser adapter pipeline"))
        .expect("serialize pipeline")
}

fn assert_media_adapter(name: &str, yaml: &str) {
    let command = parse_yaml_adapter(yaml).expect("parse twitter adapter");
    assert_eq!(command.site, "twitter");
    assert_eq!(command.name, name);
    let pipeline = pipeline_text(&command);
    assert!(pipeline.contains("extended_entities"));
    assert!(pipeline.contains("video/mp4"));
    assert!(pipeline.contains("media_urls"));
    assert!(pipeline.contains("media_posters"));
    assert!(pipeline.contains("has_media"));
}

#[test]
fn twitter_read_adapters_port_opencli_media_projection() {
    assert_media_adapter("timeline", include_str!("../../../adapters/twitter/timeline.yaml"));
    assert_media_adapter("search", include_str!("../../../adapters/twitter/search.yaml"));
    assert_media_adapter("thread", include_str!("../../../adapters/twitter/thread.yaml"));
    assert_media_adapter("bookmarks", include_str!("../../../adapters/twitter/bookmarks.yaml"));
}

#[test]
fn twitter_search_uses_graphql_searchtimeline_like_opencli() {
    let command = parse_yaml_adapter(include_str!("../../../adapters/twitter/search.yaml"))
        .expect("parse twitter search adapter");
    let pipeline = pipeline_text(&command);
    assert!(pipeline.contains("SearchTimeline"));
    assert!(pipeline.contains("search_by_raw_query"));
    assert!(pipeline.contains("querySource"));
    assert!(!pipeline.contains("article[data-testid=\\\"tweet\\\"]"));
}
