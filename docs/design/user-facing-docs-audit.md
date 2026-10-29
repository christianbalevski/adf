# User-facing docs and release communication audit

**Status:** Local documentation corrections and release-note generator integration
prepared. Website Node copy is corrected in a separate worktree. Publication
and universal single-`y` behavior remain outside this implementation.

Reviewed on 2026-10-29 against `65ce854e08ad7b2ecbed02c1c7d2107f1f3af109`.
The remaining-scope notes supplied with raw items #239–#244 define this work.
These are tracker item identifiers, not verified GitHub issue numbers.

## Scope and plan

1. Compare the remaining-scope notes with current source, existing tests and
   published metadata; preserve implementation already merged.
2. Correct repository documentation for verified behavior. Prepare a reviewed
   release-note opening and future consistency checklist.
3. Run focused existing tests and record unresolved discrepancies separately.

The initial pass changed Markdown only. The authorized follow-up also changes
the release-note generator and adds isolated generator tests. Application
behavior, signing, engine declarations, startup checks, version numbers and
release workflow triggers remain unchanged. Only the generated release text
changes. The future checklist does not authorize a release or lift a hold.
No website, npm package, GitHub release or social post was published.

## Item outcomes

| Item | Verified evidence and local action | Remaining scope |
| --- | --- | --- |
| #239 Plain-language lead | The generator now prepends a reviewed `docs/release-notes/<exact-tag>.md` opening when present. The v0.8.3 opening is based on `v0.8.2..v0.8.3`, with remote-link and Node caveats. The install footer describes signed Windows releases and removes the unsigned-installer bypass and macOS no-warning guarantee. | Published release notes are unchanged. Future releases need their own reviewed opening; a missing or empty file preserves existing generation and introduces no release gate. |
| #240 Site, downloads and daemon guidance | Live home and Studio pages each expose five v0.8.3 platform download URLs; guides identify v0.8.3 as their source; the CLI page describes a shared daemon. The old v0.7.4/v0.8.0 drift and public daemon contradiction are superseded. Repository CLI/package/daemon introductions still had the old coexistence restriction and are corrected. A future cross-surface consistency checklist is in `RELEASING.md`. | Site source is in the separate `adf-org` repository. The follow-up corrects its hand-written CLI landing page in a separate worktree; synced release snapshots are unchanged. No site deployment was attempted. Version drift must be rechecked for a future release. |
| #241 Node support | Root and CLI package engines and `SAFE_NODE_RANGE` agree on `^22.23.4 || ^24.22.1 || ^26.12.1`. npm metadata for published v0.8.3 declares `>=22`. Installation docs now separate these versions and preserve the intentional refusal of Node 27+. | The `adf-org` CLI landing copy now distinguishes published v0.8.3 from current source in both install and contributor guidance. This is a local source correction; the public site remains unchanged until separately deployed. No support-policy change is implied. |
| #242 Single-`y` approval | Current TUI code approves once on a selected pending approval; otherwise it arms on the first `y` and approves on the second while focused on the transcript. The getting-started guide now explains selection, focus and `/approve`. Generated reference wording remains accurate and unchanged. | The reported October 15 single-`y` decision was not independently established. Blanket single-`y` behavior would require a separate decision and application change; this item is not closed as an implementation of that behavior. |
| #243 API-key referent | Claiming preserves recoverable included credentials; tests show the sender's credential survives claim/unlock. The guide now distinguishes the recipient's ownership from included credentials and explains that recipients can replace them with their own API keys. | The proposed literal substitution was not applied because it would falsely imply that claim replaces credentials automatically. |
| #244 Sharing warning | Added “Before you send an agent”: sharing can include cleared chats retained in audit archives, and clearing is not a privacy scrub. Explained that the password grants access to included credentials. Also corrected stale password-slot removal and envelope-recoverability claims. | No privacy scrub or duplicate-file workaround was implemented or recommended. This documentation is a Day 3 social-post dependency only; the post also waits for PR201 release. It is not a release gate, and no post was sent. |

## Source evidence

- `src/main/utils/brotli-runtime-guard.ts`: `SAFE_NODE_RANGE` and the
  version/decoder checks; `package.json` and `packages/cli/package.json`:
  matching engine declarations.
- `src/main/cli/daemon-control.ts`: `studioConflict` distinguishes embedded
  Studio runtime hosts from Studio daemon clients.
- `src/main/runtime/agent-lease.ts`: leases prevent concurrent runtime ownership;
  unavailable lease storage has a documented warning/unprotected fallback.
- `src/main/tui/views/chat/index.tsx`: approval selection and two-press arming;
  the same file supplies the reference's key description.
- `src/main/adf/adf-workspace.ts`: `adoptEnvelope` preserves
  password slots, `dropDeadCredentialsEnvelope` defines recoverability,
  and `clearLoop` archives according to audit settings.
- `src/main/services/owner-identity.service.ts`: claim retains and adopts
  recoverable credentials. `tests/unit/services/envelope-migration.test.ts`
  verifies preservation of an included credential through claim/unlock.
- `7c062a1d` and `05525d1a` in `v0.8.2..v0.8.3`: question forms and remote
  website-address correction, respectively.

## Reproduce the checks

Run these read-only metadata/source checks from the checkout:

