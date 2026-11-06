//! DPAPI wrapping, bound to the Windows user. Any process running as this user can unwrap
//! it, so this protects a copied file and another user account, not same-user malware.
//! SECURITY.md says so. The prompt-struct flow is deprecated and is never used.
use std::ptr::null_mut;

use windows::core::PCWSTR;
use windows::Win32::Foundation::{LocalFree, HLOCAL};
use windows::Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB};
use zeroize::Zeroizing;

fn blob(data: &[u8]) -> CRYPT_INTEGER_BLOB {
    CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 }
}

/// Copies out of the buffer DPAPI allocated, then frees it. The caller says when the
/// contents are secret, and then the copy is wiped on drop.
fn take(out: CRYPT_INTEGER_BLOB, wipe: bool) -> Vec<u8> {
    // SAFETY: DPAPI gave us this buffer and length, and it's freed exactly once here.
    unsafe {
        let v = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
        if wipe {
            std::ptr::write_bytes(out.pbData, 0, out.cbData as usize);
        }
        let _ = LocalFree(Some(HLOCAL(out.pbData as *mut _)));
        v
    }
}

pub fn protect(plain: &[u8], purpose: &str) -> Result<Vec<u8>, String> {
    let entropy = purpose.as_bytes();
    let (input, ent) = (blob(plain), blob(entropy));
    let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: null_mut() };
    // SAFETY: all blobs outlive the call, and out is filled by DPAPI.
    unsafe { CryptProtectData(&input, PCWSTR::null(), Some(&ent), None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out) }.map_err(|e| e.to_string())?;
    Ok(take(out, false))
}

pub fn unprotect(wrapped: &[u8], purpose: &str) -> Result<Zeroizing<Vec<u8>>, String> {
    let entropy = purpose.as_bytes();
    let (input, ent) = (blob(wrapped), blob(entropy));
    let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: null_mut() };
    // SAFETY: as above.
    unsafe { CryptUnprotectData(&input, None, Some(&ent), None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out) }.map_err(|e| e.to_string())?;
    Ok(Zeroizing::new(take(out, true)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn real_dpapi_round_trip() {
        let wrapped = protect(b"not a real secret", "test/purpose").unwrap();
        assert!(!wrapped.windows(8).any(|w| w == b"not a re"), "the plaintext isn't in the blob");
        assert_eq!(&**unprotect(&wrapped, "test/purpose").unwrap(), b"not a real secret");
    }

    #[test]
    fn wrong_purpose_or_tampered_blob_fails() {
        let wrapped = protect(b"x", "one").unwrap();
        assert!(unprotect(&wrapped, "two").is_err());
        let mut bad = wrapped.clone();
        let mid = bad.len() / 2;
        bad[mid] ^= 1;
        assert!(unprotect(&bad, "one").is_err());
    }
}
