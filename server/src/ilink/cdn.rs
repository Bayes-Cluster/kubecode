//! Encrypted CDN primitives: upload/download URL construction with origin
//! validation, AES-128-ECB encryption, PKCS#7 size calculation, bounded
//! download with decryption, and upload response parsing (ADR 0211 §10,
//! upstream `src/cdn/`). Uploads retry transient server failures a bounded
//! number of times; client errors abort immediately.

use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;

use super::crypto::{
    aes_ecb_decrypt, aes_ecb_encrypt, aes_ecb_padded_size, md5_hex, parse_cdn_aes_key,
    random_key_hex,
};
use super::error::IlinkError;
use super::origins::OriginPolicy;
use super::types::{CdnMedia, GetUploadUrlReq, UPLOAD_MEDIA_TYPE_IMAGE};

/// Media payload bound (ADR 0211 §10).
pub const MAX_MEDIA_BYTES: usize = 10 * 1024 * 1024;
/// Bounded upload retry budget; 4xx responses are never retried.
pub const UPLOAD_MAX_RETRIES: usize = 3;

/// Result of a successful CDN upload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UploadedMedia {
    pub filekey: String,
    /// Download `encrypted_query_param` for the `CdnMedia` reference.
    pub download_encrypted_query_param: String,
    /// AES-128 key, hex-encoded (wire `aeskey`).
    pub aeskey_hex: String,
    /// Plaintext size in bytes.
    pub file_size: usize,
    /// Ciphertext size in bytes (AES-128-ECB + PKCS#7).
    pub file_size_ciphertext: usize,
}

/// Everything `getuploadurl` needs for a first-release (thumbnail-free)
/// upload, derived from the plaintext payload.
#[must_use]
pub fn build_upload_request(
    to_user_id: &str,
    media_type: i64,
    plaintext: &[u8],
) -> (GetUploadUrlReq, [u8; 16]) {
    let (key, aeskey_hex) = random_key_hex();
    let filekey = {
        // filekey is a random 16-byte hex identifier of its own.
        let (_key, hex) = random_key_hex();
        hex
    };
    (
        GetUploadUrlReq {
            filekey: Some(filekey),
            media_type: Some(media_type),
            to_user_id: Some(to_user_id.to_owned()),
            rawsize: Some(plaintext.len() as i64),
            rawfilemd5: Some(md5_hex(plaintext)),
            filesize: Some(aes_ecb_padded_size(plaintext.len()) as i64),
            thumb_rawsize: None,
            thumb_rawfilemd5: None,
            thumb_filesize: None,
            no_need_thumb: Some(true),
            aeskey: Some(aeskey_hex),
            base_info: None,
        },
        key,
    )
}

#[derive(Clone)]
pub struct CdnClient {
    http: reqwest::Client,
    cdn_base: reqwest::Url,
    policy: OriginPolicy,
    timeout: Duration,
}

impl CdnClient {
    pub fn new(
        cdn_base: &str,
        policy: OriginPolicy,
        timeout: Duration,
    ) -> Result<Self, IlinkError> {
        let mut base = policy.validate_url(cdn_base)?;
        // Relative endpoint concatenation requires a trailing slash.
        if !base.as_str().ends_with('/') {
            base.set_path(&format!("{}/", base.path()));
        }
        Ok(Self {
            http: reqwest::Client::builder()
                .user_agent(concat!("kubecode-ilink/", env!("CARGO_PKG_VERSION")))
                .build()
                .map_err(|error| IlinkError::from_transport("cdn", &error))?,
            cdn_base: base,
            policy,
            timeout,
        })
    }

    /// Upload URL: the server-provided `upload_full_url` when present
    /// (validated!), otherwise the canonical `/upload?...` fallback.
    pub fn build_upload_url(
        &self,
        upload_full_url: Option<&str>,
        upload_param: Option<&str>,
        filekey: &str,
    ) -> Result<reqwest::Url, IlinkError> {
        if let Some(full_url) = upload_full_url.map(str::trim).filter(|url| !url.is_empty()) {
            return self.policy.validate_url(full_url);
        }
        let Some(upload_param) = upload_param
            .map(str::trim)
            .filter(|param| !param.is_empty())
        else {
            return Err(IlinkError::OriginRejected {
                reason: "getuploadurl returned no upload URL or upload_param",
            });
        };
        self.policy.validate_url(&format!(
            "{}upload?encrypted_query_param={}&filekey={}",
            self.cdn_base.as_str(),
            urlencode(upload_param),
            urlencode(filekey),
        ))
    }

