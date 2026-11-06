//! CRYPTO_SPEC.md format 1, in Rust. No home-made primitives: everything here is the
//! byte layout around RustCrypto and dalek calls.
use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use sha1::Sha1;
use sha2::{Digest, Sha256, Sha512};
use unicode_normalization::UnicodeNormalization;
use x25519_dalek::{PublicKey, StaticSecret};

pub const FORMAT_VERSION: u8 = 1;
pub const ALG_AES_GCM: u8 = 1;
pub const ALG_SEALED: u8 = 2;
const NONCE: usize = 12;
const TAG: usize = 16;

#[derive(Debug, PartialEq, Eq)]
pub enum Error {
    Format(&'static str),
    Decrypt,
    Kdf,
    LowOrderKey,
    TooLong,
}

pub type Result<T> = std::result::Result<T, Error>;

/// `lp(x)`: u16 big-endian length then the bytes. Over 65535 is an error, never truncated.
pub fn lp(x: &[u8]) -> Result<Vec<u8>> {
    let len: u16 = x.len().try_into().map_err(|_| Error::TooLong)?;
    let mut out = len.to_be_bytes().to_vec();
    out.extend_from_slice(x);
    Ok(out)
}

pub fn aad(scope: &str, item: &str, field: &str) -> Result<Vec<u8>> {
    let mut out = vec![0x50, 0x57, 0x41, 0x44, FORMAT_VERSION];
    out.extend(lp(scope.as_bytes())?);
    out.extend(lp(item.as_bytes())?);
    out.extend(lp(field.as_bytes())?);
    Ok(out)
}

pub fn gcm_encrypt(key: &[u8; 32], nonce: &[u8; 12], plain: &[u8], ad: &[u8]) -> Vec<u8> {
    let cipher = Aes256Gcm::new(&Key::<Aes256Gcm>::from(*key));
    cipher
        .encrypt(&Nonce::from(*nonce), Payload { msg: plain, aad: ad })
        .expect("AES-GCM encrypt only fails on absurd lengths")
}

pub fn gcm_decrypt(key: &[u8; 32], nonce: &[u8], ct: &[u8], ad: &[u8]) -> Result<Vec<u8>> {
    let nonce: [u8; NONCE] = nonce.try_into().map_err(|_| Error::Format("nonce length"))?;
    let cipher = Aes256Gcm::new(&Key::<Aes256Gcm>::from(*key));
    cipher
        .decrypt(&Nonce::from(nonce), Payload { msg: ct, aad: ad })
        .map_err(|_| Error::Decrypt)
}

/// `symmetric` blob: version, alg, nonce, ciphertext and tag.
pub fn seal_with_nonce(key: &[u8; 32], nonce: &[u8; 12], plain: &[u8], ad: &[u8]) -> Vec<u8> {
    let mut out = vec![FORMAT_VERSION, ALG_AES_GCM];
    out.extend_from_slice(nonce);
    out.extend(gcm_encrypt(key, nonce, plain, ad));
    out
}

pub fn open(key: &[u8; 32], blob: &[u8], ad: &[u8]) -> Result<Vec<u8>> {
    if blob.len() < 2 + NONCE + TAG {
        return Err(Error::Format("blob too short"));
    }
    if blob[0] != FORMAT_VERSION {
        return Err(Error::Format("unknown format version"));
    }
    if blob[1] != ALG_AES_GCM {
        return Err(Error::Format("unknown algorithm"));
    }
    gcm_decrypt(key, &blob[2..2 + NONCE], &blob[2 + NONCE..], ad)
}

pub fn hkdf32(ikm: &[u8], salt: &[u8], info: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    hkdf_expand(ikm, salt, info.as_bytes(), &mut out);
    out
}

pub fn hkdf_expand(ikm: &[u8], salt: &[u8], info: &[u8], out: &mut [u8]) {
    Hkdf::<Sha256>::new(Some(salt), ikm)
        .expand(info, out)
        .expect("HKDF output length is within range");
}

pub fn x25519_public(sk: &[u8; 32]) -> [u8; 32] {
    PublicKey::from(&StaticSecret::from(*sk)).to_bytes()
}

/// Refuses an all-zero shared secret (spec section 2): a low-order public key.
pub fn x25519_shared(sk: &[u8; 32], pubkey: &[u8; 32]) -> Result<[u8; 32]> {
    let shared = StaticSecret::from(*sk).diffie_hellman(&PublicKey::from(*pubkey));
    if !shared.was_contributory() {
        return Err(Error::LowOrderKey);
    }
    Ok(shared.to_bytes())
}

const SEAL_INFO: &str = "promptly-pw/v1/seal";

fn seal_key(shared: &[u8; 32], eph_pub: &[u8], recipient_pub: &[u8; 32]) -> [u8; 32] {
    let mut salt = eph_pub.to_vec();
    salt.extend_from_slice(recipient_pub);
    hkdf32(shared, &salt, SEAL_INFO)
}

pub fn sealed_to_with(eph_sk: &[u8; 32], nonce: &[u8; 12], recipient_pub: &[u8; 32], plain: &[u8], ad: &[u8]) -> Result<Vec<u8>> {
    let eph_pub = x25519_public(eph_sk);
    let key = seal_key(&x25519_shared(eph_sk, recipient_pub)?, &eph_pub, recipient_pub);
    let mut out = vec![FORMAT_VERSION, ALG_SEALED];
    out.extend_from_slice(&eph_pub);
    out.extend_from_slice(nonce);
    out.extend(gcm_encrypt(&key, nonce, plain, ad));
    Ok(out)
}

pub fn open_sealed(sk: &[u8; 32], blob: &[u8], ad: &[u8]) -> Result<Vec<u8>> {
    if blob.len() < 2 + 32 + NONCE + TAG {
        return Err(Error::Format("blob too short"));
    }
    if blob[0] != FORMAT_VERSION {
        return Err(Error::Format("unknown format version"));
    }
    if blob[1] != ALG_SEALED {
        return Err(Error::Format("unknown algorithm"));
    }
    let eph: [u8; 32] = blob[2..34].try_into().expect("checked length");
    let key = seal_key(&x25519_shared(sk, &eph)?, &eph, &x25519_public(sk));
    gcm_decrypt(&key, &blob[34..34 + NONCE], &blob[34 + NONCE..], ad)
}

const MIN_BUCKET: usize = 256;
const LINEAR_FROM: usize = 1 << 20;
const LINEAR_STEP: usize = 1 << 18;

pub fn bucket_for(payload: usize) -> usize {
    let need = payload + 4;
    if need > LINEAR_FROM {
        return need.div_ceil(LINEAR_STEP) * LINEAR_STEP;
    }
    let mut size = MIN_BUCKET;
    while size < need {
        size *= 2;
    }
    size
}

pub fn pad(data: &[u8]) -> Result<Vec<u8>> {
    let len: u32 = data.len().try_into().map_err(|_| Error::TooLong)?;
    let mut out = vec![0u8; bucket_for(data.len())];
    out[..4].copy_from_slice(&len.to_be_bytes());
    out[4..4 + data.len()].copy_from_slice(data);
    Ok(out)
}

pub fn unpad(padded: &[u8]) -> Result<Vec<u8>> {
    if padded.len() < 4 {
        return Err(Error::Format("bad padding"));
    }
    let n = u32::from_be_bytes(padded[..4].try_into().expect("checked length")) as usize;
    if n > padded.len() - 4 {
        return Err(Error::Format("bad padding"));
    }
    if padded[4 + n..].iter().any(|b| *b != 0) {
        return Err(Error::Format("bad padding"));
    }
    Ok(padded[4..4 + n].to_vec())
}

pub fn signing_input(purpose: &str, fields: &[&[u8]]) -> Result<Vec<u8>> {
    let mut out = b"promptly-pw/v1/sig\0".to_vec();
    out.extend(lp(purpose.as_bytes())?);
    for f in fields {
        out.extend(lp(f)?);
    }
    Ok(out)
}

pub fn ed25519_public(seed: &[u8; 32]) -> [u8; 32] {
    SigningKey::from_bytes(seed).verifying_key().to_bytes()
}

pub fn ed25519_sign(seed: &[u8; 32], msg: &[u8]) -> [u8; 64] {
    SigningKey::from_bytes(seed).sign(msg).to_bytes()
}

pub fn ed25519_verify(pubkey: &[u8; 32], msg: &[u8], sig: &[u8; 64]) -> bool {
    VerifyingKey::from_bytes(pubkey)
        .map(|k| k.verify(msg, &Signature::from_bytes(sig)).is_ok())
        .unwrap_or(false)
}

// ---- KDF ----

#[derive(Clone, Copy, Debug)]
pub struct Kdf<'a> {
    pub alg: &'a str,
    pub m: u64,
    pub t: u64,
    pub p: u64,
}

