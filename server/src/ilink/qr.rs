//! Server-side QR rendering for the login flow (ADR 0211 §5, issue #134).
//! The browser receives only an SVG image of the scan target — never the
//! upstream QR identifier, and never the scan URL as text it could store,
//! copy, or report.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use qrcode::QrCode;
use qrcode::render::svg;

/// Upper bound on the encoded scan target (upstream URLs are short).
const MAX_QR_CONTENT_BYTES: usize = 1_024;

/// Renders `content` as a `data:image/svg+xml;base64,…` QR image, or
/// `None` when it is empty, oversized, or not encodable.
pub fn qr_svg_data_uri(content: &str) -> Option<String> {
    let content = content.trim();
    if content.is_empty() || content.len() > MAX_QR_CONTENT_BYTES {
        return None;
    }
    let code = QrCode::new(content.as_bytes()).ok()?;
    let image = code
        .render::<svg::Color<'_>>()
        .min_dimensions(240, 240)
        .quiet_zone(true)
        .dark_color(svg::Color("#000000"))
        .light_color(svg::Color("#ffffff"))
        .build();
    Some(format!(
        "data:image/svg+xml;base64,{}",
        BASE64.encode(image.as_bytes())
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_an_svg_data_uri_that_does_not_echo_the_content() {
        let target = "https://liteapp.weixin.qq.com/q/synthetic-login-target";
        let uri = qr_svg_data_uri(target).expect("rendered");
        let encoded = uri
            .strip_prefix("data:image/svg+xml;base64,")
            .expect("data uri");
        let svg = String::from_utf8(BASE64.decode(encoded).expect("base64")).expect("utf8");
        assert!(svg.starts_with("<?xml") || svg.starts_with("<svg"));
        assert!(svg.contains("<svg"));
        assert!(
            !svg.contains("synthetic-login-target"),
            "content is only drawn"
        );
        assert!(!uri.contains("synthetic-login-target"));
    }

    #[test]
    fn rejects_empty_and_oversized_content() {
        assert_eq!(qr_svg_data_uri("   "), None);
        assert_eq!(qr_svg_data_uri(&"x".repeat(2_000)), None);
    }
}
