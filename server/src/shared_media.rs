//! Agent-shared media eligibility (issue #132, ADR 0211 §10). The only
//! eligible source is a structured ACP `resource_link` content block with a
//! `file://` URI in an Agent message — model text is never interpreted as a
//! path. Classification is an explicit extension allowlist confirmed by
//! content sniffing; video, audio, executables, and anything unknown are
//! not deliverable in the first release.

use std::path::PathBuf;

/// Delivery bound for one shared file (ADR 0211 §10, CDN limit).
pub const MAX_SHARED_MEDIA_BYTES: u64 = 10 * 1024 * 1024;
/// Longest file name delivered as a WeChat attachment name.
pub const MAX_SHARED_FILE_NAME_CHARS: usize = 128;
/// Longest caption carried with a shared file.
pub const MAX_SHARED_CAPTION_CHARS: usize = 500;

/// How a shared file is delivered.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SharedMediaKind {
    /// Rendered inline as an image message.
    Image,
    /// Sent as a file attachment.
    File,
}

impl SharedMediaKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Image => "image",
            Self::File => "file",
        }
    }
}

/// Classifies a file extension (without the dot, any case) against the
/// first-release allowlist. Returns the delivery kind and canonical MIME.
pub fn classify_extension(extension: &str) -> Option<(SharedMediaKind, &'static str)> {
    let extension = extension.to_ascii_lowercase();
    let classified = match extension.as_str() {
        "png" => (SharedMediaKind::Image, "image/png"),
        "jpg" | "jpeg" => (SharedMediaKind::Image, "image/jpeg"),
        "gif" => (SharedMediaKind::Image, "image/gif"),
        "webp" => (SharedMediaKind::Image, "image/webp"),
        "bmp" => (SharedMediaKind::Image, "image/bmp"),
        "pdf" => (SharedMediaKind::File, "application/pdf"),
        "txt" | "log" => (SharedMediaKind::File, "text/plain"),
        "md" => (SharedMediaKind::File, "text/markdown"),
        "csv" => (SharedMediaKind::File, "text/csv"),
        "json" => (SharedMediaKind::File, "application/json"),
        "zip" => (SharedMediaKind::File, "application/zip"),
        "docx" => (
            SharedMediaKind::File,
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ),
        "xlsx" => (
            SharedMediaKind::File,
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ),
        "pptx" => (
            SharedMediaKind::File,
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        ),
        _ => return None,
    };
    Some(classified)
}

/// Confirms the content matches its claimed MIME so a renamed executable
/// or mislabelled payload is never delivered.
pub fn content_matches(mime: &str, bytes: &[u8]) -> bool {
    if is_executable(bytes) {
        return false;
    }
    match mime {
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => bytes.starts_with(&[0xFF, 0xD8, 0xFF]),
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "image/webp" => bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
        "image/bmp" => bytes.starts_with(b"BM"),
        "application/pdf" => bytes.starts_with(b"%PDF-"),
        "application/zip"
        | "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        | "application/vnd.openxmlformats-officedocument.presentationml.presentation" => {
            bytes.starts_with(b"PK\x03\x04") || bytes.starts_with(b"PK\x05\x06")
        }
        "text/plain" | "text/markdown" | "text/csv" | "application/json" => {
            std::str::from_utf8(bytes).is_ok()
        }
        _ => false,
    }
}

fn is_executable(bytes: &[u8]) -> bool {
    bytes.starts_with(b"\x7FELF")
        || bytes.starts_with(b"MZ")
        || bytes.starts_with(b"#!")
        || bytes.starts_with(&[0xCF, 0xFA, 0xED, 0xFE])
        || bytes.starts_with(&[0xFE, 0xED, 0xFA, 0xCF])
}

/// Parses a `file://` URI into an absolute local path. Only the empty or
/// `localhost` authority is accepted; percent escapes are decoded; NUL
/// bytes, relative paths, and any other scheme are rejected.
pub fn file_uri_path(uri: &str) -> Option<PathBuf> {
    let rest = uri.strip_prefix("file://")?;
    let path = if rest.starts_with('/') {
        rest
    } else {
        rest.strip_prefix("localhost")?
    };
    if !path.starts_with('/') || path.contains(['?', '#']) {
        return None;
    }
    let decoded = percent_decode(path)?;
    if decoded.contains('\0') {
        return None;
    }
    Some(PathBuf::from(decoded))
}

fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = value.get(index + 1..index + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// A delivery-safe attachment name: a plain bounded name with no
/// separators or control characters.
pub fn safe_file_name(name: &str) -> Option<String> {
    let name = name.trim();
    if name.is_empty()
        || name.chars().count() > MAX_SHARED_FILE_NAME_CHARS
        || name.starts_with('.')
        || name.contains(['/', '\\'])
        || name.chars().any(char::is_control)
    {
        return None;
    }
    Some(name.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowlist_classifies_images_and_files_and_rejects_everything_else() {
        assert_eq!(
            classify_extension("PNG"),
            Some((SharedMediaKind::Image, "image/png"))
        );
        assert_eq!(
            classify_extension("pdf"),
            Some((SharedMediaKind::File, "application/pdf"))
        );
        for rejected in ["mp4", "mov", "mp3", "exe", "sh", "svg", "html", ""] {
            assert_eq!(classify_extension(rejected), None, "{rejected}");
        }
    }

    #[test]
    fn content_sniffing_rejects_mislabelled_and_executable_payloads() {
        assert!(content_matches("image/png", b"\x89PNG\r\n\x1a\nrest"));
        assert!(!content_matches("image/png", b"GIF89a"));
        assert!(content_matches("text/plain", "纯文本".as_bytes()));
        assert!(!content_matches("text/plain", b"\x7FELF\x02\x01"));
        assert!(!content_matches("text/plain", b"#!/bin/sh\nrm -rf /"));
        assert!(!content_matches("text/plain", &[0xFF, 0xFE, 0x00]));
        assert!(content_matches("application/zip", b"PK\x03\x04data"));
        assert!(!content_matches("application/x-unknown", b"anything"));
    }

    #[test]
    fn file_uris_parse_only_to_absolute_local_paths() {
        assert_eq!(
            file_uri_path("file:///srv/project/out/chart%20v2.png"),
            Some(PathBuf::from("/srv/project/out/chart v2.png"))
        );
        assert_eq!(
            file_uri_path("file://localhost/srv/a.png"),
            Some(PathBuf::from("/srv/a.png"))
        );
        for rejected in [
            "https://example.com/a.png",
            "file://evil.example/srv/a.png",
            "file://relative/a.png",
            "file:///srv/a%00.png",
            "file:///srv/a.png?x=1",
            "file:///srv/%zz.png",
            "/srv/a.png",
        ] {
            assert_eq!(file_uri_path(rejected), None, "{rejected}");
        }
    }

    #[test]
    fn attachment_names_are_plain_bounded_names() {
        assert_eq!(safe_file_name("report.pdf").as_deref(), Some("report.pdf"));
        for rejected in [
            "",
            "../report.pdf",
            "a/b.pdf",
            ".env",
            "bad\nname.pdf",
            &"x".repeat(200),
        ] {
            assert_eq!(safe_file_name(rejected), None, "{rejected:?}");
        }
    }
}
