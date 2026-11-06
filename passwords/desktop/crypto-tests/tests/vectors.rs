//! The shared vectors, not a fork: read straight from the TypeScript core's folder.
//! `every_section_is_tested` fails if a section appears that this file doesn't handle.
use base64::Engine;
use promptly_pw_crypto::*;
use serde_json::Value;

const VECTORS: &str = include_str!("../../../../frontend/src/passwords/core/vectors.json");
const WORDS: &str = include_str!("../../../../frontend/src/passwords/core/eff_large_wordlist.json");

fn v() -> Value {
    serde_json::from_str(VECTORS).unwrap()
}
fn hx(j: &Value) -> Vec<u8> {
    hex::decode(j.as_str().unwrap()).unwrap()
}
fn h32(j: &Value) -> [u8; 32] {
    hx(j).try_into().unwrap()
}
fn s(j: &Value) -> &str {
    j.as_str().unwrap()
}
fn kdf(j: &Value) -> Kdf<'_> {
    Kdf { alg: s(&j["alg"]), m: j["m"].as_u64().unwrap(), t: j["t"].as_u64().unwrap(), p: j["p"].as_u64().unwrap() }
}
fn arr(j: &Value) -> &Vec<Value> {
    j.as_array().unwrap()
}
fn words() -> Vec<String> {
    serde_json::from_str(WORDS).unwrap()
}

#[test]
fn every_section_is_tested() {
    let doc = v();
    let mut top: Vec<&str> = doc.as_object().unwrap().keys().map(String::as_str).collect();
    top.sort();
    assert_eq!(
        top,
        ["format", "item", "kat", "kdf_rejected", "keyset", "negative", "note", "padding", "root", "safety_words", "seal", "sealed_box", "secret_key", "secret_key_note", "signature"]
    );
    let mut kat: Vec<&str> = doc["kat"].as_object().unwrap().keys().map(String::as_str).collect();
    kat.sort();
    assert_eq!(kat, ["aes_gcm", "argon2id", "ed25519", "hkdf", "steam", "totp", "x25519"]);
    assert_eq!(doc["format"], 1);
}

#[test]
fn kat_hkdf() {
    let doc = v();
    let cases = arr(&doc["kat"]["hkdf"]);
    assert!(!cases.is_empty());
    for c in cases {
        let mut out = vec![0u8; c["length"].as_u64().unwrap() as usize];
        hkdf_expand(&hx(&c["ikm_hex"]), &hx(&c["salt_hex"]), &hx(&c["info_hex"]), &mut out);
        assert_eq!(out, hx(&c["okm_hex"]), "{}", c["source"]);
    }
}

#[test]
fn kat_aes_gcm() {
    let doc = v();
    let cases = arr(&doc["kat"]["aes_gcm"]);
    assert_eq!(cases.len(), 2);
    for c in cases {
        let key = h32(&c["key_hex"]);
        let nonce: [u8; 12] = hx(&c["nonce_hex"]).try_into().unwrap();
        let mut expect = hx(&c["ct_hex"]);
        expect.extend(hx(&c["tag_hex"]));
        let ct = gcm_encrypt(&key, &nonce, &hx(&c["plain_hex"]), &hx(&c["aad_hex"]));
        assert_eq!(ct, expect, "{}", c["source"]);
        assert_eq!(gcm_decrypt(&key, &nonce, &ct, &hx(&c["aad_hex"])).unwrap(), hx(&c["plain_hex"]));
    }
}

#[test]
fn kat_x25519() {
    let doc = v();
    for c in arr(&doc["kat"]["x25519"]) {
        let (a, b) = (h32(&c["alice_sk_hex"]), h32(&c["bob_sk_hex"]));
        assert_eq!(x25519_public(&a).to_vec(), hx(&c["alice_pub_hex"]));
        assert_eq!(x25519_public(&b).to_vec(), hx(&c["bob_pub_hex"]));
        assert_eq!(x25519_shared(&a, &h32(&c["bob_pub_hex"])).unwrap().to_vec(), hx(&c["shared_hex"]));
        assert_eq!(x25519_shared(&b, &h32(&c["alice_pub_hex"])).unwrap().to_vec(), hx(&c["shared_hex"]));
    }
    // Spec section 2: an all-zero shared secret is refused.
    assert_eq!(x25519_shared(&[7u8; 32], &[0u8; 32]), Err(Error::LowOrderKey));
}