    /// Download URL: the server-provided `full_url` when present
    /// (validated!), otherwise the canonical `/download?...` fallback.
    pub fn build_download_url(&self, media: &CdnMedia) -> Result<reqwest::Url, IlinkError> {
        if let Some(full_url) = media
            .full_url
            .as_deref()
            .map(str::trim)
            .filter(|url| !url.is_empty())
        {
            return self.policy.validate_url(full_url);
        }
        let Some(query_param) = media
            .encrypt_query_param
            .as_deref()
            .map(str::trim)
            .filter(|param| !param.is_empty())
        else {
            return Err(IlinkError::OriginRejected {
                reason: "media reference carries neither full_url nor encrypt_query_param",
            });
        };
        self.policy.validate_url(&format!(
            "{}download?encrypted_query_param={}",
            self.cdn_base.as_str(),
            urlencode(query_param),
        ))
    }

    /// Uploads `plaintext` through the CDN with AES-128-ECB encryption.
    /// `upload` describes the pre-signed destination from `getuploadurl`.
    pub async fn upload(
        &self,
        plaintext: &[u8],
        upload_full_url: Option<&str>,
        upload_param: Option<&str>,
        filekey: &str,
        key: &[u8; 16],
    ) -> Result<UploadedMedia, IlinkError> {
        if plaintext.len() > MAX_MEDIA_BYTES {
            return Err(IlinkError::PayloadTooLarge {
                limit: MAX_MEDIA_BYTES,
            });
        }
        let url = self.build_upload_url(upload_full_url, upload_param, filekey)?;
        let ciphertext = aes_ecb_encrypt(key, plaintext)?;
        let mut last_error = IlinkError::HttpStatus {
            operation: "cdn_upload",
            status: 0,
        };
        for _attempt in 0..UPLOAD_MAX_RETRIES {
            let request = self
                .http
                .post(url.clone())
                .header("Content-Type", "application/octet-stream")
                .body(ciphertext.clone())
                .timeout(self.timeout);
            let response = match request.send().await {
                Ok(response) => response,
                Err(error) => {
                    last_error = IlinkError::from_transport("cdn_upload", &error);
                    continue;
                }
            };
            let status = response.status();
            if status.is_success() {
                let Some(download_param) = response
                    .headers()
                    .get("x-encrypted-param")
                    .and_then(|value| value.to_str().ok())
                    .map(str::to_owned)
                    .filter(|value| !value.is_empty())
                else {
                    return Err(IlinkError::InvalidResponse {
                        operation: "cdn_upload",
                    });
                };
                return Ok(UploadedMedia {
                    filekey: filekey.to_owned(),
                    download_encrypted_query_param: download_param,
                    aeskey_hex: hex::encode(key),
                    file_size: plaintext.len(),
                    file_size_ciphertext: ciphertext.len(),
                });
            }
            last_error = IlinkError::HttpStatus {
                operation: "cdn_upload",
                status: status.as_u16(),
            };
            // Client errors are deterministic — never retried.
            if status.is_client_error() {
                return Err(last_error);
            }
        }
        Err(last_error)
    }

    /// Downloads and decrypts a CDN media reference within [`MAX_MEDIA_BYTES`].
    pub async fn download_and_decrypt(&self, media: &CdnMedia) -> Result<Vec<u8>, IlinkError> {
        let encoded_key = media.aes_key.as_deref().ok_or(IlinkError::Crypto(
            "media reference carries no aes_key".into(),
        ))?;
        let key = parse_cdn_aes_key(encoded_key)?;
        let encrypted = self.download_encrypted(media).await?;
        aes_ecb_decrypt(&key, &encrypted)
    }

