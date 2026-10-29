# Studio in a browser

Browser Studio uses the desktop application's React renderer, stores, styles and
`AdfApi` factory. It connects to the ADF daemon through a same-origin browser
session. Agents, files, providers and compute stay on the daemon's machine.

## Open locally

With the ADF CLI installed, run:

```sh
adf web
```

This starts the local daemon if needed and opens your default browser with a
short-lived, one-use sign-in link. The browser exchanges it for an HttpOnly
session cookie and removes the link's sign-in code from its address. No access
token needs to be copied, and the desktop app does not need to be installed or
running. Use `adf web --port 7485` for a different local daemon port, or
`adf web --no-daemon` to require an already-running daemon.

In desktop Studio, **Settings → Studio → Connections → Open in browser** is
another way to open the same browser client. Both launch methods sign in to
the local daemon. For a daemon on another computer, use the pairing flow below.

The normal browser URL is <http://127.0.0.1:7385/studio/>. Opening that address
directly shows the sign-in page unless the browser already has a session.

## Run from source

Use the Node.js version required by `package.json`, then:

```sh
npm ci
npm run build:web
npm run adf -- web
```

The CLI and daemon must include browser support. If you already run a daemon
from an older build, update it before launching the browser client.

`npm run build` includes the browser assets in desktop builds. `npm run build:npm`
includes them in the CLI package as well. The daemon serves the compiled assets;
there is no separate production web server to deploy.

For renderer development, start or restart the daemon with the Vite address in
its host allow-list, then start Vite in a second terminal:

```sh
# Terminal 1
ADF_DAEMON_ALLOWED_HOSTS=127.0.0.1:5173 npm run daemon

# Terminal 2
npm run dev:web -- --port 5173 --strictPort
```

Open <http://127.0.0.1:5173/studio/>. To sign in at this development origin, use
the pairing flow described below; a local launch link signs in at the daemon
origin that issued it.
Vite serves `/studio/` and proxies `/web` while preserving the browser's Host
and Origin headers. Set `ADF_WEB_DAEMON_URL` on the Vite command when the daemon
uses a different address. If you change the Vite hostname or port, include that
exact address in `ADF_DAEMON_ALLOWED_HOSTS` when starting the daemon. This keeps
browser requests on one origin; it does not enable cross-origin API access.

For isolated source-build QA, use temporary `ADF_USER_DATA_DIR` and
`ADF_LEASE_DIR` directories, a different `ADF_DAEMON_PORT`, and set
`ADF_TEST_SEAMS=1 ADF_COMPUTE=fake ADF_MACHINE_ID=web-qa ADF_SECRET_STORE=file`.
A separate settings directory alone does not isolate Podman: a daemon using
real compute can affect containers on the host, including during shutdown.
The fake-compute and machine-ID settings are development test seams and are
not supported in packaged builds. Keep the test daemon and its browser session
separate from the desktop app's normal daemon.

## Shared implementation

- `src/renderer/` is the only Studio UI. Features and visual changes belong here.
- `src/shared/adf-api.ts` maps API methods to channels for both clients.
  `src/preload/index.ts` supplies Electron IPC; `src/web/` supplies browser RPC
  and streaming events.
- `src/main/backend/daemon-mode/` supplies the same handlers, document sessions
  and event translation to desktop and browser Studio. Add ordinary daemon
  features there once, rather than writing a second browser API mapping.
- `src/main/daemon/web/` owns authentication, tab lifecycle and static serving.
  Platform adapters handle browser-only and desktop-only behavior at the edge.

Keep native operations behind the injected desktop platform. Browser tabs use
the existing remote folder picker for paths on the daemon and browser file
selection for uploads. Native window operations become browser actions where
possible. Operations that require the desktop application return an explicit
unavailable error.

## Access from another device

On the host computer, enable remote access and open a pairing window:

```sh
adf daemon remote on
adf daemon pair
```

If remote access is paused because the current network has not been allowed,
inspect `adf daemon remote status`, then allow the intended network with
`adf daemon remote allow-network <network-id-or-name>`. Run `adf daemon pair`
again. It prints the browser address and a six-digit code valid for two minutes.
Keep that terminal open.

On the other device, open the printed `/studio/` address and enter the code
and a name for this browser. Back in the host terminal, review the named
request and answer the **Allow** prompt. The code alone does not grant access.
After approval, the browser signs in automatically.

You can also open and approve pairing from desktop Studio's **Settings →
Studio → Connections → Add → Share**. Neither the CLI launcher nor terminal
pairing requires the desktop app.

The pairing flow uses the daemon's existing device permissions and revocation
controls. A paired browser is remembered for up to 30 days through an HttpOnly,
SameSite Strict credential cookie. JavaScript cannot read it; no credential is
put in the URL or browser local storage. Removing that device or turning off
remote access ends its browser access too. Signing out clears the remembered
browser credential. Existing pairing expiry and wrong-code limits apply.

Use HTTPS through your configured reverse proxy for access beyond loopback,
and include its hostname in the daemon's host allow-list. See
[remote daemon access](../cli/remote-daemon.md) for daemon and proxy
configuration.

## Browser differences

The renderer is shared, but browser Studio does not yet support every desktop
integration:

- Each browser session connects to one daemon. To use another daemon, open its
  Studio URL; the desktop client's saved multi-server connections are not used.
- The live **Computer** viewer requires desktop Studio. Agent execution and
  compute controls still run through the daemon.
- ChatGPT subscription sign-in and MCP authorization steps that require a
  desktop callback or native dialog require desktop Studio. Existing daemon
  credentials remain usable; Grok provides its manual device-code flow.
- Native menus, app updates, OS keychain prompts and owner-identity import are
  desktop facilities. Native file dragging and adding host files to templates
  are unavailable. Agent windows open as browser tabs.
- Uploads use browser file selection, with a 24 MiB limit per file. Internal
  files and shared agent copies download through the browser. Folder selection
  uses the daemon's existing remote picker; paths refer to the daemon's machine.
- Recovering queued messages from a closed agent tab requires browser Web Locks
  (normally available on HTTPS and localhost). Without them, Studio leaves the
  saved queue untouched and reports that automatic handover is unavailable, so
  two browser tabs cannot submit the same messages.

Sessions expire eight hours after sign-in and are also lost when the daemon
restarts or you sign out. A remembered paired browser can establish a new
session automatically while its 30-day credential remains valid. After that
credential expires, is revoked, or is cleared by signing out, repeat pairing
and host approval. Local launch links do not create remembered credentials:
run `adf web` or use **Open in browser** again to renew a local sign-in.
Browser appearance and other client preferences live
in that session: they survive page reloads but reset with a new session, and
they do not update desktop Studio's preferences. Daemon settings and saved agent
files remain persistent. Browser recovery copies of unsaved text are stored
separately in that browser's local storage, under the signed-in identity. They
remain available after signing in again with the same identity. Queued messages
and tab records belong to one sign-in session and are never automatically
carried into another. Before an open tab renews its session or signs out, it
keeps pending message text and attachments as `queued-messages.json` recovery
copies. Use **Download copies** in the recovery notice to review them and send
any still-needed messages manually; check the conversation first because an
interrupted request may already have been accepted. Local recovery storage is not encrypted; anyone with access
to that browser profile can inspect it.

Changing appearance updates the other tabs in the same browser session. A tab
left open across a replacement sign-in must reload before it can write again.

Signing out closes the browser session immediately. A disconnected tab is
released after five minutes without activity. Neither action shuts down the
daemon or stops its agents. The browser does not run the agent runtime on the
iPad or browser device.
