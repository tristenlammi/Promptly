# Promptly for iPhone

One app that shows your own Promptly server, with native code only where an
iPhone needs it. **Phase 1, the shell, is here. It is not installable yet**: an
iPhone app has to be signed with an Apple Developer account, and that is the
owner's step below.

## What's here

| Path | What it is |
|---|---|
| `project.yml` | The Xcode project as text. `xcodegen generate` makes `Promptly.xcodeproj` (never kept in git). |
| `Config/Deployment.xcconfig` | The values that differ per server and per Apple account. The defaults build unsigned for the simulator. |
| `Promptly/` | The app: first-run screen, pairing by QR code, the web view, "This iPhone". |
| `PromptlyCore/` | Plain logic with no Apple-only code, so its tests also run on Linux: reading a server address, the pairing link, where a link may go, the upload list. |
| `../.github/workflows/ios.yml` | Builds and tests on GitHub's Mac runners. There is no Mac here; that is the build machine. |

## What the shell does

- First run: type the server's address, or scan the pairing code from Files → Devices.
- Shows the server's web app, signed in once and kept signed in.
- Links to other sites open in a Safari sheet; `mailto:`, `tel:` and the like go to the phone.
- Downloads go to the share sheet (Save to Files, Save Image, AirDrop).
- Only the server's own pages may use the camera and microphone.
- Long-press the icon for Rooms, Mail, Calendar, Photos and "This iPhone".
- `promptly://open?path=/rooms` opens a page; in a signed build, so do ordinary links to the server.
- Pairing gives the phone its own sign-in (an app password, the same as the Android app), kept in the Keychain for photo backup and notifications later.

## Not in yet

Notifications, photo backup, the share sheet's "Save to Promptly", calls
ringing, widgets, Passwords AutoFill, single sign-on in a system sheet, and the
web app's offline cache inside the app.

## Running the tests without a Mac

```bash
docker run --rm -v "$PWD/PromptlyCore:/src:ro" swift:6.1-jammy bash -c "cp -r /src /work && cd /work && swift test"
```

## Owner steps, in order

1. **Enrol in the Apple Developer Program** as an Individual at
   developer.apple.com/programs (US$99 a year; Apple shows the local price when
   you enrol). It needs an Apple Account with two-factor sign-in. Approval can
   take a day or two.
2. **Register the app's id.** developer.apple.com → Certificates, IDs &
   Profiles → Identifiers → + → App IDs → App. Pick a bundle id such as
   `org.promptly.home.yourname`, and tick **Associated Domains** (Push
   Notifications and App Groups too; later phases need them).
3. **Create the app record.** appstoreconnect.apple.com → Apps → + → New App →
   iOS, that bundle id, and a name nobody else on the App Store uses (for
   example "Promptly Home").
4. **Create an API key for the build.** App Store Connect → Users and Access →
   Integrations → App Store Connect API → + → role **Admin**. Download the
   `.p8` file (once only) and note the **Key ID** and the **Issuer ID**.
5. **Give GitHub what it needs.** In the repository: Settings → Environments →
   New environment `ios-release`, limited to the `main` branch, with three
   secrets:
   - `ASC_KEY_P8`: the whole text of the `.p8` file
   - `ASC_KEY_ID`: the Key ID
   - `ASC_ISSUER_ID`: the Issuer ID

   Then Settings → Secrets and variables → Actions → Variables:
   - `IOS_TEAM_ID`: your 10-character Team ID (developer.apple.com → Membership)
   - `IOS_BUNDLE_ID`: the bundle id from step 2
   - `IOS_SERVER_HOST`: your server's name only, like `promptly.example.org`
6. **Run the build.** Actions → iPhone app → Run workflow → on `main`, tick
   "Sign and upload to TestFlight". A few minutes later the build shows in App
   Store Connect → TestFlight.
7. **Add the family.** App Store Connect → Users and Access → invite each person
   (any Apple Account) with a limited role and access to this app only, then
   TestFlight → Internal Testing → add them. They install Apple's TestFlight app
   and accept. No App Review is involved.

A TestFlight build stops working after 90 days, so the build has to be run
again before then.

The signing and upload job has never run: it can't until steps 1 to 5 are done.
Expect to fix things in it the first time.