/// Both limits in CRYPTO_SPEC.md section 2: a hostile server can neither weaken nor hang.
pub fn check_kdf(k: &Kdf) -> Result<()> {
    let ok = k.alg == "argon2id"
        && (65536..=4_194_304).contains(&k.m)
        && (3..=32).contains(&k.t)
        && (1..=8).contains(&k.p);
    if ok {
        Ok(())
    } else {
        Err(Error::Kdf)
    }
}

pub fn argon2id(password: &[u8], salt: &[u8], k: &Kdf) -> Result<[u8; 32]> {
    check_kdf(k)?;
    let params = Params::new(k.m as u32, k.t as u32, k.p as u32, Some(32)).map_err(|_| Error::Kdf)?;
    let mut out = [0u8; 32];
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(password, salt, &mut out)
        .map_err(|_| Error::Kdf)?;
    Ok(out)
}

pub fn normalize_password(password: &str) -> Vec<u8> {
    password.nfkc().collect::<String>().into_bytes()
}

pub struct RootKeys {
    pub unlock: [u8; 32],
    pub auth: [u8; 32],
}

pub fn derive_root(password: &str, secret_key: &[u8; 16], salt: &[u8], k: &Kdf) -> Result<RootKeys> {
    if salt.len() != 16 {
        return Err(Error::Format("KDF salt must be 16 bytes"));
    }
    let stretched = argon2id(&normalize_password(password), salt, k)?;
    let mut ikm = stretched.to_vec();
    ikm.extend_from_slice(secret_key);
    let root = hkdf32(&ikm, &[], "promptly-pw/v1/root");
    Ok(RootKeys { unlock: hkdf32(&root, &[], "promptly-pw/v1/unlock"), auth: hkdf32(&root, &[], "promptly-pw/v1/auth") })
}

