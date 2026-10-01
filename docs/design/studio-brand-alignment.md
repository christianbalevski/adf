# Studio brand alignment

Tracks the work to align ADF Studio with the agentdocumentformat.org brand. Source of truth: `adf-org/brand/BRAND.md` (§10 maps Studio surfaces) and `adf-org/brand/tokens.json`.

Branch: `feat/brand-alignment`.

## Steps

| # | Step | Status |
| --- | --- | --- |
| 1 | Vendor `tokens.css`; remap `--adf-ui-*`; `data-theme` + `.dark`; main-process window background | done (unverified on screen) |
| 2 | Remap Tailwind `neutral`/`zinc`/`gray`/`blue` ramps onto brand tokens in `@theme` | done (unverified on screen) |
| 3 | Bundle Inter Tight, STIX Two Text, JetBrains Mono; Inter Tight 15 px default; mono ligatures off | done (unverified on screen) |
| 4 | App icon from `.A` mark; wordmark in title bar and About | done (unverified on screen) |
| 5 | Radius 3/6; hairlines replace card shadows; `shadow-pop` for floating UI; motion tokens; reduced motion; focus ring | done (unverified on screen) |
| 5b | Type scale: move `text-[10px]` (552), `text-[11px]` (342), `text-xs` up toward 13 px dense / 15 px UI; check sidebar, fleet, logs | todo |
| 6 | Primitives and shell: one primary per view, quiet buttons, sidebar active `--tint`, status bar, dialogs | todo |
| 7 | Chat surfaces: user sunken, tool calls collapsed mono, booktabs tables | todo |
| 8 | Shiki in chat; CodeMirror GitHub themes; `editor.css` on tokens | todo |
| 9 | Orbital avatars (`orbital.js`, seeded by DID, bitmap cache, animate running only) | todo; placement open, see below |
| 10 | ava in empty states, onboarding, About; UI copy voice pass | todo |
| 11 | Mesh/fleet, `loop-color.ts`, `UsageChart.tsx` hardcoded colours to tokens | todo |
| 12 | Codemod raw palette classes to semantic tokens; drop step 2 remap; lint rule | todo |
| 13 | TUI brand theme | todo |

## Open decisions

- Orbital placement when viewing an agent (step 9). Owner is considering a right-side agent summary panel with the animated orbital plus key stats; undecided.
- Fleet surfaces exemption (`globals.css` comment): recommend ending it at step 11.

## Decisions

- Font picker stays; Inter Tight is the default.
- App icon: `.A` mark on a `--paper` rounded square. Wordmark only in title bar and About. No orbital or ava as logo (BRAND.md).
- Orbital replaces the emoji avatar everywhere (seed `did ?? agentId ?? filePath`). Retire the emoji picker from the main UI; keep `config.icon` in the file and on the agent card for compatibility.

## Orbital notes (step 9)

- Existing avatar slots: sidebar `AgentAvatar` (`Sidebar.tsx`), title bar `AgentTitleCluster`, status bar, fleet map emoji (SVG `<text>`, many Fleet* components), review dialog `Monogram` (already DID-seeded).
- The chat has no header and no per-message avatar. `AgentPanel.tsx` is dead code.
- Foreground agent DID is fetched on demand (`adfApi.getDid()`), so it needs a store. `TrackedDirEntry` (sidebar) has no DID, so add it.
- Running: `useAgentStore.state === 'active'`; background via `useBackgroundAgentsStore`; transitions via `useAppStore` starting/stopping sets.

## Follow-ups from steps 1-5

- Dark accent is `#7f9dff`; `text-white` on accent fills must become `--adf-ui-on-accent` (step 6).
- Title bar uses `--paper-sunken`; BRAND §10 says `--paper` + bottom hairline (step 6).
- Brand `--text-*`/`--radius-*`/`--font-*` names collide with Tailwind; `brand-tokens.css` sits in a lower cascade layer so Tailwind wins. Brand type scale is therefore not applied (step 5b).
- Grey ramp has no step for light ink `#111111` or dark paper-raised `#11141b`.
- sky/indigo (~120 uses), fleet `shadow-lg/xl/2xl`, SVG `fontWeight` 700/800 in mesh, `.field-input` colours, select chevron: step 11.
- Reduced motion also freezes `animate-spin` spinners; check on screen.
- Windows title-bar overlay follows OS theme, not the in-app choice (pre-existing).
- Font migration moves users on `system` to Inter Tight once (`uiFontBrandDefaultApplied` marker); deliberate System pickers move too.
- README logo `docs/assets/adf-github-readme-logo.svg` is off-brand; replace with wordmark light/dark in `<picture>`.
- White icon tile has no edge on light taskbars/docks; brand forbids outlines.