```sh
git show 65ce854e:package.json
git show 65ce854e:packages/cli/package.json
rg -n 'SAFE_NODE_RANGE' src/main/utils/brotli-runtime-guard.ts
npm view @agentdocumentformat/cli@0.8.3 version engines --json
git log --oneline v0.8.2..v0.8.3
node scripts/release-notes.mjs v0.8.3
curl -fsSL https://api.github.com/repos/christianbalevski/adf/releases/latest
curl -fsSL https://agentdocumentformat.org/
curl -fsSL https://agentdocumentformat.org/studio
curl -fsSL https://agentdocumentformat.org/guides
curl -fsSL https://agentdocumentformat.org/cli
```

On the review date, the latest-release API reported v0.8.3, published
2026-10-24. npm returned version `0.8.3` with `engines.node` equal to `>=22`.
Live pages can change; compare the version labels, release/download hrefs,
guide source version, Node wording and daemon guidance when rerunning.

The host's Node 24.6.0 is below main's required range. Tests were run with
the installed Electron 43.8.3 runtime and existing workspace dependencies,
temporarily linked into this worktree; no dependencies were installed or
lockfiles changed. From a checkout with dependencies available:

```sh
ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron node_modules/vitest/vitest.mjs run tests/unit/brotli-runtime-guard.test.ts tests/tui/chat-view.test.tsx --maxWorkers=1
ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron node_modules/vitest/vitest.mjs run tests/daemon-autostart.test.ts tests/runtime/agent-lease.test.ts --reporter=dot
ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron node_modules/vitest/vitest.mjs run tests/unit/services/envelope-actions.test.ts tests/unit/runtime/audit-operation-triggers.test.ts --maxWorkers=1
ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron node_modules/vitest/vitest.mjs run tests/unit/services/envelope-migration.test.ts --maxWorkers=1 -t 'keeps a recoverable credentials envelope through claim|purges an empty foreign credentials envelope on claim|claims a foreign file'
git diff --check
```

Results: Node/TUI checks passed 80 tests; daemon/autostart/lease checks passed
45 tests with one Windows-only named-pipe test skipped on macOS; envelope
actions and audit triggers passed 24 tests; the three selected claim tests
passed (22 excluded by the name filter). These are focused behavior checks,
not a full regression suite, packaged-app walkthrough or signature verification.


## Follow-up verification

The release-note integration uses the existing workflow's script invocation;
no workflow edit is required. It reads the opening from the current checkout,
so reviewing an older tag uses that checkout's opening and install copy.
Version-specific openings are never reused for a different tag.

```sh
node --test tests/scripts/release-notes.node-test.mjs
node scripts/release-notes.mjs v0.8.3
node scripts/release-notes.mjs v0.8.2
git diff --check
```

Five isolated Git-fixture tests passed: exact-version lead placement, refusal
to reuse another version's lead, missing/empty fallback, preservation of the
no-notable-changes case, and rejection of path/option/shell-expression tags.
They also check commit grouping and the installation footer. Real v0.8.3
output includes its opening once; v0.8.2 does not borrow it. The generator
uses Git argument arrays rather than shell interpolation.

A review also clarified the daemon introduction's owner-identity row: Local
mode and legacy Inside Studio use the same owner identity/settings on this
computer, with host-specific secret storage.


### Website source correction

The website worktree is `/Users/cbalevski/repos/adf-org-node-docs`, branch
`codex/website-node-docs`, based on `adf-org` commit `78a9dc4`.
`src/pages/cli/index.astro` separates published npm v0.8.3's `>=22`
declaration from main's exact caret range and startup refusal. Contributor
requirements on the CLI and Studio pages describe main. Both pages also
explain local-model requirements. Synced release snapshots, installation
commands and application functionality remain unchanged.

From that worktree, `npm ci` and `npm run build` succeeded: Astro generated
113 pages and Pagefind indexed 110 pages. The package lock is unchanged.
`npm run shots -- /cli /studio` also passed; desktop/mobile renders in
light/dark themes were reviewed, with no horizontal-overflow warnings. Screenshots are
under that worktree's ignored `.shots/` directory. Both worktrees pass
`git diff --check`.
PR preparation adds `git.deploymentEnabled` with only
`"codex/website-node-docs": false` to the website's `vercel.json`, and documents
that branch exception in its README. This prevents automatic Git deployment
for the review branch while leaving main and other branches unchanged, using
[Vercel's branch deployment control](https://vercel.com/docs/project-configuration/git-configuration#git.deploymentenabled).
No release tag is pushed and no PR is merged.


## Local model documentation

The CLI provider guide, CLI getting-started guide, settings guide, root README and npm README
now say that Ollama, LM Studio and other local servers can connect through
the OpenAI-compatible chat API. Both the server and model need native tool
calling for agent tools. Vision is optional for text/tool work and needed
when the model must understand images or screenshots; image input must also
be enabled in the agent's model settings. The server URL is reached from the
daemon's computer, and a key is required only when the server requires one.
The website's CLI and Studio pages give the same guidance.

Source evidence: `provider-factory.ts` builds `openai-compatible` providers
with the configured base URL and model ID; `provider-catalog.ts` supplies
local-server presets; `ai-sdk-provider.ts` passes structured tool schemas and
processes tool calls; `media-capabilities.ts` combines connector support with
per-agent image settings. No model capability or approval behavior is changed.


Validation: 22 tests passed across the existing provider-catalog,
connector-media and provider-key-fallback suites:

```sh
ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron node_modules/vitest/vitest.mjs run tests/unit/shared/provider-catalog.test.ts tests/unit/providers/connector-media.test.ts tests/unit/providers/provider-key-fallback.test.ts --maxWorkers=1
```

This verifies connector/configuration behavior; no live Ollama or LM Studio
model session was executed. The temporary dependency symlink was removed.