// ---- Secret Key text form ----

const CROCKFORD: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

fn secret_key_check(raw: &[u8; 16]) -> [u8; 2] {
    let mut h = Sha256::new();
    h.update(b"promptly-pw/v1/sk");
    h.update(raw);
    let d = h.finalize();
    let ten = ((d[0] as usize) << 2) | ((d[1] as usize) >> 6);
    [CROCKFORD[ten >> 5], CROCKFORD[ten & 31]]
}

pub fn encode_secret_key(raw: &[u8; 16]) -> String {
    let mut body = Vec::with_capacity(28);
    let (mut value, mut bits) = (0u32, 0u32);
    for byte in raw {
        value = (value << 8) | *byte as u32;
        bits += 8;
        while bits >= 5 {
            body.push(CROCKFORD[((value >> (bits - 5)) & 31) as usize]);
            bits -= 5;
        }
        value &= (1 << bits) - 1;
    }
    if bits > 0 {
        body.push(CROCKFORD[((value << (5 - bits)) & 31) as usize]);
    }
    body.extend_from_slice(&secret_key_check(raw));
    let s = String::from_utf8(body).expect("Crockford characters are ASCII");
    format!("PWK1-{}-{}-{}-{}", &s[..7], &s[7..14], &s[14..21], &s[21..28])
}

pub fn parse_secret_key(text: &str) -> Result<[u8; 16]> {
    let mut s: String = text.to_uppercase().chars().filter(|c| !c.is_whitespace() && *c != '-').collect();
    if let Some(rest) = s.strip_prefix("PWK1") {
        s = rest.to_string();
    }
    let s = s.replace('O', "0").replace(['I', 'L'], "1");
    if s.len() != 28 {
        return Err(Error::Format("wrong length"));
    }
    let mut raw = [0u8; 16];
    let (mut value, mut bits, mut at) = (0u32, 0u32, 0usize);
    for c in s[..26].bytes() {
        let v = CROCKFORD.iter().position(|x| *x == c).ok_or(Error::Format("bad character"))? as u32;
        value = (value << 5) | v;
        bits += 5;
        if bits >= 8 {
            raw[at] = ((value >> (bits - 8)) & 255) as u8;
            at += 1;
            bits -= 8;
        }
        value &= (1 << bits) - 1;
    }
    if secret_key_check(&raw) != s.as_bytes()[26..] {
        return Err(Error::Format("wrong check"));
    }
    Ok(raw)
}