    /// Downloads raw (still-encrypted) bytes within [`MAX_MEDIA_BYTES`].
    pub async fn download_encrypted(&self, media: &CdnMedia) -> Result<Vec<u8>, IlinkError> {
        let url = self.build_download_url(media)?;
        let response = self
            .http
            .get(url)
            .timeout(self.timeout)
            .send()
            .await
            .map_err(|error| IlinkError::from_transport("cdn_download", &error))?;
        let status = response.status();
        if !status.is_success() {
            return Err(IlinkError::HttpStatus {
                operation: "cdn_download",
                status: status.as_u16(),
            });
        }
        if let Some(length) = response.content_length()
            && length as usize > MAX_MEDIA_BYTES
        {
            return Err(IlinkError::PayloadTooLarge {
                limit: MAX_MEDIA_BYTES,
            });
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|error| IlinkError::from_transport("cdn_download", &error))?;
        if bytes.len() > MAX_MEDIA_BYTES {
            return Err(IlinkError::PayloadTooLarge {
                limit: MAX_MEDIA_BYTES,
            });
        }
        Ok(bytes.to_vec())
    }

    /// Convenience for the common first-release upload path: builds the
    /// `getuploadurl` request material, uploads, and returns both the
    /// request (for the caller's `getuploadurl` round trip) and the key.
    pub fn prepare_image_upload(
        &self,
        to_user_id: &str,
        plaintext: &[u8],
    ) -> Result<(GetUploadUrlReq, [u8; 16]), IlinkError> {
        if plaintext.len() > MAX_MEDIA_BYTES {
            return Err(IlinkError::PayloadTooLarge {
                limit: MAX_MEDIA_BYTES,
            });
        }
        Ok(build_upload_request(
            to_user_id,
            UPLOAD_MEDIA_TYPE_IMAGE,
            plaintext,
        ))
    }

    /// Renders the outbound `CdnMedia` reference for an uploaded file:
    /// hex `aeskey` re-encoded as base64 bytes, matching upstream sends.
    pub fn media_reference(upload: &UploadedMedia) -> CdnMedia {
        CdnMedia {
            encrypt_query_param: Some(upload.download_encrypted_query_param.clone()),
            aes_key: Some(BASE64.encode(hex::decode(&upload.aeskey_hex).unwrap_or_default())),
            encrypt_type: None,
            full_url: None,
        }
    }
}

/// Percent-encodes a query parameter value.
fn urlencode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char);
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn client() -> CdnClient {
        CdnClient::new(
            "http://127.0.0.1:9",
            OriginPolicy::testing(),
            Duration::from_secs(5),
        )
        .expect("cdn client")
    }

    #[test]
    fn upload_request_carries_sizes_digest_and_key() {
        let plaintext = b"hello world";
        let (request, key) =
            build_upload_request("wxid_synthetic", UPLOAD_MEDIA_TYPE_IMAGE, plaintext);
        assert_eq!(request.rawsize, Some(plaintext.len() as i64));
        assert_eq!(request.rawfilemd5.as_deref(), Some(&md5_hex(plaintext)[..]));
        // 11 bytes → one padded block.
        assert_eq!(request.filesize, Some(16));
        assert_eq!(request.no_need_thumb, Some(true));
        assert_eq!(
            hex::encode(key),
            request.aeskey.as_deref().unwrap_or_default()
        );
        assert!(
            request
                .filekey
                .as_deref()
                .is_some_and(|key| key.len() == 32)
        );
    }

    #[test]
    fn media_reference_re_encodes_the_key_for_the_wire() {
        let upload = UploadedMedia {
            filekey: "filekey".into(),
            download_encrypted_query_param: "param".into(),
            aeskey_hex: "00112233445566778899aabbccddeeff".into(),
            file_size: 3,
            file_size_ciphertext: 16,
        };
        let media = CdnClient::media_reference(&upload);
        assert_eq!(
            parse_cdn_aes_key(media.aes_key.as_deref().expect("aes_key")).expect("key")[0],
            0x00
        );
        assert_eq!(media.encrypt_query_param.as_deref(), Some("param"));
    }

    #[test]
    fn oversized_payloads_are_rejected_before_any_io() {
        let client = client();
        let big = vec![0u8; MAX_MEDIA_BYTES + 1];
        assert!(matches!(
            client.prepare_image_upload("wxid_synthetic", &big),
            Err(IlinkError::PayloadTooLarge { .. })
        ));
    }

    #[test]
    fn missing_upload_target_is_an_error() {
        let client = client();
        assert!(client.build_upload_url(None, None, "filekey").is_err());
        let media = CdnMedia::default();
        assert!(client.build_download_url(&media).is_err());
    }
}
