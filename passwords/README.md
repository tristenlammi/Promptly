# Promptly Passwords

End-to-end encrypted password manager in Promptly: web vault at `/passwords`, browser extension, Android (in the Promptly app) and a Windows app. The server only ever holds ciphertext.

**This is a preview.** It's had automated tests and AI-assisted reviews, not an independent human security audit. See `REPORT.md` for what was and wasn't tested.

| Read this | For |
|---|---|
| `USER_GUIDE.md` | Using it |
| `OWNER_STEPS.md` | What the person running the server still has to do |
| `REPORT.md` | What's built, what's tested, what isn't |
| `SECURITY.md` | What it protects against, and what it doesn't |
| `CRYPTO_SPEC.md` | The exact formats |
| `DECISIONS.md` | Why things are the way they are |
| `IOS_NOTES.md` | iOS, which is design only |

## Where things are

- `frontend/src/passwords/core/`: the client: crypto, sync, autofill. Shared by web, extension and Windows.
- `frontend/src/passwords/ui/`: the screens.
- `backend/app/passwords/`: the API. Opaque blobs only.
- `passwords/extension/`, `passwords/desktop/`, `android/app/.../passwords/`: the clients.
- `passwords/stack/`: an isolated test stack on port 8092.

## Serving the vault from its own hostname

The vault page has a stricter security policy than the rest of Promptly, but it shares an origin with the main app, so script running in a main-app tab can do some things to it (`SECURITY.md` says what). If you want that gone, serve the vault from its own name.

1. Point something like `vault.example.org` at the same nginx.
2. Add a `server` block for that name which serves `passwords.html` and its assets, and proxies only `/api/passwords/` and `/api/auth/refresh`.
3. Add the origin to the allowed CORS origins in Admin.
4. People then sign in to Promptly on that name as well, since the refresh cookie is per host.

This hasn't been tested. It's an option, and the default same-origin setup is what the test suites cover.

## Running the tests

```bash
bash passwords/stack/up.sh
```

```bash
bash passwords/stack/pytest.sh tests/test_passwords.py tests/test_passwords_share.py tests/test_passwords_connections.py tests/test_passwords_extras.py -q
```

```bash
cd frontend && npx vitest run src/passwords/core
```

```bash
cd frontend && PW_STACK_URL=http://localhost:8092 npx vitest run src/passwords/core/integration.test.ts
```

```bash
cd e2e && npx playwright test --config passwords.config.ts --project=chromium --project=webkit
```

```bash
cd e2e && npx playwright test --config passwords-ext.config.ts
```

```bash
cd e2e && node --test passwords-firefox/vault.test.mjs passwords-firefox/extension.test.mjs
```

```bash
cd e2e && node ../passwords/tests/corpus-chromium.mjs
```

The Android suite is `android\run-passwords-tests.ps1`, and the Windows suite is in `passwords/desktop/README.md`.
