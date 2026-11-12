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
   - `macos-15` → `…-arm64.dmg` (Apple Silicon) **and** `…-universal.dmg`
     (runs on Apple Silicon and Intel — the download for Intel users), plus
     the corresponding `.zip` packages used by the macOS updater
   - `windows-2022` → `…-Setup-….exe`
   - `ubuntu-latest` → `….deb` + `….AppImage`

   Each job attests its final installer/update packages after packaging,
   signing/notarization where applicable, upload, and package checks.
2. **publish** — as soon as all three builds and their attestations succeed,
   generates release notes from every commit since the previous version tag
   (`scripts/release-notes.mjs`, grouped by conventional-commit prefix), sets
   them as the release body, and flips the draft to published. Live at
   `https://github.com/christianbalevski/adf/releases/latest`.

**Why a universal dmg instead of an Intel one:** the old separate Intel job
needed `macos-13` (GitHub's last Intel image), which routinely sat queued 30+
minutes or never got a runner, so it never actually shipped. Instead the
`macos-15` (arm64) runner builds with `--arm64 --universal`: the arm64-only
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

The same file is bundled into Studio: the version number in the status bar
shows it as "What's new in vX" (a dot marks notes not opened yet), and the
update badge shows the GitHub release text before downloading. When a release
needs the user to do something (sign in again, re-enter a key), put the steps
under an `## Action needed` heading: Studio then opens the notes by itself
once, on the first launch of that version.

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

## Independently verifying installer provenance

The tagged release workflow generates GitHub artifact attestations for the
final DMG, macOS updater ZIP, Windows NSIS EXE, DEB and AppImage files. It
hashes the completed packages uploaded by electron-builder to the draft
release, rather than intermediate `app.asar` files or unpacked applications.
GitHub may normalize spaces in uploaded filenames; verification binds the
downloaded **bytes** by digest. Blockmaps and `latest*.yml` updater metadata
are outside this attestation's scope.

The workflow uses the SHA-pinned [`actions/attest` action](https://github.com/actions/attest),
which generates SLSA build provenance by default (the successor to
`actions/attest-build-provenance`). Only the installer build matrix receives
`attestations: write` and the signing certificate's `id-token: write`, along
with `contents: write` for release uploads. The publication job only needs
`contents: write`; other jobs default to `contents: read`. The npm publisher's
existing OIDC permission is separate and does not attest installers. A missing
expected package or failed attestation fails the build job and blocks draft
publication.

Use an authenticated [GitHub CLI](https://cli.github.com/) with
[`gh attestation verify`](https://cli.github.com/manual/gh_attestation_verify).
Download the package itself and require the repository, release workflow and
tag identities:

```bash
# Concrete existing release/name example; v0.8.9 predates attestations.
# For a release built with this workflow, set tag and artifact to its values.
tag=v0.8.9
artifact=adf-studio_0.8.9_amd64.deb
gh release view "$tag" --repo christianbalevski/adf --json assets --jq '.assets[].name'
gh release download "$tag" --repo christianbalevski/adf \
  --pattern "$artifact" --dir "verify-$tag"
gh attestation verify "verify-$tag/$artifact" \
  --repo christianbalevski/adf \
  --signer-workflow christianbalevski/adf/.github/workflows/release.yml \
  --source-ref "refs/tags/$tag"
```

These are real downloadable names from
[`v0.8.9`](https://github.com/christianbalevski/adf/releases/tag/v0.8.9), checked
on 12 November 2026. Substitute the selected release's version in each name:

| Platform/package | Release asset name |
| --- | --- |
| macOS Apple Silicon | `ADF-Studio-0.8.9-arm64.dmg` |
| macOS universal (Intel and Apple Silicon) | `ADF-Studio-0.8.9-universal.dmg` |
| macOS Apple Silicon updater | `ADF-Studio-0.8.9-arm64.zip` |
| macOS universal updater | `ADF-Studio-0.8.9-universal.zip` |
| Windows x64 | `ADF-Studio-Setup-0.8.9.exe` |
| Linux x64 DEB | `adf-studio_0.8.9_amd64.deb` |
| Linux x64 AppImage | `ADF-Studio-0.8.9.AppImage` |

Require a successful verification exit status. A missing attestation is a
verification failure, not evidence of provenance; older releases are not
retroactively covered. **Successful verification of a release built with this
change is pending the first authorized release containing it.** No release was
created or republished to validate this change.

Validation on 12 November 2026: `actionlint` 1.7.12 passed for
`.github/workflows/release.yml`. Local fixture checks covered all seven package
patterns (including Windows filenames with spaces), rejected each missing
package, and excluded intermediate files and updater metadata. Downloading
the real `v0.8.9` DEB and running the verification command with GitHub CLI
2.86.0 exited 1 with HTTP 404 from the attestation API for its digest, as
expected for a release made before this workflow change.

Provenance identifies the producing repository/workflow and source revision.
It does not establish that the source is safe or reproducible, and is distinct
from OS code signing, Apple notarization and Windows SmartScreen reputation.
The bundled coreutils WASM's upstream source, pinned inputs, build commands and
reproducibility limits are recorded in
[`resources/wasm/README.md`](resources/wasm/README.md).

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

## Google OAuth client (Gmail and Google Calendar)

Release builds can embed a Google **Desktop app** OAuth client so the Gmail
and Google Calendar Add MCP Server flows sign in without the user creating a
Google Cloud project. Both servers use the same client
(`src/shared/utils/google-oauth-client.ts`). The build step of
`.github/workflows/release.yml` reads it from the
`ADF_GMAIL_OAUTH_CLIENT_JSON` secret (the name predates Calendar): the client
JSON as downloaded from Google Cloud Console (`{"installed": {...}}`).
`electron.vite.config.ts` validates it and defines it into Studio's main
process and the daemon; a malformed value, a Web application client, or one
carrying tokens fails the build (the error never prints the value). Without
the secret (local builds, pull requests, the npm CLI package) the constant is
undefined and Gmail and Calendar ask for the user's own client file as before.

A Desktop client is not confidential: anyone can extract it from the
installed app (`app.asar`). It identifies the app to Google and grants
nothing by itself. No tokens are bundled; each user's tokens are created by
the server's own sign-in and stay in that server's token file under its own
home folder (`~/.gmail-mcp/credentials.json`,
`~/.config/google-calendar-mcp/tokens.json`). Calendar's stays there only
while `XDG_CONFIG_HOME` is unset; with it set, the server writes
`$XDG_CONFIG_HOME/google-calendar-mcp/tokens.json` instead. Never commit the
client JSON.

ADF writes the built-in client on the host only, and only when the server's
own folder has no client file yet (`~/.gmail-mcp/gcp-oauth.keys.json`,
`~/.config/google-calendar-mcp/gcp-oauth.keys.json`); a file the user chose
always wins. Agent write-back never stores it: a captured file byte-equal to
the build's client is skipped, so it never follows an agent into a container
or back over a host file. A client file the user chose is still captured, as
are the tokens.

To rotate, create a new Desktop client, update the secret and release.
Existing installs keep the client file they already wrote; deleting a
server's client and token files and connecting it again picks up the new
client. Agents that stored tokens from the old client need a fresh sign-in.

Google side: the OAuth consent project is in production. Before releasing a
build that has the secret, the project must have the **Google Calendar API**
enabled and the `https://www.googleapis.com/auth/calendar` scope on its consent
screen, next to Gmail's; otherwise Calendar sign-ins fail or show the
unverified-app screen. Calendar sign-ins likely count toward the same
unverified-user cap as Gmail's (not confirmed with Google). Gmail's scopes are
restricted, so until Google verifies the app the bundled client counts against
Google's unverified-app cap of 100 users over the project's lifetime. Do not
move the project back to Testing: Testing mode expires refresh tokens after 7
days.

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