// ---- Keyset and item blob ----

pub struct Keyset {
    pub x25519: [u8; 32],
    pub ed25519: [u8; 32],
}

pub fn decode_keyset(b: &[u8]) -> Result<Keyset> {
    if b.len() != 65 || b[0] != 1 {
        return Err(Error::Format("bad keyset"));
    }
    Ok(Keyset { x25519: b[1..33].try_into().expect("checked"), ed25519: b[33..65].try_into().expect("checked") })
}

/// `0x01 || lp(wrapped_item_key) || body_blob`, down to the body's JSON bytes.
pub fn decrypt_item(vault_key: &[u8; 32], vault_id: &str, item_id: &str, blob: &[u8]) -> Result<Vec<u8>> {
    if blob.len() < 3 || blob[0] != 1 {
        return Err(Error::Format("bad item blob"));
    }
    let n = u16::from_be_bytes([blob[1], blob[2]]) as usize;
    if blob.len() < 3 + n {
        return Err(Error::Format("bad item blob"));
    }
    let item_key: [u8; 32] = open(vault_key, &blob[3..3 + n], &aad(vault_id, item_id, "item_key")?)?
        .try_into()
        .map_err(|_| Error::Format("bad item key"))?;
    unpad(&open(&item_key, &blob[3 + n..], &aad(vault_id, item_id, "body")?)?)
}

// ---- Safety words ----

pub fn words_from_hash(digest: &[u8], count: usize, list: &[String]) -> Vec<String> {
    (0..count)
        .map(|i| {
            let n = u16::from_be_bytes([digest[i * 2], digest[i * 2 + 1]]) as usize;
            list[n % list.len()].clone()
        })
        .collect()
}

pub fn device_words(new_device_pub: &[u8], approver_pub: &[u8], list: &[String]) -> Result<Vec<String>> {
    let mut h = Sha256::new();
    h.update(b"promptly-pw/v1/device-words\0");
    h.update(lp(new_device_pub)?);
    h.update(lp(approver_pub)?);
    Ok(words_from_hash(&h.finalize(), 5, list))
}

pub fn identity_words(user_id: &str, x: &[u8], ed: &[u8], list: &[String]) -> Result<Vec<String>> {
    let mut h = Sha256::new();
    h.update(b"promptly-pw/v1/identity-words\0");
    h.update(lp(user_id.as_bytes())?);
    h.update(lp(x)?);
    h.update(lp(ed)?);
    Ok(words_from_hash(&h.finalize(), 6, list))
}

// ---- TOTP, RFC 6238, and Steam Guard ----

fn hmac_of<M: Mac + hmac::KeyInit>(key: &[u8], msg: &[u8]) -> Vec<u8> {
    let mut m = <M as hmac::KeyInit>::new_from_slice(key).expect("HMAC takes any key length");
    m.update(msg);
    m.finalize().into_bytes().to_vec()
}

fn truncate(mac: &[u8]) -> u32 {
    let at = (mac[mac.len() - 1] & 15) as usize;
    u32::from_be_bytes(mac[at..at + 4].try_into().expect("in range")) & 0x7fff_ffff
}

pub fn totp(alg: &str, key: &[u8], digits: u32, period: u64, time: u64) -> String {
    let counter = (time / period).to_be_bytes();
    let mac = match alg {
        "SHA256" => hmac_of::<Hmac<Sha256>>(key, &counter),
        "SHA512" => hmac_of::<Hmac<Sha512>>(key, &counter),
        _ => hmac_of::<Hmac<Sha1>>(key, &counter),
    };
    format!("{:0width$}", truncate(&mac) % 10u32.pow(digits), width = digits as usize)
}

pub fn steam_code(key: &[u8], time: u64) -> String {
    const STEAM: &[u8] = b"23456789BCDFGHJKMNPQRTVWXY";
    let mut n = truncate(&hmac_of::<Hmac<Sha1>>(key, &(time / 30).to_be_bytes())) as usize;
    let mut out = String::new();
    for _ in 0..5 {
        out.push(STEAM[n % STEAM.len()] as char);
        n /= STEAM.len();
    }
    out
}
