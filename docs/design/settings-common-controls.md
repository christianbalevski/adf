# Settings and Common Controls — Visual System Modernization

**Status:** implementation-ready proposal
**Scope:** ADF Studio Settings and non-fleet shared controls only
**Difficulty:** 4–5 / 10
**Target:** a dedicated PR based on current `main`

---

## 1. Summary

Modernize ADF Studio's Settings UI and its ordinary shared controls without
changing application behavior or the separately designed **Age of Agents**
experience.

The application already uses Tailwind CSS v4, but most controls are composed
from one-off utility strings. That has produced slightly different versions of
the same button, field, card, and segmented control across the renderer. This
work should **keep Tailwind**, add a small ADF-specific component layer, and
migrate Settings plus the shared dialogs to it.

The intended visual character is a quiet, compact desktop tool rather than a
generic web dashboard:

- restrained surfaces and borders;
- compact, consistent controls;
- one visually dominant action per context;
- semantic color used for meaning, not as large blocks of decoration;
- clear hierarchy through spacing and typography;
- first-class light and dark themes;
- functional, deliberate behavior on macOS, Windows, and Linux/Ubuntu.

This is a visual-system refactor, not a settings architecture rewrite. Preserve
all existing state, IPC calls, validation, save behavior, and navigation.

## 2. Current state

Relevant implementation:

- `src/renderer/styles/globals.css` imports Tailwind v4 and contains an early
  semantic-token scaffold.
- `src/renderer/components/settings/SettingsPage.tsx` owns Settings navigation,
  content, and most of its control styling. It currently repeats the primary
  settings-card recipe approximately 17 times.
- `src/renderer/components/common/Dialog.tsx` is the shared dialog shell.
- `src/renderer/components/common/{PasswordDialog,OwnerMismatchDialog,CloneDialog,AgentReviewDialog}.tsx`
  repeat similar button, field, notice, and surface styles.
- There is no shared `Button`, `IconButton`, `SegmentedControl`, settings row,
  or general field primitive.

No Bootstrap, Material UI, shadcn/ui, Radix, Chakra, Mantine, or other visual
component framework is installed. Do not add one for this phase.

## 3. Goals

1. Establish a small, documented set of semantic design tokens for ordinary
   ADF Studio controls.
2. Introduce reusable controls with consistent size, radius, type, focus,
   disabled, and interaction states.
3. Replace Settings' collection of isolated rounded cards with a smaller number
   of logical groups containing clean rows and selective separators.
4. Migrate the shared dialog shell and its four common dialog implementations.
5. Preserve every existing Settings feature and handler.
6. Confirm that Age of Agents is visually and behaviorally unchanged.
7. Support light, dark, and system theme modes on macOS, Windows, and
   Linux/Ubuntu.

## 4. Non-goals

This PR must not:

- replace Tailwind;
- introduce a general-purpose UI framework;
- redesign or refactor Age of Agents;
- modify fleet-map controls, readouts, tiles, overlays, terrain, colors, or
  interaction behavior;
- migrate agent-specific approval controls;
- redesign the application titlebar, Start/Stop/KILL controls, agent editor,
  inbox, timers, credential panels, or agent configuration screens;
- extract Settings state or IPC logic from `SettingsPage.tsx` merely to make the
  file smaller;
- change settings storage, defaults, validation, or API contracts;
- attempt to make native operating-system rendering pixel-identical.

Those areas may adopt the new primitives in later, separately reviewed PRs.

## 5. Protected Age of Agents boundary

Age of Agents is a protected, separately designed subsystem. Treat a visual
change to it as a regression.

### 5.1 Files that must not change

- `src/renderer/components/mesh/**`
- fleet-specific state, layout, node, graph, or command-bar code
- fleet-specific animations and selectors in `src/renderer/styles/globals.css`

Do not perform drive-by formatting or import cleanup in those files.

### 5.2 Shared-component caveat

`src/renderer/components/agent/ApprovalControls.tsx` is imported by
`FleetApprovalModal.tsx` and `MeshGraphNode.tsx`. It is therefore **out of scope**
for this phase. Do not restyle Approve/Reject yet.