#[test]
fn kat_ed25519() {
    let doc = v();
    for c in arr(&doc["kat"]["ed25519"]) {
        let seed = h32(&c["seed_hex"]);
        let msg = hx(&c["msg_hex"]);
        assert_eq!(ed25519_public(&seed).to_vec(), hx(&c["pub_hex"]));
        let sig = ed25519_sign(&seed, &msg);
        assert_eq!(sig.to_vec(), hx(&c["sig_hex"]));
        assert!(ed25519_verify(&h32(&c["pub_hex"]), &msg, &sig));
        let mut bad = sig;
        bad[0] ^= 1;
        assert!(!ed25519_verify(&h32(&c["pub_hex"]), &msg, &bad));
    }
}

#[test]
fn kat_totp() {
    let doc = v();
    let cases = arr(&doc["kat"]["totp"]);
    assert_eq!(cases.len(), 9);
    for c in cases {
        let code = totp(s(&c["algorithm"]), s(&c["secret_ascii"]).as_bytes(), c["digits"].as_u64().unwrap() as u32, c["period"].as_u64().unwrap(), c["time"].as_u64().unwrap());
        assert_eq!(code, s(&c["code"]));
    }
}

#[test]
fn kat_steam() {
    let doc = v();
    for c in arr(&doc["kat"]["steam"]) {
        let key = base64::engine::general_purpose::STANDARD.decode(s(&c["secret_base64"])).unwrap();
        assert_eq!(steam_code(&key, c["time"].as_u64().unwrap()), s(&c["code"]));
    }
}

#[test]
fn kat_argon2id() {
    let doc = v();
    for c in arr(&doc["kat"]["argon2id"]) {
        let out = argon2id(&hx(&c["password_hex"]), &hx(&c["salt_hex"]), &kdf(&c["kdf"])).unwrap();
        assert_eq!(out.to_vec(), hx(&c["output_hex"]));
    }
}

#[test]
fn secret_key_text_form() {
    let doc = v();
    let cases = arr(&doc["secret_key"]);
    assert_eq!(cases.len(), 4);
    for c in cases {
        let raw: [u8; 16] = hx(&c["raw_hex"]).try_into().unwrap();
        let text = s(&c["encoded"]);
        assert_eq!(encode_secret_key(&raw), text);
        assert_eq!(parse_secret_key(text).unwrap(), raw);
        // Forgiving about case, spaces, dashes.
        assert_eq!(parse_secret_key(&text.to_lowercase().replace('-', " ")).unwrap(), raw);
    }
    // Look-alikes read as digits, and a typo says so.
    assert_eq!(parse_secret_key("PWK1-OOOG4OR-4OM3OE2-O9185GR-38E1W7B").unwrap().to_vec(), hex::decode("000102030405060708090a0b0c0d0e0f").unwrap());
    assert!(parse_secret_key("PWK1-000G40R-40M30E2-09185GR-38E1W7C").is_err());
    assert!(parse_secret_key("PWK1-000G40R").is_err());
}

#[test]
fn padding_buckets() {
    let doc = v();
    let cases = arr(&doc["padding"]);
    assert_eq!(cases.len(), 12);
    for c in cases {
        let len = c["len"].as_u64().unwrap() as usize;
        let data = vec![0x5a; len];
        let padded = pad(&data).unwrap();
        assert_eq!(padded.len() as u64, c["padded"].as_u64().unwrap(), "len {len}");
        assert_eq!(unpad(&padded).unwrap(), data);
    }
    // unpad refuses non-zero padding and a length that doesn't fit.
    let mut p = pad(b"abc").unwrap();
    let last = p.len() - 1;
    p[last] = 1;
    assert!(unpad(&p).is_err());
    let mut p = pad(b"abc").unwrap();
    p[..4].copy_from_slice(&u32::MAX.to_be_bytes());
    assert!(unpad(&p).is_err());
    assert!(unpad(&[0, 0]).is_err());
}

