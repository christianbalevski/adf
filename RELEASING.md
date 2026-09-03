# Releasing ADF Studio

The version lives in `package.json`. **Never hand-edit it** — `npm version`
bumps it, makes the commit, and creates the matching `vX.Y.Z` git tag in one
atomic step. A `postversion` hook then pushes the commit + tag for you, and
pushing the tag triggers CI to build and publish all platforms.

## The whole release — one command

From a clean `main` (all feature/fix work already merged):

```bash
npm version patch        # 0.1.1 -> 0.1.2  (commit "0.1.2" + tag v0.1.2)
                         # postversion hook auto-runs: git push --follow-tags
```

- `patch` = bug fixes (0.1.1 → 0.1.2)
- `minor` = backward-compatible features (0.1.1 → 0.2.0)
- `major` = breaking changes (0.1.1 → 1.0.0)

That's it. Pushing the tag triggers `.github/workflows/release.yml`:

1. **build** (matrix, **blocking**) — the three critical platforms each run
   `npm run release`, uploading to a single **draft** GitHub Release:
   - `macos-14` → `…-arm64.dmg` (Apple Silicon) **and** `…-universal.dmg`
     (runs on Apple Silicon and Intel — the download for Intel users)
   - `windows-2022` → `…-Setup-….exe`
   - `ubuntu-latest` → `….deb` + `….AppImage`
2. **publish** — as soon as all three builds succeed, generates release notes
   from every commit since the previous version tag
   (`scripts/release-notes.mjs`, grouped by conventional-commit prefix), sets
   them as the release body, and flips the draft to published. Live at
   `https://github.com/christianbalevski/adf/releases/latest`.