The shared `Dialog` component is not currently imported by fleet components and
may be migrated. If that dependency changes before implementation starts,
re-check its consumers and stop before allowing the new dialog styling to reach
fleet surfaces.

### 5.3 Token isolation

New tokens must be additive and uniquely named, for example `--adf-ui-*` or
Tailwind aliases such as `--color-ui-*`. Do not change the meaning or value of
an existing token used by fleet code.

New primitives must consume the new tokens explicitly. Avoid global element
selectors such as `button { ... }`, `input { ... }`, or blanket changes to all
scrollbars, borders, shadows, or typography. Adding an unused global custom
property is safe; changing an inherited property is not.

Before merging, compare Age of Agents before and after in both themes. The PR
description must state that no fleet files changed and include the comparison.

## 6. Design principles

### 6.1 Desktop density

- Default control height: **32 px**.
- Compact control height: **28 px**.
- Touch-sized mobile controls are not required; this is a desktop Electron app.
- Default control text: **12–13 px**. Use 14 px for prominent settings values
  and headings where the existing hierarchy needs it.
- Controls should not become smaller than their content or lose a usable pointer
  target.

### 6.2 Shape

- Standard controls: approximately **6 px** radius.
- Group containers and dialogs: approximately **8–10 px** radius.
- Pills are reserved for badges, statuses, or genuinely pill-shaped choices.
- Avoid applying `rounded-lg` independently to every item on a page.

### 6.3 Color and emphasis

- Neutral/ghost is the default action treatment.
- Blue is reserved for the primary action, focus, active navigation, and
  selected controls.
- Red is reserved for destructive meaning; green for positive status or
  confirmation; amber for warnings and pending attention.
- Destructive and positive secondary actions should generally use tinted text,
  icons, borders, or hover states rather than large fully saturated fills.
- Maintain sufficient contrast in both themes and do not communicate state by
  color alone.

### 6.4 Surfaces and separators

- Prefer a few meaningful groups over one bordered card per setting.
- A group may contain several rows with subtle internal separators.
- Do not place a separator after every short label if spacing already expresses
  the relationship.
- Avoid nesting multiple bordered rectangles unless the nested item is a true
  editor, table, warning, or sub-resource.

### 6.5 Motion

- Use short color/opacity transitions, roughly 120–160 ms.
- Avoid scale, bounce, and decorative motion in Settings.
- Respect `prefers-reduced-motion` for any nonessential animation.

## 7. Semantic tokens

Extend `src/renderer/styles/globals.css` with a clearly bounded **ADF Studio UI**
token section. Exact values may be tuned during visual review, but the token
roles should be stable:

| Role | Purpose |
|---|---|
| canvas | Settings content background |
| sidebar | Settings navigation background |
| surface | Group and dialog surface |
| surface-raised | Menus and raised interactive surfaces |
| surface-hover | Neutral hover state |
| text | Primary text |
| text-muted | Secondary descriptions |
| text-subtle | Labels, placeholders, metadata |
| border | Ordinary group boundary |
| separator | Lower-emphasis row division |
| accent | Primary and selected state |
| accent-subtle | Selected control/navigation tint |
| focus | Keyboard focus ring |
| danger / danger-subtle | Destructive actions and notices |
| success / success-subtle | Positive states |
| warning / warning-subtle | Warnings and pending states |

Also establish named control and container radii, a restrained dialog shadow,
and control heights. Do not add a large typography or spacing framework; use the
existing Tailwind scale where it already works.

Light and dark values must be defined together. Avoid scattering new
`dark:bg-*` and `dark:text-*` choices through every consumer once a semantic
token exists.

## 8. New component layer

Place new primitives under `src/renderer/components/ui/`. Keep them small,
controlled, and based on native elements. Prefer explicit template functions
or a tiny local class-composition helper; adding `clsx`, CVA, or another package
is not necessary for this phase.

### 8.1 `Button`

Suggested API:

```ts
type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
type ButtonSize = 'compact' | 'default'

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
}
```

Requirements:

