//! iLink channel crypto primitives: MD5 compatibility digests, random wire
//! identifiers, AES-128-ECB with PKCS#7 padding, and CDN key decoding
//! (ADR 0211). These support the wire protocol only — Kubecode's own
//! credential-at-rest encryption is specified separately in ADR 0211 §3.

use aes::cipher::{BlockDecrypt, BlockEncrypt, KeyInit};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use md5::{Digest, Md5};

use super::error::IlinkError;

const AES_BLOCK: usize = 16;

/// Lowercase hex MD5, as required by `getuploadurl.rawfilemd5`.
pub fn md5_hex(data: &[u8]) -> String {
    let mut hasher = Md5::new();
    hasher.update(data);
    hex::encode(hasher.finalize())
}

/// A fresh random `u32`, used for the `X-WECHAT-UIN` header.
pub fn random_u32() -> u32 {
    rand::random::<u32>()
}

/// `X-WECHAT-UIN`: random uint32 → decimal string → base64, per upstream.
pub fn random_wechat_uin() -> String {
    BASE64.encode(random_u32().to_string().as_bytes())
}

/// Random 16-byte key, returned raw (for AES) and hex-encoded (for the
/// `getuploadurl.aeskey` / `filekey` wire fields).
pub fn random_key_hex() -> ([u8; AES_BLOCK], String) {
    let key: [u8; AES_BLOCK] = rand::random();
    (key, hex::encode(key))
}

/// PKCS#7 pads to the AES block boundary; an aligned input still receives a
/// full block of padding, so ciphertext size is always a positive multiple
/// of 16.
pub fn pkcs7_pad(mut data: Vec<u8>) -> Vec<u8> {
    let pad = AES_BLOCK - (data.len() % AES_BLOCK);
    data.extend(std::iter::repeat_n(pad as u8, pad));
    data
}

/// Strips and validates PKCS#7 padding.
pub fn pkcs7_unpad(padded: &[u8]) -> Result<&[u8], IlinkError> {
    let Some(&pad) = padded.last() else {
        return Err(IlinkError::Crypto("cannot unpad empty ciphertext".into()));
    };
    if pad == 0 || pad as usize > AES_BLOCK || pad as usize > padded.len() {
        return Err(IlinkError::Crypto("invalid PKCS#7 padding".into()));
    }
    let pad = pad as usize;
    if padded[padded.len() - pad..]
        .iter()
        .any(|byte| *byte as usize != pad)
    {
        return Err(IlinkError::Crypto("inconsistent PKCS#7 padding".into()));
    }
    Ok(&padded[..padded.len() - pad])
}

/// Ciphertext size for a plaintext of `plaintext_size` bytes
/// (AES-128-ECB + PKCS#7), as sent in `getuploadurl.filesize`. Padding
/// always adds at least one byte.
pub fn aes_ecb_padded_size(plaintext_size: usize) -> usize {
    plaintext_size / AES_BLOCK * AES_BLOCK + AES_BLOCK
}

fn cipher_for(key: &[u8; AES_BLOCK]) -> aes::Aes128 {
    aes::Aes128::new(key.into())
}

/// Encrypts with AES-128-ECB and PKCS#7 padding.
pub fn aes_ecb_encrypt(key: &[u8; AES_BLOCK], plaintext: &[u8]) -> Result<Vec<u8>, IlinkError> {
    let cipher = cipher_for(key);
    let mut out = pkcs7_pad(plaintext.to_vec());
    for chunk in out.chunks_mut(AES_BLOCK) {
        let block = aes::cipher::Block::<aes::Aes128>::from_mut_slice(chunk);
        cipher.encrypt_block(block);
    }
    Ok(out)
}

/// Decrypts AES-128-ECB and strips PKCS#7 padding. Ciphertext must be
/// block-aligned.
pub fn aes_ecb_decrypt(key: &[u8; AES_BLOCK], ciphertext: &[u8]) -> Result<Vec<u8>, IlinkError> {
    if !ciphertext.len().is_multiple_of(AES_BLOCK) || ciphertext.is_empty() {
        return Err(IlinkError::Crypto(
            "ciphertext must be a non-empty multiple of the 16-byte block".into(),
        ));
    }
    let cipher = cipher_for(key);
    let mut out = ciphertext.to_vec();
    for chunk in out.chunks_mut(AES_BLOCK) {
        let block = aes::cipher::Block::<aes::Aes128>::from_mut_slice(chunk);
        cipher.decrypt_block(block);
    }
    Ok(pkcs7_unpad(&out)?.to_vec())
}