**Why a universal dmg instead of an Intel one:** the old separate Intel job
needed `macos-13` (GitHub's last Intel image), which routinely sat queued 30+
minutes or never got a runner, so it never actually shipped. Instead the
`macos-14` (arm64) runner builds with `--arm64 --universal`: the arm64-only
dmg stays as-is, and for the universal dmg electron-builder packs the app once
per arch — rebuilding `better-sqlite3` for each, which the Xcode toolchain
cross-compiles fine — and lipo-merges the two. Deps that ship prebuilt
single-arch binaries (`sqlite-vec`, `esbuild`, `@lydell/node-pty`) pick their
binary at runtime via `process.arch`, so CI force-installs their Intel
variants first (`scripts/install-mac-x64-deps.mjs`) and `x64ArchFiles` in
`electron-builder.yml` exempts them from the universal-merge arch check.

If any platform's build fails, the `publish` job is skipped and the release
stays an unpublished draft — users never see a release missing a platform. Fix
the cause and re-push the tag (`git push --delete origin vX.Y.Z` then re-tag),
or just cut the next patch.

`npm version` refuses to run on a dirty working tree — that's intentional. A
release is a clean, deliberate point.

> Version bumps are **not** per-commit. Normal work commits stay unversioned;
> you only run `npm version` when you actually cut a build.

## Watching / re-running a release

```bash
gh run watch                              # follow the in-progress release run
gh run list --workflow=release.yml        # history
gh run rerun <run-id>                     # retry after a flaky failure
```

The draft (or published release) is visible the whole time on the repo's
**Releases** page.

## Building locally (testing only)

You normally never do this — CI owns real releases. To smoke-test a packaged
build on your machine:

```bash
npm run package                           # builds into dist/, does NOT publish
```

To test the publish path itself, `GH_TOKEN=$(gh auth token) npm run release`
uploads to a draft from your machine — but it only attaches *your* OS's
installer, so let CI produce real multi-platform releases.

## Code signing

**macOS** builds are signed with a Developer ID Application certificate and
notarized by Apple, so users get no Gatekeeper prompt. Config lives in
`electron-builder.yml` (`mac.hardenedRuntime`, `mac.notarize`, the
`resources/entitlements.mac*.plist` files) and the credentials are GitHub
Actions secrets read by `.github/workflows/release.yml`:

| Secret | What it is |
|---|---|
| `CSC_LINK` | the Developer ID Application `.p12`, base64-encoded (`base64 -i cert.p12`) |
| `CSC_KEY_PASSWORD` | the password set when exporting that `.p12` |
| `APPLE_ID` | the Apple Developer account email |
| `APPLE_APP_SPECIFIC_PASSWORD` | an app-specific password from appleid.apple.com |
| `APPLE_TEAM_ID` | the 10-character Team ID from the developer portal |

Never commit the `.p12` or `.cer` — the repo is public. To rotate the cert,
export a new `.p12` from Keychain Access and update `CSC_LINK`.

Locally, `npm run package` auto-discovers the Developer ID identity in the
login keychain and signs; without the three `APPLE_*` env vars exported it
signs but skips notarization (electron-builder logs
`skipped macOS notarization`). To verify a build:

```bash
codesign -dv --verbose=2 "dist/mac-arm64/ADF Studio.app"   # Authority=Developer ID Application
spctl -a -vv -t install "dist/mac-arm64/ADF Studio.app"    # "accepted" once notarized
```

Notarization adds a few minutes per dmg (CI builds two), so the mac job is
the slow one.

**Windows** builds are signed with [Azure Artifact Signing](https://learn.microsoft.com/en-us/azure/artifact-signing/)
(formerly Trusted Signing): a Microsoft-managed, short-lived certificate
issued against a validated identity, so SmartScreen trusts it without a
reputation ramp and Defender false positives attach to the publisher rather
than one file hash. Config is the CI-only overlay
`electron-builder.win-sign.yml` (`extends` the base config and adds
`win.azureSignOptions` + `forceCodeSigning`); the Windows job passes it via
`--config`. It is deliberately not in `electron-builder.yml` because
electron-builder fails hard without the Azure env once `azureSignOptions`
exists, which would break local `npm run package`. Local Windows builds are
therefore unsigned; only tagged releases are signed.

Azure resources (resource group `rg-appsigning`): account `adfstudio-signing`
(East US, `https://eus.codesigning.azure.net`), certificate profile
`adfstudio-signing`, subject `CN=Christian Balevski`. CI authenticates as
the Entra app `adfstudio-release-signer`, which holds the *Artifact Signing
Certificate Profile Signer* role on the account. Secrets:

| Secret | What it is |
|---|---|
| `AZURE_TENANT_ID` | Entra directory (tenant) ID |
| `AZURE_CLIENT_ID` | the app registration's Application (client) ID |
| `AZURE_CLIENT_SECRET` | a client secret on that app — rotate before it expires (Entra → App registrations → Certificates & secrets) |

The workflow then runs `Get-AuthenticodeSignature` over `dist/*.exe` and
fails unless every installer is `Valid` and signed by our CN. To verify a
downloaded installer by hand:

```powershell
Get-AuthenticodeSignature '.\ADF Studio Setup 0.6.1.exe' | Format-List Status, SignerCertificate
```

If a Defender behavioural false positive recurs on a signed build, submit
the installer at <https://www.microsoft.com/wdsi/filesubmission> as a
software developer; the verdict then clears for the certificate.

## In-app updates

Installed copies check GitHub Releases (`latest*.yml`, published by the same
`npm run release`) shortly after launch and every 6 hours. Nothing downloads
by itself: when a newer *published* release exists, an **Update** badge
appears next to the version number in the status bar; clicking it downloads
the update (percent shown in the badge), runs the normal shutdown teardown,
and restarts into the new version. Drafts are ignored, so the review-then-
publish flow above is unchanged.

Per platform: macOS installs from the `zip` target (Squirrel.Mac needs the
app to be signed, which it is); Windows runs the NSIS installer silently;
AppImage swaps itself in place; the `.deb` path runs `dpkg -i` behind a
`pkexec` prompt. Code: `src/main/services/app-updater.service.ts`.

To test the whole path without publishing anything, build two throwaway
packages and serve the newer one as a local feed:

```bash
# 1. "installed" app at a lower version
sed -i '' 's/"version": ".*"/"version": "0.0.1"/' package.json && npm run package && mv dist /tmp/app-old
# 2. the "update" (zip + latest-mac.yml are the feed)
sed -i '' 's/"version": ".*"/"version": "0.0.2"/' package.json && npm run package
mkdir /tmp/feed && cp dist/*.zip dist/*.blockmap dist/latest-mac.yml /tmp/feed   # win: *.exe + latest.yml
git checkout package.json
python3 -m http.server 8765 --directory /tmp/feed &
# 3. run the old app as an isolated instance pointed at the feed
ADF_INSTANCE=9 ADF_UPDATE_FEED_URL=http://127.0.0.1:8765/ "/tmp/app-old/mac-arm64/ADF Studio.app/Contents/MacOS/ADF Studio"
```

The badge appears within ~15 s; click it and the app should restart as
0.0.2. `ADF_UPDATE_FEED_URL` is only honoured together with `ADF_INSTANCE`,
so the real single-instance app always talks to GitHub.
