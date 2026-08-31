//! Origin validation for every iLink HTTP destination (ADR 0211 §11).
//!
//! All Tencent endpoints — the fixed API base, redirect hosts, and CDN
//! hosts — must be HTTPS under the `.qq.com` / `.wechat.com` suffixes
//! before any request is issued. Upstream-supplied URLs are never
//! destinations on their own authority: they pass through the same policy.

use reqwest::Url;

use super::error::IlinkError;

/// The fixed base URL for QR login requests, per the upstream channel build.
pub const QR_LOGIN_BASE_URL: &str = "https://ilinkai.weixin.qq.com";

/// Host suffixes trusted for API, redirect, and CDN traffic.
pub const TRUSTED_SUFFIXES: [&str; 2] = [".qq.com", ".wechat.com"];

/// Where origins are allowed. Production restricts destinations to Tencent
/// hosts; tests widen the policy to loopback so fixture servers can stand
/// in for the wire protocol.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OriginScope {
    Production,
    /// Fixture-test scope: additionally allows loopback hosts so a wire
    /// mock can stand in for Tencent. Never used by the Runtime.
    Testing,
}

impl OriginScope {
    fn allows(self, host: &str) -> bool {
        match self {
            Self::Production => TRUSTED_SUFFIXES.iter().any(|suffix| host.ends_with(suffix)),
            Self::Testing => {
                TRUSTED_SUFFIXES.iter().any(|suffix| host.ends_with(suffix))
                    || host == "127.0.0.1"
                    || host == "localhost"
                    || host == "::1"
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OriginPolicy {
    scope: OriginScope,
}

impl OriginPolicy {
    /// The shipping policy: HTTPS-only Tencent hosts.
    pub fn production() -> Self {
        Self {
            scope: OriginScope::Production,
        }
    }

    /// Fixture tests only: permits loopback fixture servers. The Runtime
    /// must never construct this scope.
    pub fn testing() -> Self {
        Self {
            scope: OriginScope::Testing,
        }
    }

    /// Validates a complete URL before it may be used as a request
    /// destination. Rejects non-HTTPS schemes, embedded credentials, and
    /// untrusted hosts without exposing the URL in the error.
    pub fn validate_url(&self, raw: &str) -> Result<Url, IlinkError> {
        let url = Url::parse(raw).map_err(|_| IlinkError::OriginRejected {
            reason: "unparseable destination URL",
        })?;
        let scheme_ok = match self.scope {
            OriginScope::Production => url.scheme() == "https",
            // Fixture servers stand in for Tencent over plain HTTP on loopback.
            OriginScope::Testing => url.scheme() == "https" || url.scheme() == "http",
        };
        if !scheme_ok {
            return Err(IlinkError::OriginRejected {
                reason: "destination scheme must be https",
            });
        }
        if !url.username().is_empty() || url.password().is_some() {
            return Err(IlinkError::OriginRejected {
                reason: "destination URL must not carry credentials",
            });
        }
        let Some(host) = url.host_str() else {
            return Err(IlinkError::OriginRejected {
                reason: "destination URL has no host",
            });
        };
        let host = host.to_ascii_lowercase();
        if !self.scope.allows(&host) {
            return Err(IlinkError::OriginRejected {
                reason: "destination host is outside the Tencent allowlist",
            });
        }
        Ok(url)
    }

    /// Validates a bare redirect host from a `scaned_but_redirect` status
    /// and returns the HTTPS base URL to poll next.
    pub fn validate_redirect_host(&self, host: &str) -> Result<String, IlinkError> {
        let host = host.trim().to_ascii_lowercase();
        if host.is_empty()
            || !host
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
        {
            return Err(IlinkError::OriginRejected {
                reason: "redirect host is not a plain hostname",
            });
        }
        if !self.scope.allows(&host) {
            return Err(IlinkError::OriginRejected {
                reason: "redirect host is outside the Tencent allowlist",
            });
        }
        Ok(format!("https://{host}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn production_accepts_tencent_https_hosts() {
        let policy = OriginPolicy::production();
        assert!(policy.validate_url(QR_LOGIN_BASE_URL).is_ok());
        assert!(
            policy
                .validate_url("https://szextshort.wechat.com/cgi-bin/download?x=1")
                .is_ok()
        );
        assert!(
            policy
                .validate_redirect_host("ilinkai.weixin.qq.com")
                .is_ok()
        );
    }

    #[test]
    fn production_rejects_unexpected_hosts_schemes_and_credentials() {
        let policy = OriginPolicy::production();
        for offender in [
            "https://evil.example.com/ilink/bot/getupdates",
            "http://ilinkai.weixin.qq.com/ilink/bot/getupdates",
            "https://token@ilinkai.weixin.qq.com/ilink/bot/getupdates",
            "https://user:pass@szextshort.wechat.com/download",
            "https://qq.com.evil.example.com/download",
            "file:///etc/passwd",
            "https://127.0.0.1:9000/upload",
        ] {
            let error = policy.validate_url(offender).expect_err(offender);
            assert!(
                matches!(error, IlinkError::OriginRejected { .. }),
                "{offender} must be rejected"
            );
        }
        assert!(policy.validate_redirect_host("evil.example.com").is_err());
        assert!(
            policy
                .validate_redirect_host("weixin.qq.com.evil.example")
                .is_err()
        );
        assert!(
            policy
                .validate_redirect_host("ilinkai.weixin.qq.com; rm -rf")
                .is_err()
        );
        assert!(policy.validate_redirect_host("").is_err());
    }

    #[test]
    fn suffix_match_is_label_aligned() {
        let policy = OriginPolicy::production();
        // First-level labels under the trusted suffixes are allowed.
        assert!(policy.validate_url("https://weixin.qq.com/").is_ok());
        assert!(
            policy
                .validate_url("https://szextshort.wechat.com/")
                .is_ok()
        );
        // Apex domains themselves are outside the suffix allowlist.
        assert!(policy.validate_url("https://qq.com/").is_err());
        // A host merely ending in a trusted string without the dot boundary
        // is not trusted.
        assert!(policy.validate_url("https://notqq.com/").is_err());
    }

    #[test]
    fn error_text_never_contains_the_offending_url() {
        let policy = OriginPolicy::production();
        let error = policy
            .validate_url("https://secret-host.evil.example.com/upload?token=abc")
            .unwrap_err();
        let rendered = format!("{error} {error:?}");
        assert!(!rendered.contains("secret-host"));
        assert!(!rendered.contains("token=abc"));
    }

    #[test]
    fn testing_scope_allows_loopback_fixture_servers() {
        let policy = OriginPolicy::testing();
        assert!(
            policy
                .validate_url("http://127.0.0.1:41234/ilink/bot/sendmessage")
                .is_ok()
        );
        assert!(policy.validate_url("https://evil.example.com/").is_err());
    }
}
