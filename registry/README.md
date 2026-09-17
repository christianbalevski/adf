# Agent registry

The `.adf` files in this folder are the agents people can bring home from the
home screen of ADF Studio. They are committed as-is and nothing is generated
from them: the file is the agent, in the same format it has when it runs. To
change one, open it in Studio, change it, and commit the file.

`index.json` is the only sidecar. It lists what the gallery needs before it
opens a file — ordering, a blurb, tags, the file's `sha256` and `size`, and
the oldest app version that opens it (`min_app_version`). Name and icon are
copied from the file.

## How it ships

- `electron-builder.yml` copies this folder into the app's resources
  (`extraResources`, at `<resources>/registry`), so the gallery works with no
  network.
- The app also fetches `index.json` from this folder on `main` and layers it
  over the bundled one. An id the build does not ship is downloadable. A
  strictly newer `version` of a shipped id supersedes it only if its
  `min_app_version` is satisfied; otherwise the bundled file stays.
- Downloads are checked against `sha256` and `size` before use. That check
  only proves the bytes arrived intact; the review dialog the user reads
  before *Claim & Run* is the trust boundary, as for any other `.adf`.

## Adding or updating an agent

```
npm run registry:new -- <name> [icon]   # blank agent, or drop in a file you made in Studio
npm run registry:index                  # rewrites index.json
npm run registry:check                  # fails if index.json has drifted from the files
npx electron-rebuild -f -o better-sqlite3   # back to the Electron ABI for `npm run dev`
```

Then edit the entry's `blurb` and `tags` in `index.json` — the script keeps
hand-written fields and refreshes derived ones (`sha256`, `size`, `version`).

The registry scripts leave `better-sqlite3` built for the node ABI, the same
as `npm test`. Run the `electron-rebuild` line above before `npm run dev`.

CI runs `tests/unit/registry-index-integrity.test.ts`, a pure-Node test that
fails when `index.json` does not match the files in this folder, so a commit
that adds or edits an `.adf` without re-running `npm run registry:index` is
caught before merge.

## What a registry file must not contain

This repo is public and a registry agent is claimed by whoever brings it
home, so a file ships with no owner:

- `adf_identity` empty, no `adf_did` / `adf_owner_did` / `adf_runtime_did`
  in `adf_meta`, `adf_attestations` empty — the index script refuses to
  write while any of these is set;
- no personal loop history (`adf_loop`, `adf_inbox`, `adf_outbox` — the
  script warns; seed memory is fine when it is deliberate);
- no credentials of any kind.

The file name is the agent name: `hello.adf` opens as **hello**.

SQLite sidecars (`*.adf-wal`, `*.adf-shm`) are gitignored — they are runtime
files, not part of the agent. `.gitattributes` marks `registry/*.adf` binary
so git does not try to diff or merge them.