- forwards native button props and `ref` if consumers require it;
- defaults to `type="button"` to prevent accidental form submission;
- has consistent hover, active, focus-visible, and disabled states;
- disabled/loading state blocks repeated actions;
- supports text, icons, or both without imposing an icon package;
- does not encode layout-specific margins.

`danger` is for genuinely destructive actions. Cancel, Close, Back, Reset, and
ordinary secondary actions should normally be `secondary` or `ghost`.

### 8.2 `IconButton`

Use for icon-only refresh, reveal, copy, add/remove, and similar actions.

Requirements:

- compact and default sizes aligned with `Button`;
- mandatory accessible name through `aria-label`;
- optional tooltip remains a consumer concern unless the existing `Tooltip`
  component is deliberately composed;
- neutral by default, with selected and danger variants only when needed.

### 8.3 `SegmentedControl`

Use for Theme and other small mutually exclusive choices.

Suggested API:

```ts
interface SegmentedOption<T extends string> {
  value: T
  label: React.ReactNode
  disabled?: boolean
}

interface SegmentedControlProps<T extends string> {
  value: T
  options: SegmentedOption<T>[]
  onChange: (value: T) => void
  ariaLabel: string
  size?: 'compact' | 'default'
}
```

Requirements:

- one quiet containing surface, not several unrelated filled buttons;
- selected item uses a subtle accent tint/ring and clear text contrast;
- exposes a single-choice semantic (`radiogroup`/`radio` or equivalent);
- supports Left/Right arrow navigation, Home/End, and visible keyboard focus;
- Theme continues calling the existing `handleThemeChange` unchanged.

### 8.4 `SettingsGroup` and `SettingsRow`

These are Settings composition components rather than general application
cards.

`SettingsGroup` supplies one surface, one outer border, and optional heading or
description. `SettingsRow` supplies:

- label and optional description on the left;
- control/action area on the right;
- optional stacked layout for editors and narrow widths;
- an explicitly requested separator, rather than an automatic heavy divider;
- disabled/help/error slots when required.

Use rows for discrete preferences. Use a full-width block within the group for
large editors such as prompts, credential lists, logs, or usage detail. Do not
force complex existing content into a two-column row.

### 8.5 Fields

Create either small native wrappers (`TextInput`, `Select`, `Textarea`) or a
shared field-class function. The choice should be based on existing prop needs,
not abstraction for its own sake.

All fields must share:

- 32 px ordinary height where applicable;
- semantic surface, border, placeholder, focus, disabled, and error colors;
- 6 px radius;
- no browser-default blue outline in addition to the custom focus ring;
- accessible label association and error/help relationships.

Native selects are acceptable. They need to be usable and visually coherent on
all three operating systems, not pixel-identical.

### 8.6 `Dialog`

Restyle the existing native `<dialog>` shell rather than replacing its behavior.
Preserve its `open`, `onClose`, `title`, `children`, and `wide` contract unless a
small additive prop is clearly necessary.

Target qualities:

- quieter shadow and border;
- consistent surface/text tokens;
- compact title/footer rhythm;
- correct Escape and native close behavior;
- visible focus and sensible initial focus in each consumer;
- no new settings-style close button requirement.

Do not make a broad behavioral rewrite of dialog focus trapping or portals in
this visual PR.

## 9. Settings composition

### 9.1 Navigation

Keep the dedicated Settings layout, **Back to app**, search, section grouping,
active-item behavior, and the existing 240 px sidebar alignment.

Modernization may tune color, radius, spacing, and focus state, but must not:

- change navigation labels or section membership;
- alter search behavior;
- bring back the redundant top-right close button;
- change sidebar width independently from the agent directory;
- introduce a second horizontal app bar.

### 9.2 Content hierarchy

Each settings page keeps:

1. page title;
2. one short description when useful;
3. two to four logical groups in most cases;
4. related rows or full-width editors within each group.

Remove the current pattern where every isolated setting appears as its own
rounded bordered card. Do not over-correct by turning the page into one enormous
undifferentiated panel.

Suggested General-page grouping:

- **Appearance:** Theme segmented control.
- **Usage:** Token usage summary and its actions.
- **Agent defaults:** Global system prompt and compaction prompt editors.
- Additional unrelated settings remain in their own clearly named group.

The implementer should inventory each existing tab before changing markup and
choose group boundaries based on meaning, not merely proximity in the file.

### 9.3 Theme example

The current three chunky Light/Dark/System buttons become a single compact
`SegmentedControl`. It should fit its content rather than stretching across the
group. The selected option must remain obvious in both themes without relying
on a fully saturated blue rectangle.

## 10. Migration scope

### Slice A — foundation

1. Add semantic tokens without altering existing token values.
2. Add the new UI primitives and minimal unit coverage where renderer test
   infrastructure supports it.
3. Add a small development/demo route only if one already exists; do not ship a
   new permanent component gallery as part of this PR.

### Slice B — Settings shell and General

1. Migrate Settings sidebar search, navigation items, and Back to app control.
2. Migrate General page groups and Theme segmented control.
3. Verify behavior before proceeding to other tabs.

### Slice C — remaining Settings tabs

1. Replace repeated outer card recipes with `SettingsGroup`/`SettingsRow` where
   semantically appropriate.
2. Migrate ordinary buttons and fields.
3. Preserve bespoke complex editors until a primitive is demonstrably suitable;
   this PR does not require every utility string to disappear.

### Slice D — shared dialogs

Migrate:

- `Dialog.tsx`
- `PasswordDialog.tsx`
- `OwnerMismatchDialog.tsx`
- `CloneDialog.tsx`
- `AgentReviewDialog.tsx`

Because `Dialog.tsx` also serves inbox, timer, agent-file, identity, and agent
configuration flows, manually smoke-test representative consumers. Do not
otherwise restyle those screens in this PR.

### Explicitly deferred

- `ApprovalControls.tsx` and Approve/Reject split menus;
- `AgentLoop.tsx` pending/thinking surfaces;
- TitleBar Start/Stop/KILL controls;
- provider/MCP/adapter credential panels;
- agent configuration and timer segmented controls;
- fleet-map visual code of every kind.

## 11. Behavior-preservation rules

For migrated Settings code:

- keep existing handlers and store selectors;
- do not alter asynchronous sequencing or error handling;
- preserve `disabled` conditions and confirmation steps;
- preserve visible text unless this spec explicitly changes it;
- preserve keyboard activation and add missing semantics only when low risk;
- use native `button`, `input`, `select`, `textarea`, and `dialog` elements;
- do not convert controlled inputs to uncontrolled inputs or vice versa;
- do not move IPC calls into the primitive layer.

A component primitive owns presentation and generic interaction state. It must
not know about ADF settings, agents, mesh, IPC, or Zustand stores.

## 12. Responsive and cross-platform requirements

The Settings layout must remain usable at the app's supported minimum window
size and at full screen.

- Sidebar remains 240 px and does not overlap content.
- Settings content scrolls independently; the application shell does not gain a
  second unwanted scrollbar.
- Long labels and values truncate or wrap intentionally.
- `SettingsRow` stacks its control below its label at a defined narrow-content
  breakpoint when side-by-side layout would collide.
- Dialogs fit within the viewport and retain internal scrolling for long
  content.
- Do not use macOS traffic-light offsets, Windows caption-button widths, or
  Linux window-manager assumptions inside Settings primitives.
- Use the existing system font stack. Validate that Segoe UI, Ubuntu/Cantarell,
  and San Francisco metrics do not clip 28/32 px controls.

Required manual matrix:

| Platform | Modes | Window states |
|---|---|---|
| macOS | light, dark, system | windowed, maximized/full screen |
| Windows | light, dark, system | windowed, maximized |
| Linux/Ubuntu | light, dark, system | windowed, maximized |

Exact screenshots may be gathered by different machines, but the PR must not be
declared cross-platform complete based only on macOS visual review.

## 13. Accessibility requirements