#[test]
fn root_keys() {
    let doc = v();
    let cases = arr(&doc["root"]);
    assert_eq!(cases.len(), 4);
    for c in cases {
        let sk: [u8; 16] = hx(&c["secret_key_hex"]).try_into().unwrap();
        let r = derive_root(s(&c["password"]), &sk, &hx(&c["salt_hex"]), &kdf(&c["kdf"])).unwrap();
        assert_eq!(r.unlock.to_vec(), hx(&c["unlock_hex"]), "{}", c["password"]);
        assert_eq!(r.auth.to_vec(), hx(&c["auth_hex"]), "{}", c["password"]);
    }
}

#[test]
fn seal_blobs() {
    let doc = v();
    let cases = arr(&doc["seal"]);
    assert_eq!(cases.len(), 4);
    for c in cases {
        let ad = aad(s(&c["scope"]), s(&c["item"]), s(&c["field"])).unwrap();
        assert_eq!(ad, hx(&c["aad_hex"]));
        let key = h32(&c["key_hex"]);
        let nonce: [u8; 12] = hx(&c["nonce_hex"]).try_into().unwrap();
        let blob = seal_with_nonce(&key, &nonce, &hx(&c["plain_hex"]), &ad);
        assert_eq!(blob, hx(&c["blob_hex"]));
        assert_eq!(open(&key, &blob, &ad).unwrap(), hx(&c["plain_hex"]));
    }
}

#[test]
fn sealed_boxes() {
    let doc = v();
    for c in arr(&doc["sealed_box"]) {
        let ad = aad(s(&c["scope"]), s(&c["item"]), s(&c["field"])).unwrap();
        let recipient = h32(&c["recipient_sk_hex"]);
        assert_eq!(x25519_public(&recipient).to_vec(), hx(&c["recipient_pub_hex"]));
        let nonce: [u8; 12] = hx(&c["nonce_hex"]).try_into().unwrap();
        let blob = sealed_to_with(&h32(&c["eph_sk_hex"]), &nonce, &h32(&c["recipient_pub_hex"]), &hx(&c["plain_hex"]), &ad).unwrap();
        assert_eq!(blob, hx(&c["blob_hex"]));
        assert_eq!(open_sealed(&recipient, &blob, &ad).unwrap(), hx(&c["plain_hex"]));
        // The wrong member, or a blob with its alg changed, must not open.
        assert!(open_sealed(&[9u8; 32], &blob, &ad).is_err());
        let mut b = blob.clone();
        b[1] = ALG_AES_GCM;
        assert!(open_sealed(&recipient, &b, &ad).is_err());
    }
}

#[test]
fn signatures() {
    let doc = v();
    for c in arr(&doc["signature"]) {
        let owned: Vec<Vec<u8>> = arr(&c["fields"])
            .iter()
            .map(|f| match f.as_str() {
                Some(text) => text.as_bytes().to_vec(),
                None => hx(&f["hex"]),
            })
            .collect();
        let refs: Vec<&[u8]> = owned.iter().map(Vec::as_slice).collect();
        let input = signing_input(s(&c["purpose"]), &refs).unwrap();
        assert_eq!(input, hx(&c["input_hex"]));
        let seed = h32(&c["seed_hex"]);
        assert_eq!(ed25519_public(&seed).to_vec(), hx(&c["pub_hex"]));
        let sig = ed25519_sign(&seed, &input);
        assert_eq!(sig.to_vec(), hx(&c["sig_hex"]));
        assert!(ed25519_verify(&h32(&c["pub_hex"]), &input, &sig));
    }
}

#[test]
fn keyset() {
    let doc = v();
    let k = decode_keyset(&hx(&doc["keyset"]["encoded_hex"])).unwrap();
    assert_eq!(x25519_public(&k.x25519).to_vec(), hx(&doc["keyset"]["x25519_pub_hex"]));
    assert_eq!(ed25519_public(&k.ed25519).to_vec(), hx(&doc["keyset"]["ed25519_pub_hex"]));
    assert!(decode_keyset(&[1u8; 64]).is_err());
    let mut wrong_version = hx(&doc["keyset"]["encoded_hex"]);
    wrong_version[0] = 2;
    assert!(decode_keyset(&wrong_version).is_err());
}

