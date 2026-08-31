//! Typed iLink errors and secret redaction helpers (ADR 0211 §12).
//!
//! Errors carry only the operation name, transport classification, HTTP
//! status, or iLink business code — never raw response bodies, tokens,
//! context tokens, QR identifiers, or encrypted query parameters. Secret
//! values cross module boundaries inside [`Secret`], whose `Debug`/`Display`
//! output is redacted so an accidental `{:?}` cannot leak credential
//! material into logs.

use std::fmt;

use thiserror::Error;

/// Placeholder emitted wherever a secret would otherwise be rendered.
pub const REDACTED: &str = "<redacted>";

/// Wraps credential-bearing strings so that any accidental formatting of a
/// containing structure renders [`REDACTED`] instead of the secret itself.
#[derive(Clone, Default, PartialEq, Eq)]
pub struct Secret(String);

impl Secret {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    /// The unredacted value. Only the protocol layer may call this.
    pub fn expose(&self) -> &str {
        &self.0
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "Secret({REDACTED})")
    }
}

impl fmt::Display for Secret {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{REDACTED}")
    }
}

/// Shows only the first `prefix` characters of a secret plus its byte
/// length. Returns `"(none)"` when absent, mirroring upstream diagnostics.
pub fn redact_token(secret: Option<&str>, prefix: usize) -> String {
    let Some(secret) = secret else {
        return "(none)".to_owned();
    };
    if secret.is_empty() {
        return "****(len=0)".to_owned();
    }
    let head: String = secret.chars().take(prefix).collect();
    format!("{head}…(len={})", secret.len())
}

/// Origin plus path only; any query string becomes `?{REDACTED}` because
/// iLink URLs carry signatures and encrypted query parameters.
pub fn redact_url(raw_url: &str) -> String {
    match raw_url.split_once('?') {
        Some((base, _)) => format!("{base}?{REDACTED}"),
        None => raw_url.to_owned(),
    }
}

/// JSON field names whose values must be masked in diagnostics.
const SENSITIVE_FIELDS: [&str; 8] = [
    "context_token",
    "bot_token",
    "token",
    "authorization",
    "Authorization",
    "aeskey",
    "aes_key",
    "typing_ticket",
];

/// Masks sensitive JSON field values and truncates, for bounded diagnostics.
pub fn redact_body(body: &str, max_len: usize) -> String {
    let mut redacted = body.to_owned();
    for field in SENSITIVE_FIELDS {
        let needle = format!("\"{field}\":");
        let replaced = format!("{needle}\"{REDACTED}\"");
        let mut search_from = 0;
        while let Some(relative) = redacted[search_from..].find(&needle) {
            let start = search_from + relative;
            let value_start = start + needle.len();
            let Some(open_offset) = redacted[value_start..].find('"') else {
                break;
            };
            let open = value_start + open_offset + 1;
            let Some(close_offset) = redacted[open..].find('"') else {
                break;
            };
            let replace_end = open + close_offset + 1;
            redacted.replace_range(start..replace_end, &replaced);
            search_from = start + replaced.len();
        }
    }
    if redacted.len() <= max_len {
        redacted
    } else {
        format!(
            "{}…(truncated, totalLen={})",
            &redacted[..max_len],
            redacted.len()
        )
    }
}

/// Coarse transport classification used in place of raw error text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransportKind {
    /// The connection itself failed (DNS, TCP, TLS).
    Connect,
    /// The request was sent but did not complete.
    Request,
}

impl TransportKind {
    fn description(self) -> &'static str {
        match self {
            Self::Connect => "connection failed",
            Self::Request => "network request failed",
        }
    }
}