- Every control is reachable and operable by keyboard.
- Every icon-only action has an accessible name.
- Focus is visible in both themes and is not removed without replacement.
- Segmented controls expose selected state programmatically.
- Disabled controls remain legible and expose the native disabled state.
- Error text is associated with its field where applicable.
- Contrast should meet WCAG AA for ordinary text and essential control states.
- Escape continues to close dialogs where it does today.
- Do not rely on hover alone to expose essential actions or information.

## 14. Verification

### Automated

At minimum run:

```bash
npm run typecheck
npm run lint
npm run build
```

Run the existing test suite when native dependency rebuilding is available:

```bash
npm test
```

If the repository's current baseline causes unrelated failures, record the
exact command and distinguish pre-existing failures from new ones. Do not hide
them by weakening configuration.

Add focused tests for any new class/variant logic and keyboard-selection logic
where the current Vitest environment supports renderer tests. Avoid introducing
a full new browser-test framework solely for this phase.

### Manual Settings regression

For every Settings tab:

- navigate directly and through search;
- interact with each button, segmented choice, input, select, and textarea;
- verify save, reset, test, import/export, clear, expand/collapse, and destructive
  flows represented on that page;
- verify loading, disabled, empty, error, and success states that can be safely
  induced;
- revisit the page to confirm persisted settings remain correct;
- check light, dark, and system theme changes without restarting.

### Dialog regression

Open at least one narrow and one wide dialog. Check primary, secondary,
destructive, disabled, error, keyboard, Escape, and click workflows. Also smoke
test one non-Settings consumer of the shared dialog shell.

### Age of Agents regression

1. Capture baseline screenshots from the commit before this PR.
2. Open the same fleet at the same zoom in light and dark modes after the change.
3. Compare tiles, terrain, stations, command bar, readouts, approval surfaces,
   typography, borders, shadows, and spacing.
4. Confirm `git diff --name-only` contains no file under
   `src/renderer/components/mesh/`.
5. Confirm `ApprovalControls.tsx` is unchanged.

Any fleet visual difference blocks merge unless it is proven unrelated and
explicitly approved as a separate Age of Agents change.

## 15. Acceptance criteria

This phase is complete when:

- Settings no longer presents each simple preference as an independent chunky
  card;
- Theme is rendered as one accessible compact segmented control;
- ordinary Settings buttons, icon buttons, fields, groups, and rows use shared
  primitives;
- Settings has a consistent visual hierarchy in light and dark modes;
- the four common dialogs use the new control language;
- existing Settings functionality and persistence are unchanged;
- Settings works without overlap, clipping, or double scrollbars on macOS,
  Windows, and Linux/Ubuntu;
- Age of Agents is visually unchanged and its protected files are untouched;
- typecheck and build pass, with lint/tests reported accurately;
- the PR contains screenshots for Settings in both themes plus the fleet-map
  no-regression comparison.

## 16. Review and commit strategy

Keep this as a separate PR from feature work. Prefer reviewable commits in this
order:

1. `Add scoped Studio UI tokens and control primitives`
2. `Migrate Settings shell and General controls`
3. `Consolidate remaining Settings groups and fields`
4. `Apply shared controls to common dialogs`
5. `Add verification coverage and screenshots`

Do not combine structural Settings state refactors, new settings, or fleet work
with these commits. If the implementation starts growing beyond the stated
scope, stop after Settings General and split the remaining migration into a
follow-up PR.

## 17. Implementation handoff checklist

Before coding:

- update from current `main`;
- create a new `codex/` feature branch and isolated worktree;
- inventory all consumers of `Dialog` and re-check that fleet has not begun
  importing it;
- capture Settings and Age of Agents baselines;
- confirm the repository is clean and note unrelated baseline failures.

During coding:

- keep changes styling-only unless accessibility requires a small behavioral
  fix;
- migrate one Settings section at a time;
- visually verify both themes after each slice;
- keep fleet paths and `ApprovalControls.tsx` untouched;
- avoid global selectors and unscoped palette changes.

Before handoff or PR creation:

- run the verification commands;
- complete the three-platform matrix or clearly mark which platform checks
  remain for another machine;
- attach before/after Settings screenshots;
- attach the Age of Agents no-regression comparison;
- summarize any deliberately unmigrated controls and why they remain bespoke.
