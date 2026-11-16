# Skill source fixtures (offline, SHA-pinned)

Captured read-only and unauthenticated on 2026-11-14 from public repositories, then trimmed. Tests serve them through a stubbed `guardedFetch`; nothing here is fetched at test time.

| file | source | trimmed to |
|---|---|---|
| `anthropics-skills@1780c5e.tree.json` | `GET /repos/anthropics/skills/git/trees/1780c5e5a552fd4d1c9d6a7b0cab26b0c2bef064?recursive=1` | every `SKILL.md` (20), license/notice blob, `marketplace.json`, every blob under `skills/docx/` and `skills/canvas-design/`, and the folders above them |
| `openai-plugins@d420d13.tree.json` | `GET /repos/openai/plugins/git/trees/d420d13051bffe4543ed39e30fa46b87148e47dd?recursive=1` | every `SKILL.md` (536), license/notice blob, `marketplace.json`, every blob under `plugins/figma/skills/figma-create-new-file/` and `plugins/zoom/skills/video-sdk/android/`, and the folders above them |
| `*.marketplace.json` | the repository's `.claude-plugin/marketplace.json` / `.agents/plugins/marketplace.json` at the same commit | unmodified |
| `manifests/anthropics-docx.SKILL.md` | `skills/docx/SKILL.md` @ 1780c5e | unmodified (835-character description) |
| `manifests/anthropics-canvas-design.SKILL.md` | `skills/canvas-design/SKILL.md` @ 1780c5e | unmodified (indexes as published) |
| `manifests/openai-twilio-conference-calls.SKILL.md` | `plugins/twilio-developer-kit/skills/twilio-conference-calls/SKILL.md` @ d420d13 | unmodified (block-scalar description) |
| `manifests/openai-zoom-video-sdk-android.SKILL.md` | `plugins/zoom/skills/video-sdk/android/SKILL.md` @ d420d13 | unmodified (block scalar; name differs from folder) |

Licenses of the quoted files are those of their repositories (Apache-2.0 for anthropics/skills packages that say so; see each repository). Ref, tag, rate-limit and truncation answers in the tests are synthetic and say so.
