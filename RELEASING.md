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
single-arch binaries (`sqlite-vec`, `esbuild`, `@napi-rs/keyring`) pick their
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

## Release communication review (future releases)

This checklist is a proposal for a separately authorized future release.
It does not authorize a version bump, tag, release, website publication or
social post, and does not lift a release hold. The workflow above still
publishes automatically after a tag is pushed; this documentation adds no
manual CI gate.

Before preparing a future release, record the candidate commit and the
published Studio and npm versions separately. Review these items against
that candidate:

- Open the [website](https://agentdocumentformat.org/), its
  [guides](https://agentdocumentformat.org/guides) and
  [CLI page](https://agentdocumentformat.org/cli). Compare the displayed
  version, each platform's download URL and the guides' source version with
  the intended published tag and its actual assets. Record the URLs and
  check date. Do not assume that editing this repository updates the site.
- Check Studio/CLI coexistence guidance against the selected version's
  behavior: Local mode uses a shared daemon; Inside Studio runs an embedded
  runtime and must not start a second runtime on the same settings and files.
  Keep the website and [CLI guide](docs/cli/index.md#studio-and-the-cli)
  consistent with the [backend guide](docs/guides/studio-backend.md).
- Copy the exact Node engine range for the version being described and
  check it against that version's startup guard. Current main uses
  `^22.23.4 || ^24.22.1 || ^26.12.1`; published npm v0.8.3 declares `>=22`.
  Do not assign main's restrictions to v0.8.3. Recheck both facts for the
  next candidate rather than treating these values as a permanent policy.
- Begin the release notes with a short paragraph describing what users can
  do or what problem is fixed, followed by upgrade requirements and known
  limitations. Put the generated commit groups after that opening. Verify
  each claim against the candidate diff and test evidence; avoid claiming
  a full regression run from a source review.
- Review the install footer against the actual artifacts and signing
  verification. The generator describes signed official Windows installers
  and signed, notarized macOS builds without promising that the operating
  system shows no warnings.

### Reviewed release-note openings

Write the reviewed opening and any version-specific caveats in
`docs/release-notes/<exact-tag>.md`, for example
[`docs/release-notes/v0.8.3.md`](docs/release-notes/v0.8.3.md). Include the file
in the candidate commit before a separately authorized release. Keep the
opening focused on user-visible changes; the generator adds the technical
changelog and installation section.

`node scripts/release-notes.mjs <existing-tag>` prints the assembled notes
without publishing anything. The script reads the exact matching Markdown
file from the current checkout and prepends it to the generated commit
groups. It does not reuse a different version's opening. A missing or empty
file leaves the generated changelog in place, so this adds no release gate.
Review from the intended checkout: running the generator for an older tag
uses the current checkout's opening and install copy, not those stored at
that tag. The release workflow already calls this script; no workflow change
is needed. Adding an opening locally does not update a published release.

The v0.8.3 opening is based on the
[v0.8.2…v0.8.3 changes](https://github.com/christianbalevski/adf/compare/v0.8.2...v0.8.3),
including `7c062a1d` (question forms) and `05525d1a` (remote website links).
Its Node requirement describes published npm v0.8.3, separately from main.
This source review is not evidence of an executed application walkthrough.

Run the generator checks without application dependencies:

```bash
node --test tests/scripts/release-notes.node-test.mjs
```

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

## npm package (`@agentdocumentformat/cli`)

The same tag also releases the terminal-only package (daemon + CLI + TUI,
`npm i -g @agentdocumentformat/cli` → `adf`). The `npm-build` → `npm-smoke` →
`npm-publish` jobs in `release.yml` bundle it (`npm run build:npm`, output in
`dist/npm`, version = root `package.json`), install the tarball on Linux,
macOS and Windows (Node ^22.23.4 and ^24.22.1, the floors
`adf` enforces), boot a daemon, and publish with
`npm publish --access public` through npm **trusted publishing**: the job
authenticates with GitHub's OIDC token, so there is no npm token secret, and
npm attaches provenance automatically. They run independently of the Studio
jobs.

One-time setup:

1. `npm login`, then claim the name by publishing the first version by hand
   (trusted publishers can only be added to a package that exists):
   `npm run build:npm && npm publish ./dist/npm --access public`.
2. On npmjs.com: **@agentdocumentformat/cli → Settings → Trusted Publisher →
   GitHub Actions**, with organization/user `christianbalevski`, repository
   `adf`, workflow filename `release.yml` (no environment). Until this is
   set, `npm-publish` fails with an authentication error; the Studio release
   is unaffected.

Local check: `npm run build:npm && npm pack ./dist/npm`, then install the
tarball with an isolated prefix (`npm_config_prefix=/tmp/adf-prefix npm i -g
./agentdocumentformat-cli-*.tgz`) and run `node scripts/npm-smoke.mjs` with that
prefix on `PATH`.

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
`npm run release`) shortly after launch and every hour. **Check for updates**
in Settings → About runs the same check on demand and says what it found,
including a failed check, which the background check keeps to the log.
Nothing downloads by itself: when a newer *published* release exists, an
**Update** badge appears next to the version number in the status bar (and
the About button becomes **Download and restart**); clicking either downloads
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
