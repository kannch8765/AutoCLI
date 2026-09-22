use autocli_core::SiteSession;
use autocli_discovery::yaml_parser::parse_yaml_adapter;

#[test]
fn parses_taobao_opencli_ports() {
    let cases = [
        ("search", include_str!("../../../adapters/taobao/search.yaml")),
        ("detail", include_str!("../../../adapters/taobao/detail.yaml")),
        ("reviews", include_str!("../../../adapters/taobao/reviews.yaml")),
        ("cart", include_str!("../../../adapters/taobao/cart.yaml")),
        ("add-cart", include_str!("../../../adapters/taobao/add-cart.yaml")),
    ];
    for (name, yaml) in cases {
        let command = parse_yaml_adapter(yaml).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(command.site, "taobao");
        assert_eq!(command.name, name);
        assert!(command.browser);
        assert_eq!(command.site_session, SiteSession::Ephemeral);
    }
}
