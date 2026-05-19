# Releasing ADF Studio

The version lives in `package.json`. **Never hand-edit it** — `npm version`
bumps it, makes the commit, and creates the matching `vX.Y.Z` git tag in one
atomic step. A `postversion` hook then pushes the commit + tag for you.

## Cut a release

From a clean `main` (all feature/fix work already merged):

```bash
npm version patch        # 0.1.1 -> 0.1.2  (commit "0.1.2" + tag v0.1.2)
                         # the postversion hook auto-runs: git push --follow-tags
```

- `patch` = bug fixes (0.1.1 → 0.1.2)
- `minor` = backward-compatible features (0.1.1 → 0.2.0)
- `major` = breaking changes (0.1.1 → 1.0.0)

`npm version` refuses to run on a dirty working tree — that's intentional. A
release is a clean, deliberate point.

> Version bumps are **not** per-commit. Normal work commits stay unversioned;
> you only run `npm version` when you actually cut a build.

## Build + publish the installers

```bash
GH_TOKEN=$(gh auth token) npm run release
```

`npm run release` = `electron-vite build && electron-builder --publish always`.
It builds the mac `.dmg` (arm64 + x64), Windows `.exe`, and Linux `AppImage`,
then uploads them to a **draft** GitHub Release for the current version's tag.

- `GH_TOKEN` is required so electron-builder can upload. `gh auth token` reuses
  your existing GitHub CLI login — no separate Personal Access Token needed.
- It lands as a **draft** (see `releaseType: draft` in `electron-builder.yml`).
  Nothing is public yet.

## Publish

Open the repo's **Releases** page on GitHub, review the draft (files attached,
notes), then click **Publish release**. The download links are now public:
`https://github.com/christianbalevski/adf/releases/latest`.

You can only build mac installers on macOS and Windows installers on Windows —
running `npm run release` on one OS publishes only that OS's artifacts to the
same draft. Re-run on the other OS to attach the rest before publishing. (This
is the main reason to eventually move to CI — see below.)

## If something goes wrong

- **Build failed after the tag was already pushed:** the tag is harmless on its
  own. Fix the issue and re-run `npm run release` — it re-uploads to the same
  draft. To redo the version entirely: `git push --delete origin vX.Y.Z`,
  `git tag -d vX.Y.Z`, then start over.
- **Wrong files in the draft:** delete the draft release on GitHub and re-run
  `npm run release`.

## Next step: CI release on tag (#3, not yet implemented)

The end state: pushing a `vX.Y.Z` tag triggers a GitHub Actions workflow that
runs `npm run release` on macOS **and** Windows runners and publishes both. It
runs the exact same command as above — only *where* it runs changes. When that
lands, flip `releaseType: draft` → `release` in `electron-builder.yml` for
hands-free publishing.