#[test]
fn item_blobs() {
    let doc = v();
    for c in arr(&doc["item"]) {
        let plain = decrypt_item(&h32(&c["vault_key_hex"]), s(&c["vault_id"]), s(&c["item_id"]), &hx(&c["blob_hex"])).unwrap();
        let body: Value = serde_json::from_slice(&plain).unwrap();
        assert_eq!(body, c["body"]);
        // Moved to another item or vault, it must not open.
        assert!(decrypt_item(&h32(&c["vault_key_hex"]), s(&c["vault_id"]), "55555555-5555-4555-8555-555555555555", &hx(&c["blob_hex"])).is_err());
        assert!(decrypt_item(&h32(&c["vault_key_hex"]), "55555555-5555-4555-8555-555555555555", s(&c["item_id"]), &hx(&c["blob_hex"])).is_err());
    }
}

#[test]
fn safety_words() {
    let doc = v();
    let list = words();
    assert_eq!(list.len(), 7776);
    let cases = arr(&doc["safety_words"]);
    assert_eq!(cases.len(), 2);
    for c in cases {
        let got = match s(&c["kind"]) {
            "device" => device_words(&hx(&c["new_device_pub_hex"]), &hx(&c["approver_pub_hex"]), &list).unwrap(),
            "identity" => identity_words(s(&c["user_id"]), &hx(&c["x25519_pub_hex"]), &hx(&c["ed25519_pub_hex"]), &list).unwrap(),
            other => panic!("unknown kind {other}"),
        };
        let want: Vec<String> = arr(&c["words"]).iter().map(|w| s(w).to_string()).collect();
        assert_eq!(got, want);
    }
}

#[test]
fn negative_cases_all_fail() {
    let doc = v();
    let cases = arr(&doc["negative"]);
    assert_eq!(cases.len(), 11);
    for c in cases {
        let ad = aad(s(&c["scope"]), s(&c["item"]), s(&c["field"])).unwrap();
        assert!(open(&h32(&c["key_hex"]), &hx(&c["blob_hex"]), &ad).is_err(), "{}", c["why"]);
    }
}

#[test]
fn kdf_limits() {
    let doc = v();
    let cases = arr(&doc["kdf_rejected"]);
    assert_eq!(cases.len(), 7);
    for c in cases {
        assert_eq!(check_kdf(&kdf(c)), Err(Error::Kdf), "{c}");
        assert!(derive_root("x", &[0u8; 16], &[0u8; 16], &kdf(c)).is_err(), "{c}");
    }
    assert!(check_kdf(&Kdf { alg: "argon2id", m: 65536, t: 3, p: 1 }).is_ok());
    assert!(check_kdf(&Kdf { alg: "argon2id", m: 4_194_304, t: 32, p: 8 }).is_ok());
    assert!(derive_root("x", &[0u8; 16], &[0u8; 15], &Kdf { alg: "argon2id", m: 65536, t: 3, p: 1 }).is_err());
}

#[test]
fn format_encode_decode_property() {
    // A small deterministic walk over sizes and bytes: seal then open returns the input,
    // and flipping any one byte of a blob stops it opening.
    let key = [0x42u8; 32];
    let ad = aad("scope", "item", "field").unwrap();
    let mut state = 0x9e3779b97f4a7c15u64;
    let mut next = move || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        state
    };
    for len in [0usize, 1, 2, 15, 16, 17, 255, 256, 1000, 4096] {
        let plain: Vec<u8> = (0..len).map(|_| next() as u8).collect();
        let nonce: [u8; 12] = std::array::from_fn(|_| next() as u8);
        let blob = seal_with_nonce(&key, &nonce, &plain, &ad);
        assert_eq!(open(&key, &blob, &ad).unwrap(), plain);
        for _ in 0..16 {
            let mut bad = blob.clone();
            let at = next() as usize % bad.len();
            bad[at] ^= 1 << (next() % 8);
            assert!(open(&key, &bad, &ad).is_err());
        }
        let padded = pad(&plain).unwrap();
        assert_eq!(unpad(&padded).unwrap(), plain);
    }
}

#[test]
fn lp_refuses_rather_than_truncates() {
    assert_eq!(lp(&vec![0u8; 65536]), Err(Error::TooLong));
    assert_eq!(lp(&vec![0u8; 65535]).unwrap().len(), 65537);
}