/// Decodes a CDN `aes_key` field. Two encodings occur in the wild:
/// base64(16 raw bytes) for images, and base64(32 ASCII hex chars) for
/// files, voice, and video — where the hex string must be decoded again.
pub fn parse_cdn_aes_key(encoded: &str) -> Result<[u8; AES_BLOCK], IlinkError> {
    let decoded = BASE64
        .decode(encoded.as_bytes())
        .map_err(|_| IlinkError::Crypto("aes_key is not valid base64".into()))?;
    if decoded.len() == AES_BLOCK {
        let mut key = [0u8; AES_BLOCK];
        key.copy_from_slice(&decoded);
        return Ok(key);
    }
    if decoded.len() == AES_BLOCK * 2 && decoded.iter().all(u8::is_ascii_hexdigit) {
        // base64 → 32-char hex string → raw 16 bytes.
        let raw = hex::decode(&decoded)
            .map_err(|_| IlinkError::Crypto("aes_key hex is malformed".into()))?;
        let mut key = [0u8; AES_BLOCK];
        key.copy_from_slice(&raw);
        return Ok(key);
    }
    Err(IlinkError::Crypto(format!(
        "aes_key must decode to 16 raw bytes or a 32-char hex string, got {} bytes",
        decoded.len()
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn md5_matches_known_vectors() {
        assert_eq!(md5_hex(b""), "d41d8cd98f00b204e9800998ecf8427e");
        assert_eq!(md5_hex(b"abc"), "900150983cd24fb0d6963f7d28e17f72");
    }

    #[test]
    fn wechat_uin_is_base64_of_a_decimal_uint32() {
        for _ in 0..16 {
            let uin = random_wechat_uin();
            let decoded = BASE64.decode(uin.as_bytes()).expect("base64 uin");
            let text = std::str::from_utf8(&decoded).expect("utf-8 digits");
            let value: u32 = text.parse().expect("decimal u32");
            let _ = value;
        }
    }

    #[test]
    fn pkcs7_padding_round_trips_every_length() {
        for size in [0usize, 1, 15, 16, 17, 31, 32, 100] {
            let data = vec![7u8; size];
            let padded = pkcs7_pad(data.clone());
            assert_eq!(padded.len() % 16, 0);
            assert_eq!(aes_ecb_padded_size(size), padded.len());
            assert_eq!(pkcs7_unpad(&padded).expect("unpad"), data.as_slice());
        }
    }

    #[test]
    fn aes_ecb_round_trips_and_matches_reference_vector() {
        let key = [
            0x2bu8, 0x7e, 0x15, 0x16, 0x28, 0xae, 0xd2, 0xa6, 0xab, 0xf7, 0x15, 0x88, 0x09, 0xcf,
            0x4f, 0x3c,
        ];
        // NIST SP 800-38A AES-128 vector for this key.
        let plaintext = [
            0x6b, 0xc1, 0xbe, 0xe2, 0x2e, 0x40, 0x9f, 0x96, 0xe9, 0x3d, 0x7e, 0x11, 0x73, 0x93,
            0x17, 0x2a,
        ];
        let encrypted = aes_ecb_encrypt(&key, &plaintext).expect("encrypt");
        assert_eq!(
            encrypted[..16],
            [
                0x3a, 0xd7, 0x7b, 0xb4, 0x0d, 0x7a, 0x36, 0x60, 0xa8, 0x9e, 0xca, 0xf3, 0x24, 0x66,
                0xef, 0x97
            ]
        );
        let decrypted = aes_ecb_decrypt(&key, &encrypted).expect("decrypt");
        assert_eq!(decrypted, plaintext.to_vec());
        // Multi-block round trip with a non-aligned tail.
        let body: Vec<u8> = (0..53u8).collect();
        let round = aes_ecb_decrypt(&key, &aes_ecb_encrypt(&key, &body).expect("encrypt"))
            .expect("decrypt");
        assert_eq!(round, body);
    }

    #[test]
    fn aes_ecb_rejects_bad_ciphertext_and_padding() {
        let key = [1u8; 16];
        assert!(aes_ecb_decrypt(&key, &[1, 2, 3]).is_err());
        assert!(aes_ecb_decrypt(&key, &[]).is_err());
        // Padding byte larger than the block is invalid.
        let mut forged = vec![0u8; 16];
        forged[15] = 32;
        assert!(pkcs7_unpad(&forged).is_err());
    }

    #[test]
    fn cdn_aes_key_accepts_both_wild_encodings() {
        let raw: [u8; 16] = core::array::from_fn(|index| index as u8);
        // Encoding 1: base64 of the 16 raw bytes (images).
        let raw_b64 = BASE64.encode(raw);
        assert_eq!(parse_cdn_aes_key(&raw_b64).expect("raw encoding"), raw);
        // Encoding 2: base64 of the 32-char hex string (file/voice/video).
        let hex: String = raw.iter().map(|byte| format!("{byte:02x}")).collect();
        let hex_b64 = BASE64.encode(hex.as_bytes());
        assert_eq!(parse_cdn_aes_key(&hex_b64).expect("hex encoding"), raw);
        // Everything else is rejected.
        assert!(parse_cdn_aes_key("not-base64!!!").is_err());
        assert!(parse_cdn_aes_key(&BASE64.encode([0u8; 8])).is_err());
        assert!(parse_cdn_aes_key(&BASE64.encode([0u8; 15])).is_err());
    }

    #[test]
    fn random_keys_are_well_formed() {
        let (key, hex) = random_key_hex();
        assert_eq!(hex.len(), 32);
        assert_eq!(
            hex,
            key.iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        );
        assert_ne!(random_key_hex().1, hex);
    }
}
