# iOS: design notes

Not built. These notes say what it would take and check that nothing here blocks it.

## What's already ready

- `CRYPTO_SPEC.md` and `frontend/src/passwords/core/vectors.json` are language-neutral. TypeScript, Kotlin and Rust already pass the same vectors, so a Swift client has a target to match.
- The API has no web-only assumptions. A device token and a vault session are all a client needs. The Android client proves that.
- A passkey's private key is stored portably inside the item, so a passkey made on another client works on iOS, and the reverse.
- The trust book, item counters and sync rules in `CRYPTO_SPEC.md` are the same for every client. A Swift client has to follow them all, or it can be fooled by a hostile server in the ways `hostile.test.ts` describes.

## What it would need

- **App:** SwiftUI, with the Secret Key and unlock secret in the Keychain, behind a Secure Enclave key with `biometryCurrentSet`, so a new fingerprint or face invalidates it.
- **Autofill:** an `ASCredentialProviderExtension`. It runs in its own process with tight memory limits (Argon2 at 64 MiB is close to them), so it should open from an unlock secret the main app left in the shared Keychain group, not stretch the password itself.
- **Passkeys:** the same extension, using the iOS 17+ passkey registration and assertion requests. Associated Domains aren't needed for a credential provider; they're for the sites.
- **One-time codes:** the extension can offer 2FA codes on iOS 18+.
- **Offline copy:** SQLite in the shared app group, holding ciphertext only.
- **Distribution:** an Apple Developer account, and TestFlight or the App Store. There's no sideload path like the APK.

## What's needed from the owner

- A Mac, or a cloud Mac, with Xcode. None of this can be built or tested from Windows.
- An Apple Developer account, and an iPhone for testing: the simulator doesn't run the autofill flow properly.

## The size of the job

Roughly as much as the Android client without its Android Auto and suite work. In this repo that's about 9,000 lines of Kotlin including tests. Crypto and sync are mechanical thanks to the vectors. Most of the risk is in the credential provider extension's memory limit and its lifecycle.
