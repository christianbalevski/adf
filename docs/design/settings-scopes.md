# Settings scopes: Studio and Runtime

Status: implemented on branch `feat/settings-scopes` (off `78d5498f`). User checks: [daemon-backend-user-testing.md §32 (SCOPE)](daemon-backend-user-testing.md#32-settings-scopes-scope).

## 1. Problem

Settings mixes two things: settings of the Studio app on this computer, and settings of the runtime (the ADF daemon) Studio is connected to. In Remote computer mode this shows:

- Settings → Backend shows this computer's daemon ("ADF daemon: Connected · pid … · started by Studio"), which is not the runtime in use.
- Discovered lists one host twice (tailnet and LAN, "Same fingerprint at 2 addresses"). Both rows say Paired and both offer Pair.
- Pair (client side) and Pair device / Add device (host side) read as the same thing.

The key classes already exist (`CLIENT_SETTINGS_KEYS`, `BACKEND_SETTINGS_KEYS` in `src/shared/constants/client-settings-keys.ts`, daemon-backend.md §4.1). The UI does not follow them. This design makes the Settings sidebar follow them and replaces Settings → Backend with a Connection page.

## 2. Decisions

1. The sidebar has two groups: **Studio** (this app, on this computer) and **Runtime · <name>** (the runtime this window uses).
2. Scope = the existing key class. Client keys are Studio, backend keys are Runtime. No key changes class.
3. **Connection** replaces Backend. One list: This computer and each remote. Each row has a state and at most one action (Connect or Pair). Manual entry is under **Add connection**.
4. Saved remotes live in the CLI's `cli-remotes.json` and its token store. Studio, `adf` and the terminal app see one list.
5. In remote mode, host-only controls show "Change on <name>." or are hidden. This computer's daemon status and remote-access hosting are not shown.
6. The host has one **Add device** button. Its dialog opens on the 6-digit code and has **Use a token instead**.
7. A runtime indicator in the status bar names a remote runtime and its connection state.
8. Everything that names "the current connection" is read per window, so #149 can change it per window.

## 3. Inventory (a)

### 3.1 Sections today

| Sidebar group | Page | Groups on the page | New place |
|---|---|---|---|
| Personal | General | Appearance (Theme, Agent avatars, Chat width, Font family, UI scale) | Studio → Appearance |
| | | Notifications (System notifications, Menu bar icon) | Studio → Notifications |
| | | Privacy: Check for updates | Studio → Updates |
| | | Privacy: Check provider connections | Runtime → Providers |
| | | Privacy: Live catalogs | Runtime → MCP servers |
| | | Privacy: Spell-check dictionaries (Linux) | Studio → Privacy |
| | | Files (Agents folder) | Runtime → Files |
| | | Usage | Runtime → Usage |
| | Identity | Owner identity, Runtime identity, Agent identities | Runtime → Identity |
| Agent runtime | Prompts, Agent templates, Providers, Packages, MCP servers, Skills, Channels | as named | Runtime, same pages |
| System | Networking | Status line, Allowed networks, Mesh, mesh server (port, LAN access, LAN addresses, reachability, Discovered runtimes, manual peers), Agent endpoints, Remote access | Runtime → Networking |
| | Compute | Environment, containers, execution targets, host access, resources | Runtime → Compute |
| ADF Studio | Backend | Mode, Switching, Default changed, ADF daemon, Keep the daemon running, Remote access summary, Remote computer (Discovered, Daemon URL, Token, Test, Save, Use this daemon) | Studio → Connection (§5) |
| | About | Version, concepts, links | Studio → About |

### 3.2 Keys

Stores:

- **C**: `studio-client-settings.json` in Studio's userData (daemon modes); `adf-settings.json` in Inside Studio mode.
- **R**: the runtime's `adf-settings.json`, through `GET/PATCH /settings` and the dedicated routes.
- **B**: `studio-backend.json` in Studio's userData.
- **A**: the host's `remote-access.json` and device store, through `/remote-access` (master token and local proof).
- **L**: renderer `localStorage`.
- **K**: `cli-remotes.json` in `daemonSettingsDir()`, tokens in the OS keychain (`ADF` / `remote-token:<fingerprint>`) or `cli-remote-tokens.json`.

Columns **Local** and **Remote** give editability with the local runtime and with a remote runtime as owner through a device token. **Host** = refused to a device token (`isLocalOnlyRoute`, `/remote-access`); Studio shows "Change on <name>." (§7). Inside Studio mode behaves as Local.

| Keys | Page | Scope | Store | Local | Remote |
|---|---|---|---|---|---|
| `theme`, `uiFont`, `uiFontCustom`, `uiScale`, `agentAvatars` | Appearance | Studio | C | Edit | Edit |
| `adf-chat-width` | Appearance | Studio | L | Edit | Edit |
| `nativeNotificationsEnabled`, `menuBarEnabled` (macOS) | Notifications | Studio | C | Edit | Edit |
| `updateChecksEnabled` | Updates | Studio | C | Edit | Edit |
| `spellcheckDownloadsEnabled` (Linux) | Privacy | Studio | C | Edit | Edit |
| `recentFiles`, `remoteRecentFiles` | File menu | Studio | C | Edit | Edit |
| `agentWindows` (agent windows open at quit; [agent-windows.md](agent-windows.md)) | none | Studio | C | none | none |
| `fleetMapState`, `fleetGroups`, `fleetStewards`, `onboardingSharedAt`, `templatesMigrationSeen`, `uiFontSystemDefaultApplied` | none | Studio | C | none | none |
| `mode`, `remote.url`, `remote.token`, `remote.allowInsecureHttp`, `remote.paired` | Connection | Studio | B | Edit | Edit |
| `keepDaemonRunning` | Connection, This computer | Studio | B | Edit | Hidden |
| Saved remotes | Connection | Studio | K | Edit | Edit |
| `providers`, `defaultProviderId` | Providers | Runtime | R | Edit | Edit; stored keys show as stored, never revealed |
| `providerChecksEnabled` | Providers | Runtime | R | Edit | Edit |
| `agentTemplate`, `agentTemplateForChildren`, `childTemplateId`, `defaultTemplateId` | Agent templates | Runtime | R | Edit | Edit |
| `globalSystemPrompt`, `compactionPrompt`, `toolPrompts`, `autoApplyPromptUpdates` | Prompts | Runtime | R | Edit | Edit |
| `sandboxPackages`, `sandboxMaxWorkers` | Packages | Runtime | R | Edit | Edit |
| `mcpServers`, `remoteCatalogsEnabled` | MCP servers | Runtime | R | Edit | Edit; OAuth sign-in relayed (`remote/oauth-relay.ts`) |
| `skillCatalogSources` | Skills | Runtime | R | Edit | Edit |
| `adapters` | Channels | Runtime | R | Edit | Edit |
| `agentsFolder` | Files | Runtime | R | Edit | Edit; the picker browses the host |
| `trackedDirectories` | Sidebar | Runtime | R | Edit | Edit; the picker browses the host |
| Usage records (`/runtime/usage`) | Usage | Runtime | R | Edit (clear) | Edit (clear) |
| `ownerAlias`, `shareOwnerIdentity`, `runtimeAlias` | Identity | Runtime | R | Edit | Edit |
| Owner create, restore, import, back up, confirm backup (`ownerMnemonic`, `ownerDid`, `ownerSeedBackupConfirmed`) | Identity | Runtime | R, host keychain | Edit | Host |
| `runtimeDid`, `runtimeDelegation`, `legacyOwnerDids`, `legacyRuntimeDids` | Identity | Runtime | R | Read | Read |
| `meshEnabled`, `meshPort`, `meshLan`, `tailnetDiscovery`, `meshManualPeers`; mesh server start and stop | Networking → Mesh | Runtime | R | Edit | Edit |
| Firewall check and fix | Networking → Mesh | Runtime | host OS | Edit | Host |
| Remote access on and off, name, addresses, Tailscale https | Networking → Remote access | Runtime | A | Edit | Host |
| `allowedNetworks` | Networking → Allowed networks | Runtime | A | Edit | Host |
| Devices, pairing window | Networking → Remote access | Runtime | A | Edit | Host |
| `compute` | Compute | Runtime | R | Edit | Edit; browser view unsupported |
| `templatesMigratedAt`, `promptDefaultsApplied`, `openrouterMandatoryReasoningModels`, `autoCompactThreshold`, `maxDirectoryScanDepth`, `reviewedAgents`, `runtimeId`, `meshServerEnabled`, `mcpOauthCredentials`, `ownerDidSeedDerived`, `ownerEncPublicKey`, `runtimePrivateKey`, `runtimeEncPrivateKey`, `runtimeEncPublicKey`, `daemonRuntimeDid`, `daemonRuntimeDelegation`, `daemonLegacyRuntimeDids`, `trustedDaemonEncKeys` | none | Runtime | R | none | none |

### 3.3 Scope calls that are not obvious

- **Owner identity.** It belongs to the person, but the phrase and DID live on each runtime host and are changed there. Runtime (§12).
- **Check provider connections, Live catalogs.** Shown under Privacy today, but the runtime makes those requests. Runtime.
- **Agents folder, Usage.** Shown under General today; both are the runtime's. Usage's "recorded by this Studio" is wrong in daemon mode and becomes "Token totals on this runtime."
- **`keepDaemonRunning`.** About this computer's daemon, stored by Studio. Studio, on the This computer row.
- **`remoteRecentFiles`, `fleetGroups`, `fleetStewards`, `fleetMapState`.** Studio keys that hold one runtime's paths and agents. They stay Studio here; #149 keys them by connection (§10).

## 4. Sidebar and pages (b)

```
Studio
  Connection       where this window's agents run
  Appearance       theme, avatars, chat width, font, scale
  Notifications    system notifications, menu bar icon
  Updates          check for updates, version, Check now
  Privacy          no telemetry; spell-check dictionaries (Linux)
  About
Runtime · rawl-hub
  Prompts, Agent templates, Providers, Packages, MCP servers, Skills, Channels
  Files            agents folder
  Identity         owner, runtime, agent identities
  Networking       mesh, remote access
  Compute
  Usage
```

- Group label: "Studio"; "Runtime · <name>". <name> is "This computer" for the local daemon, "Inside Studio" for the legacy mode, the saved remote's name for a remote (the `adf remotes` name, e.g. `rawl-hub`), else the URL's host.
- While the runtime is not connected, the label adds the state: "Runtime · rawl-hub · Not connected". Runtime pages show one line, "Not connected to rawl-hub.", and their controls are disabled.
- Search covers both groups. Results show the group label.
- Page ids: `connection` (old `backend` still opens it), `appearance` (old `general` opens it), `notifications`, `updates`, `privacy`, `files`, `usage` (old `general#usage` opens it). The other ids stay.
- Each page keeps at most one short sentence under its title. Longer text goes to `docs/guides/settings.md`.

### 4.1 Runtime indicator

The status bar (`StatusBar.tsx`) groups the runtime with its mesh and Kill, right of the version: `[update] v0.7.8 ( [runtime] [Mesh] [Kill] )`. All three act on the runtime this window uses.

| Runtime | Connection | Shows |
|---|---|---|
| This computer, Inside Studio | Connected | Nothing |
| This computer | Connecting / Not connected, retrying / Not connected | "This computer · Not connected, retrying" |
| Remote | Connected | Remote icon, "rawl-hub" |
| Remote | Connecting / Not connected, retrying / Not connected | Remote icon, "rawl-hub · Not connected, retrying" |

- Local shows nothing while connected: it is the default, and the status bar stays as it is for most users. A problem always shows.
- State words are those of the connection state (`CONNECTION_LABELS`, `BackendSettings.tsx`), so the indicator, the Help menu status line and the Connection page agree.
- Tooltip: the address, e.g. `https://rawl-hub.tail1234.ts.net:7385`. Nothing else.
- Click: opens Settings → Connection.
- Source: `CONNECTION_LIST`'s `current` and push `CONNECTION_CHANGED` (§5.4), answered for the sender window.

## 5. Connection page (c)

Title "Connection". Help: "The runtime this window uses."

### 5.1 Rows

| Row | State | Action |
|---|---|---|
| This computer, in use | Connected (or Connecting, Not connected, retrying) | none |
| This computer, not in use | none | Connect |
| Saved remote, in use | Connected (or Connecting, Not connected, retrying) | none |
| Saved remote, not in use | Paired | Connect |
| Found on the network, fingerprint not saved | Not paired | Pair |
| Inside Studio (legacy), only while it is the active or saved mode | Connected, or none | Connect |

- A row has a name, its state, and one detail line: address and fingerprint for a remote. "Pairing open" is added when the host's window is open.
- A found host whose fingerprint is saved is the saved row. It is never a second row, so a Paired row never shows Pair.
- Rows that share a fingerprint and do not merge (§8) stay separate Not paired rows, one per address, with no warning. If that fingerprint is saved, only the saved row is shown.
- Remove is in the row's More menu (⋯), for saved remotes that are not in use. Inside Studio (legacy) is also in This computer's More menu while it is not shown as a row.
- Below the list: one button, **Add connection**.
- When This computer is in use, two rows follow the list: the daemon line (pid, started by) with Details, as `daemonLine` today; and **Keep running after quit**, "Agents on this computer keep running after you quit Studio." Neither is shown when a remote is in use.
- Notices (switch waiting, Default changed, `ADF_STUDIO_BACKEND`, session-only launch) stay as one status band at the top.
- Removed: the Mode control and its two descriptions (the duplicated mode text), Daemon URL, Token, Test connection, Save, Use this daemon, Switch to This Daemon, and the Remote access summary (it is on Networking).

### 5.2 Where saved connections live

- **List:** `cli-remotes.json` in the folder of the settings file Studio's daemon uses (`ADF_DAEMON_SETTINGS`, which is `daemonSettingsDir()` for `adf` in a default install), through `src/main/cli/remotes.ts` (`loadRemotes`, `saveRemotes`, `remoteNameFor`), so Studio reads the file `adf` reads. Studio adds no field: an older `adf` rewrites the file without losing anything.
- **Tokens:** `storeRemoteToken`, `readRemoteToken`, `deleteRemoteToken`: the OS keychain. When it refuses or there is none, Studio shows "Keychain unavailable" ("The token can be saved in a file only you can read.", Save to file / Cancel), `adf` the same line and `Save to file? [y/N]`, and only Save to file writes `cli-remote-tokens.json` (user-only).
- **Pinning:** before a saved token is sent, `pinnedRemoteRefusal` checks the fingerprint from `/remote/hello`, as `adf` does.
- **Studio-only fields in `studio-backend.json`:** `remote.name` (new: the saved remote in use, null for the `remote` slot) and `insecureHttpOrigins` (new: origins whose plain HTTP the user confirmed). `mode` stays `embedded | local | remote`.
- **The existing `remote` slot** (`url`, `token` as `safe:`, `allowInsecureHttp`, `paired`) stays where it is. It is shown as one row, named `paired.name` or the URL's host. It holds connections that have no fingerprint (§5.3, Add connection with a token to a host with remote access off).

### 5.3 Flows

**Connect.** `CONNECTION_USE {id}`. Main shows the existing switch dialog (what moves, turns in flight), then restarts Studio on that connection, as Switch to This Daemon does today. After #149 main rebinds the window instead. The renderer does not know which happens.

**Pair** (Not paired row). The existing Pair dialog, title "Pair": host name, address, fingerprint, "Check that the host shows the same fingerprint.", Device name, the plain-HTTP confirmation when needed, Code. On success main saves the remote to K under `remoteNameFor(host name)` (the name `adf pair` gives), the row becomes Paired, and the dialog shows **Done** and **Connect**. A fingerprint that is already saved under another address updates that remote's URL only after the user confirms "rawl-hub is now at 192.168.1.44." with **Use new address** / **Cancel**.

**Add connection** (manual). Dialog "Add connection":

1. **Address**, the plain-HTTP confirmation ("I trust this network; the token is sent unencrypted.") when the address needs it, **Next**.
2. Main calls `GET /remote/hello`. It answers: the dialog shows "rawl-hub · ABCD-EFGH. Check that the host shows the same fingerprint." and **Code** with **Use a token instead**. The code continues as Pair. A token is saved to K like a pairing.
3. No answer (remote access off, an `ADF_DAEMON_TOKEN` daemon, a proxy): the dialog shows **Token** only, with "No fingerprint; identity not checked." The token goes to the `remote` slot. If the slot holds a connection, the dialog says "Replaces <name>." first.
4. On success: **Done** and **Connect**.

**Remove connection.** More menu → Remove. Dialog "Remove rawl-hub": "Removes the address and token from Studio and adf.", and on its own line "Still listed on rawl-hub; revoke it there." Buttons **Remove**, **Cancel**. Main deletes the entry and its token (`adf remotes forget` semantics), or clears the `remote` slot. The connection in use cannot be removed.

### 5.4 IPC

New, `local` class in `channel-map.ts`, answered for the sender window:

- `CONNECTION_LIST` → `{ current: { id, name, url, state }, rows[] }`; ids `local`, `embedded`, `remote` (the slot), `remote:<name>`.
- `CONNECTION_USE {id}`, `CONNECTION_ADD {url, allowInsecureHttp, deviceName?, code? | token?}`, `CONNECTION_REMOVE {id}`.
- Push `CONNECTION_CHANGED`, on any list or state change.

Discovery and pairing keep `REMOTE_DISCOVERY_*` and `REMOTE_PAIR_*`. `RemoteDiscoveryEntry.alreadyPaired` compares against every saved fingerprint, not only `remote.paired`. `BACKEND_SETTINGS_GET/SET` remain for notices and `keepDaemonRunning`. The renderer never receives a token.

## 6. Host "Add device" dialog (d)

On Runtime → Networking → Remote access, while remote access is on, the Devices row has one button, **Add device**. Its help: "Devices that use this computer's agents."

Dialog "Add device":

- **Code view** (default). Opening the dialog opens the pairing window (`REMOTE_ACCESS_PAIRING_OPEN`). Shows "Enter this code on the device.", the code in large digits, "Expires in 1:45 · 5 wrong codes left · Fingerprint ABCD-EFGH", and the link **Use a token instead**. A claim raises the existing native Allow device dialog. After Allow: "Added <label>." and **Done**.
- **Token view.** **Use a token instead** closes the pairing window and shows **Device name** and **Create token**. Then: "Token for <label>. Shown once.", the token, **Copy**, **Done**, and "On the device: Settings → Connection → Add connection." Before a token is created, **Use a code instead** returns to the code view with a new window.
- Cancel or close: the pairing window closes. The token is dropped on Done.
- The Remote access row keeps "A device token is as powerful as your seed phrase."

The Devices list (label, Paired or Token, last seen, Revoke) is unchanged. `adf daemon pair` and `adf daemon devices add` are unchanged.

## 7. Remote-mode rules (e)

<name> is the runtime's name (§4). Copy is exact.

| Place | With a remote runtime |
|---|---|
| Connection → This computer | Row with Connect. No daemon line, no Keep running after quit |
| Networking → status line (network, Tailscale, firewall of this computer) | Hidden |
| Networking → Allowed networks | Hidden |
| Networking → Remote access | Group "Remote access", one row "Remote access", "Change on <name>." No control, no addresses, no devices |
| Networking → Mesh → firewall fix | "Change on <name>." in place of the fix button |
| Networking → Agent endpoints, Identity → Agent directory URL | Hidden (they are the host's loopback addresses) |
| Identity → Back up seed phrase, Import identity, Restore identity | Buttons hidden; one line under Owner identity: "Change on <name>." `REMOTE_OWNER_*` sentences move to the guide |
| Providers, MCP, Channels → reveal a stored value | "Stored on <name>." |
| Compute → browser view | "Open on <name>." |
| Status bar | Runtime indicator (§4.1) |
| All other Runtime pages | As Local; writes go to <name> |

The host-side panels of remote access (`RemoteAccessGroup`, `NetworkStatusLine`) MUST NOT render in remote mode. Today they show only because their channels answer `available: false` or `unavailable`.

## 8. Bug fixes

- **One row per host.** The LAN mDNS record only lists the LAN address (`pickMdnsInterface` skips 100.64/10), so `peers()` in `mdns-service.ts` never sees the host's own word for its tailnet IP and shows two flagged rows. The announcement gains TXT `ts`: the host's tailnet addresses (at most 4, each at most 64 characters), sent whenever remote access is announced, hidden mesh included (the record already carries the stable `fp`, so `ts` adds no new tracking). `listed` becomes A/AAAA plus `ts`. The merge rule is unchanged: one LAN and one tailnet sighting merge only when the LAN record lists that tailnet IP, and the merged row uses the tailnet address. A LAN spoofer that copies a fingerprint and names the real host's tailnet IP only steers clients to the real host.
- **Duplicated mode description.** Gone with the Mode control (§5.1).
- **"Use this daemon".** Gone. The action is **Connect** on the row and in the Pair dialog.
- **Paired row with Pair.** `DiscoveredList` shows Pair on every entry (`RemoteAccessSettings.tsx:485`). The new list gives Pair only to Not paired rows (§5.1).

## 9. Migration (f)

- No settings key changes scope. `CLIENT_SETTINGS_KEYS` and `BACKEND_SETTINGS_KEYS` stay as they are, and no settings file is rewritten.
- `studio-backend.json`: the `remote` slot is read where it is. No token moves. `remote.name` and `insecureHttpOrigins` are new and optional. An older Studio ignores them and uses the slot.
- `cli-remotes.json`: format unchanged. Remotes already paired with `adf pair` show up as Paired rows on first open.
- One fingerprint in both the slot and K: one row. Connect uses the slot when it is the one in use, else K.
- Old page ids open the new pages (§4). Docs that say "Settings → Backend" (`docs/guides/settings.md`, `docs/guides/studio-backend.md`, `docs/cli/remote-daemon.md`, `docs/cli/troubleshooting.md`, the `NewTokenPanel` line, CLI and main messages listed by `grep "Settings → Backend" src`) change to "Settings → Connection".
- Hosts on older versions send no `ts`; their rows stay split and flagged until they update.

## 10. Fit with #149 (g)

#149: one Studio process, several windows, each window on its own connection; UI preferences shared.

- The connection list is a list, so windows choose from it. New Window → choose a connection uses `CONNECTION_LIST`.
- "Connected", the Runtime group label and the status-bar indicator come from the sender window's connection (§5.4). No renderer store holds a global "current connection", and no Studio key caches the runtime's name.
- Connect is one call, `CONNECTION_USE`. Today it restarts Studio; under #149 it rebinds the window. The UI stays the same.
- Studio pages edit C, B, K and L, which #149 shares across windows. Runtime pages talk to the window's runtime through the window's session.
- Left for #149: `remoteRecentFiles`, `fleetGroups`, `fleetStewards` and `fleetMapState` keyed by connection id; `keepDaemonRunning` per connection (#149 open question).
- This design adds no key that assumes one connection.

## 11. Work plan and difficulty (h)

Difficulty is on a 1-10 scale. Time is agent time.

| # | Step | Difficulty | Time |
|---|---|---|---|
| 1 | mDNS `ts` field and merge on it; tests for merge, spoof and hidden mesh (§8) | 3 | 30 min |
| 2 | Discovery rows keyed by saved fingerprints; Pair only on Not paired; `alreadyPaired` against K and the slot | 2 | 20 min |
| 3 | Connection store in main: K plus the slot, pinning, `CONNECTION_*` IPC, channel-map entries, Studio pairing saving to K | 5 | 1 h |
| 4 | Connection page, Add connection and Remove dialogs, replacing `BackendSettings` | 4 | 45 min |
| 5 | Sidebar groups, page split (Appearance, Notifications, Updates, Privacy, Files, Usage), Runtime label, old ids | 3 | 40 min |
| 6 | Remote-mode rules (§7) | 3 | 30 min |
| 7 | Host Add device dialog (§6) | 2 | 20 min |
| 8 | Runtime indicator in `StatusBar.tsx` (§4.1) | 2 | 15 min |
| 9 | Guides, copy, tests (settings-key classes, channel map, new UI tests) | 2 | 30 min |

Overall 5/10, about 4-5 hours of agent time. Step 1 and steps 2 and 7 MAY ship first as a bug-fix PR. Step 3 comes before 4 and 8.

## 12. Decisions (i)

Owner answers, 2026-10-18:

1. **Connections and tokens are shared with `adf`.** Studio uses `cli-remotes.json` and the OS keychain (`ADF` / `remote-token:<fingerprint>`), so a computer paired in Studio or with `adf pair` shows in both. Studio reads a token only when it connects, never to draw the list. A keychain read that is refused or fails (macOS asks once per app the first time Studio reads an item `adf` wrote) ends that connection attempt with "The OS keychain did not give the token for <name>; allow ADF Studio to use it, or pair again." Nothing falls back silently.
2. **Owner identity is under Runtime → Identity.** With a remote runtime it is read-only, with "Change on <name>." (§7).

Out of scope: an identity for the Studio client itself, so changes made from Studio can be attributed to it. Tracked in #148 (client DIDs).