#[derive(Debug, Error)]
pub enum IlinkError {
    #[error("{operation}: request timed out")]
    Timeout { operation: &'static str },
    #[error("{operation}: transport error ({kind})", kind = kind.description())]
    Transport {
        operation: &'static str,
        kind: TransportKind,
    },
    #[error("{operation}: unexpected HTTP status {status}")]
    HttpStatus {
        operation: &'static str,
        status: u16,
    },
    #[error("{operation}: business error ret={code}")]
    Business { operation: &'static str, code: i64 },
    /// iLink `errcode` signals the channel session itself is gone and the
    /// stored credentials must be re-established by re-scanning the QR code.
    #[error("{operation}: iLink session expired (errcode={code})")]
    SessionExpired { operation: &'static str, code: i64 },
    #[error("{operation}: response was not valid iLink JSON")]
    InvalidResponse { operation: &'static str },
    /// Rejected before any network access. The reason names the rule, never
    /// the offending URL or host.
    #[error("origin rejected: {reason}")]
    OriginRejected { reason: &'static str },
    #[error("crypto error: {0}")]
    Crypto(String),
    #[error("payload exceeds the {limit} byte channel limit")]
    PayloadTooLarge { limit: usize },
}

impl IlinkError {
    /// Classifies a reqwest failure without carrying its raw text.
    pub fn from_transport(operation: &'static str, error: &reqwest::Error) -> Self {
        if error.is_timeout() {
            Self::Timeout { operation }
        } else if error.is_connect() {
            Self::Transport {
                operation,
                kind: TransportKind::Connect,
            }
        } else {
            Self::Transport {
                operation,
                kind: TransportKind::Request,
            }
        }
    }

    /// True when the error means the iLink channel session must be
    /// re-established (credentials rejected by the server).
    pub fn is_session_expired(&self) -> bool {
        matches!(self, Self::SessionExpired { .. })
    }
}

/// Checks the iLink business envelope. `errcode` non-zero means the channel
/// session level failed (-14 is the documented session timeout); `ret`
/// non-zero is an ordinary business failure.
pub fn check_business(
    operation: &'static str,
    ret: Option<i64>,
    errcode: Option<i64>,
) -> Result<(), IlinkError> {
    if let Some(errcode) = errcode.filter(|code| *code != 0) {
        return if errcode == -14 {
            Err(IlinkError::SessionExpired {
                operation,
                code: errcode,
            })
        } else {
            Err(IlinkError::Business {
                operation,
                code: errcode,
            })
        };
    }
    if let Some(ret) = ret.filter(|code| *code != 0) {
        return Err(IlinkError::Business {
            operation,
            code: ret,
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_never_renders_its_value() {
        let token = Secret::new("bot-token-abc123");
        assert_eq!(format!("{token:?}"), "Secret(<redacted>)");
        assert_eq!(token.to_string(), "<redacted>");
        assert_eq!(token.expose(), "bot-token-abc123");
    }

    #[test]
    fn redact_token_shows_only_prefix_and_length() {
        assert_eq!(redact_token(None, 6), "(none)");
        assert_eq!(redact_token(Some(""), 6), "****(len=0)");
        assert_eq!(redact_token(Some("abc"), 6), "abc…(len=3)");
        assert_eq!(
            redact_token(Some("tokenvalue-1234567890"), 6),
            "tokenv…(len=21)"
        );
    }

    #[test]
    fn redact_url_strips_query_parameters() {
        assert_eq!(
            redact_url("https://szextshort.wechat.com/download?encrypted_query_param=SECRET&sig=X"),
            "https://szextshort.wechat.com/download?<redacted>"
        );
        assert_eq!(
            redact_url("https://ilinkai.weixin.qq.com/ilink/bot/getupdates"),
            "https://ilinkai.weixin.qq.com/ilink/bot/getupdates"
        );
    }

    #[test]
    fn redact_body_masks_sensitive_fields_and_truncates() {
        let body = r#"{"context_token":"CTX","token":"TOK","aeskey":"KEY","n":1}"#;
        let redacted = redact_body(body, 4096);
        assert!(!redacted.contains("CTX"));
        assert!(!redacted.contains("TOK"));
        assert!(!redacted.contains("KEY"));
        assert!(redacted.contains(r#""context_token":"<redacted>""#));
        assert!(redacted.contains(r#""n":1"#));
        let long = format!(r#"{{"data":"{}"}}"#, "x".repeat(400));
        assert!(redact_body(&long, 50).contains("(truncated, totalLen="));
    }

    #[test]
    fn business_codes_map_to_typed_errors() {
        assert!(check_business("sendmessage", Some(0), None).is_ok());
        assert!(check_business("sendmessage", None, None).is_ok());
        let business = check_business("sendmessage", Some(-1), None).unwrap_err();
        assert!(matches!(business, IlinkError::Business { code: -1, .. }));
        let expired = check_business("getupdates", Some(0), Some(-14)).unwrap_err();
        assert!(expired.is_session_expired());
        assert!(check_business("getupdates", Some(0), Some(0)).is_ok());
    }
}
