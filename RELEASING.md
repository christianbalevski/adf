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
   - `macos-14` → `…-arm64.dmg` (Apple Silicon)
   - `windows-latest` → `…-Setup-….exe`
   - `ubuntu-latest` → `….deb` + `….AppImage`
2. **build-intel** (`macos-13`, **best effort, non-blocking**) → `….dmg`
   (Intel x64). Runs in parallel but `publish` does *not* wait for it.
3. **publish** — as soon as the *three critical* builds succeed, generates
   release notes from every commit since the previous version tag
   (`scripts/release-notes.mjs`, grouped by conventional-commit prefix), sets
   them as the release body, and flips the draft to published. Live at
   `https://github.com/christianbalevski/adf/releases/latest`.

**Why Intel is best-effort:** GitHub's `macos-13` is its last Intel image and
is scarce/deprecating — the job routinely sits queued 30+ min or never gets a
runner. Blocking releases on it (the old design) held every release hostage.
Now the release publishes on arm64/Windows/Linux promptly; if the Intel build
ever finishes, electron-builder attaches its `.dmg` to the release whenever it
does (so a release may briefly lack the Intel dmg, then gain it). If `macos-13`
is retired entirely, Intel needs a self-hosted runner or a cross-built
universal binary. The two Mac runners stay separate because the native deps
(`better-sqlite3`, `sqlite-vec`) compile for the host arch only — one runner
building both arches ships a cross-arch dmg that crashes.

> **Future (when you add auto-update / electron-updater):** each Mac runner
> writes its own `latest-mac.yml`, and the second upload clobbers the first,
> breaking arch-aware auto-update. You'll need to merge the two `latest-mac.yml`
> files (one job per arch → a combine step) before that matters. No impact
> today — there's no auto-update consumer yet.

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

## Code signing (not configured)

CI builds are **unsigned** (`CSC_IDENTITY_AUTO_DISCOVERY: false`). macOS users
get a Gatekeeper warning on first open (right-click → Open). Adding an Apple
Developer cert + notarization, and a Windows signing cert, is the next
hardening step — wire the certs in as GitHub secrets and electron-builder picks
them up automatically.
