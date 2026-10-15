# Daemon backend: packaged build, smoke, Defender and soak (W5-B)

**Status: Windows run of 2026-10-14, branch `ws/w5-b` at `949830a1`.** macOS arm64 and Linux AppImage packaged runs, the 24 h soak and the macOS keychain prompts (K11) are not covered yet; see "Not covered".

## Summary

| Check | Result |
|---|---|
| Packaged Windows build from a clean checkout | Built. `out/main/daemon.js`, its 7 chunks and every bare import of the daemon bundle (56) resolve to packages in `app.asar`; `better_sqlite3.node` is unpacked |
| Daemon from the asar (`ADF Studio.exe`, `ELECTRON_RUN_AS_NODE=1`) | Boots, opens SQLite, serves `/health` and `/version` (0.7.8, `clientApiVersion` 1) |
| Smoke: packaged Studio in local mode, one turn on `agent-1` | Passed: daemon spawned, chat sent from the UI, mock reply shown |
| Quit with `keepDaemonRunning` off / on | Off: daemon stopped ("Studio started this daemon run and no other client session is open"). On: daemon kept running |
| Defender, before and after | No 1116/1117 event since 2026-09-05; none during the run |
| Soak, 75 min, 5 agents, timers every minute, Studio + TUI attached | 390 timer turns, 0 failed health probes, daemon RSS flat (201-216 MB), handles flat (347-356) |
| Parity suite in the clean checkout, `PARITY_REQUIRE_DAEMON=1` | 18 files, 141 passed, 2 todo, 112 s |

## Build under test

- Source: `git archive` of `ws/w5-b` at `949830a1` into `%TEMP%\adf-w5b`, outside `.claude/worktrees`. A short path because `LongPathsEnabled` is 0 on this machine.
- `npm ci` there (its own `node_modules`, no junction; the postinstall rebuilt `better-sqlite3` for Electron 40.10.6).
- `npm run package` with `NoDefaultCurrentDirectoryInExePath` unset. Output: `dist\ADF Studio Setup 0.7.8.exe` (unsigned, SHA-256 `af9660910d2781acbeac41a44019a027a2d714521cb450802590f19e12021282`) and `dist\win-unpacked`.
- asar check (`@electron/asar` listing): present `out/main/daemon.js`, `out/main/daemon-chunks/*` (7), `node_modules/luxon`, `bindings`, `file-uri-to-path`, `better-sqlite3` (`lib/`, and `build/Release/better_sqlite3.node` in `app.asar.unpacked`), `@napi-rs/keyring`, `sqlite-vec`; 761 packages in total. Every bare `require`/`import` in the daemon bundle and its chunks names a package present in the asar. This closes the W0-D follow-up (tracker §6): the junction is what dropped transitive dependencies; a real `node_modules` does not.
- `ELECTRON_RUN_AS_NODE=1 "ADF Studio.exe" resources\app.asar\out\main\daemon.js` booted the daemon: settings migrated, tracked folder scanned, `GET /version` answered with `startedBy: cli`. `ADF_COMPUTE=fake` was refused, as the seam requires in a packaged build: `[Compute] Ignoring ADF_COMPUTE=fake: this is a packaged app; using Podman`.
- The scratch checkout was deleted after the soak (no reparse point in it, checked before deletion).

## Isolation

The owner's Studio, agents and Podman containers ran on this machine throughout. Every process started here used:

| Setting | Value | Why |
|---|---|---|
| `ADF_USER_DATA_DIR`, `ADF_DAEMON_SETTINGS`, `ADF_LEASE_DIR`, `ADF_TEMP_DIR` | a run directory under `%TEMP%` | own settings, token, pid file, leases |
| `ADF_DAEMON_PORT` | 7495 (`MESH_PORT` 7496) | never 7385 |
| `ADF_KEYCHAIN=0`, `ADF_SECRET_STORE=file` | | no OS keychain. `ADF_TEST_KEYCHAIN_FILE` is a test seam and is refused in a packaged build like `ADF_COMPUTE=fake`, so the daemon ran without a keychain: its own runtime identity, file secret store (K12 path) |
| `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `TEMP`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME` | inside the run directory | no `~/.adf`, no CLI credentials |
| `CONTAINER_HOST=tcp://127.0.0.1:9` | | every Podman container command fails (`podman ps` exits 125), so `PodmanService.listContainers` returns nothing and a graceful `stopAll` stops nothing |
| Studio argument `--instance=w5b` | | `ADF_USER_DATA_DIR` moves Studio's own files but not Electron's `userData`: without `--instance` the single-instance lock and Chromium state are the real Studio's, and the second launch exits |
| Settings | mesh, LAN, update checks, remote catalogs, provider checks off | no network beyond loopback (the sandbox standard library still installs from npm on first boot) |

Podman containers named `adf-*` were listed (read-only, `podman ps`) before and after each run: the owner's containers were never stopped by these runs.

## Smoke (packaged Studio, local mode)

1. `studio-backend.json`: `mode: local`, `keepDaemonRunning: false`. Agent `agent-1` in a tracked folder, provider `openai-compatible` pointed at the parity harness's mock LLM (`tests/parity/harness/mock-llm.ts`, run standalone).
2. `ADF Studio.exe --instance=w5b --remote-debugging-port=9339`. Studio log: `ADF daemon running (pid 21040, 1.1s)`, `Started and attached … (version 0.7.8, started by studio)`, client session opened.
3. Through the window (DevTools protocol, DOM clicks and key events): clicked `agent-1` in the sidebar, typed "Hello from the W5-B packaged smoke test" in the Loops chat, pressed Enter. The agent started, the mock received the request, "Parity reply." appeared in the chat. The agent's 1-minute timer also fired a turn.
4. Closed the window. Studio: `Quit: client session ended; the ADF daemon is stopping: Studio started this daemon run and no other client session is open`. Daemon log: `Stop requested over HTTP — shutting down`, `Unloading 1 agent(s)`, `Stopping compute containers…`. Port 7495 free within 1 s.
5. `keepDaemonRunning: true`, launched again, closed the window: `the ADF daemon keeps running: the client asked to leave the daemon running (keepDaemonRunning on)`. The daemon (pid 22340) still listened; it was then killed with `taskkill /T /F`.

## Defender (K1)

- `Get-MpThreatDetection` and `Get-MpThreat` return nothing for a non-administrator on this machine; the Defender Operational log (events 1116/1117) is readable and was used instead.
- Before: the last detections are `Behavior:Win32/LummaStealer.CER!MTB` on `…\Programs\adf-studio\ADF Studio.exe` (2026-08-30, 09-01, 09-03, 09-04, 09-05) and on `repos\adf\node_modules\electron\dist\electron.exe` (2026-09-02, twice). None since 2026-09-05 09:45. Signature version 1.461.26.0.
- During and after the smoke and the soak (checked every 10 minutes and at the end): no 1116/1117 event, `Get-MpThreatDetection` empty.
- Caveat: since 2026-09-05 this machine has a Defender process exclusion for `ADF Studio.exe` and a path exclusion for the install folder. The packaged daemon is `ADF Studio.exe` too, so this run is not evidence that the false positive is gone. The WDSI submission (`bddcaae2-8ef1-4cb0-9344-f297327793a4`) and a signed build on a machine without exclusions are the real check.

## Soak

Setup: the packaged daemon spawned by the packaged Studio (local mode, `keepDaemonRunning: true`), 5 agents (`agent-1` … `agent-5`) on the mock LLM, each with an agent-scope interval timer of 60 s, all started through `POST /agents/:id/start`. Clients: the packaged Studio with `agent-1` open on its Loops tab, and `adf tui` (same commit, run from source in a pseudo-terminal, `--url http://127.0.0.1:7495 --no-daemon`). Both held client sessions for the whole run. Sampling: `GET /health` every 5 s (round-trip on loopback, the stand-in for event-loop lag: the daemon has no lag metric of its own); once a minute `Get-Process` for the daemon and Studio main, each agent's `/status`, the mock's request count, the TUI's output byte count.

| min | daemon RSS MB | daemon private MB | daemon handles | daemon threads | Studio main RSS MB | Studio handles | `/health` p50 / max ms | timer turns (cum.) | TUI bytes |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 210 | 225 | 347 | 20 | 191 | 1012 | 1.5 / 71.6 | 25 | 114619 |
| 5 | 213 | 227 | 352 | 20 | 190 | 1012 | 1.0 / 1.7 | 45 | 312551 |
| 10 | 215 | 229 | 347 | 20 | 190 | 1012 | 0.9 / 1.4 | 70 | 494699 |
| 15 | 203 | 217 | 351 | 20 | 190 | 1008 | 0.8 / 1.0 | 95 | 701869 |
| 20 | 206 | 220 | 351 | 20 | 190 | 1008 | 0.7 / 0.8 | 120 | 913360 |
| 25 | 211 | 225 | 351 | 20 | 191 | 1008 | 0.8 / 1.0 | 145 | 1118845 |
| 30 | 211 | 226 | 349 | 19 | 191 | 1012 | 0.8 / 25.1 | 170 | 1334090 |
| 35 | 210 | 225 | 351 | 20 | 190 | 1008 | 1.0 / 1.8 | 195 | 1559251 |
| 40 | 211 | 226 | 352 | 20 | 190 | 1012 | 0.9 / 1.3 | 220 | 1786499 |
| 45 | 209 | 223 | 351 | 20 | 190 | 1008 | 0.6 / 0.8 | 245 | 2013683 |
| 50 | 210 | 226 | 352 | 20 | 191 | 981 | 0.7 / 1.2 | 270 | 2239554 |
| 55 | 211 | 226 | 349 | 20 | 191 | 980 | 1.0 / 1.6 | 290 | 2475875 |
| 60 | 212 | 226 | 351 | 20 | 192 | 982 | 1.0 / 1.3 | 315 | 2705949 |
| 65 | 211 | 225 | 351 | 20 | 191 | 982 | 0.9 / 1.1 | 340 | 2926526 |
| 70 | 203 | 217 | 349 | 20 | 191 | 982 | 1.0 / 10.7 | 365 | 3154652 |
| 75 | 206 | 220 | 347 | 20 | 192 | 982 | 1.0 / 1.2 | 390 | 3381671 |

- 75 samples, 893 health probes, 0 failed, worst 71.6 ms (first minute, while agents started and the sandbox standard library installed); after that the worst was 25.1 ms.
- Daemon RSS 201-216 MB, trend over the second half -11.3 MB/h (no growth). Handles 347-356, threads 19-20. Studio main RSS 190-192 MB, handles 980-1012.
- One daemon pid and one Studio pid for the whole run: no restart, no crash. All 5 agents `idle` between turns at every sample, 159 loop entries each at the end; the mock received 395 model requests (390 timer turns, 5 startup turns).
- The minutes 0-12 overlap with a run of the parity suite in the scratch checkout (CPU contention); the numbers show no step at its end.
- The daemon log has one error line: the shared compute container did not start (see F1). Studio's chat for `agent-1` was current at the end (last entry 11:18 PM, the same as the daemon's loop).
- Every process was killed with `taskkill /T /F` at the end.

## Findings

- **F1. A packaged daemon cannot be kept away from Podman.** `ADF_COMPUTE=fake` is refused in packaged builds (correct), so the real `PodmanService` runs. With an isolated `USERPROFILE` Podman saw no machine, and starting the agents ran `[Compute] Initializing Podman machine (2 CPUs, 2048MB RAM)…`, then `podman machine start failed: … podman-machine-default: VM does not exist`. Nothing was created (no new WSL distribution; the owner's `podman-machine-default` kept running) and container commands were blocked by `CONTAINER_HOST`. On a machine where the init succeeds, an isolated test would create a VM. A packaged-safe "compute off" setting (agents use host MCP servers, `PodmanService` never constructed) would make packaged test runs safe; until then packaged runs MUST set `CONTAINER_HOST` to a dead address and SHOULD NOT isolate `USERPROFILE` on a machine where `podman machine init` would succeed.
- **F2. `ADF_USER_DATA_DIR` does not move Electron's `userData`.** A packaged Studio started with it alone still takes the real Studio's single-instance lock and Chromium profile. Packaged test runs MUST also pass `--instance=<name>`.
- **F3. `adf tui` from source starts a source daemon on 7385.** Run without `--url`/`--no-daemon` from a worktree, it started `adf daemon` from source on port 7385, and that runs `scripts/rebuild-for-node.mjs` on the shared `node_modules`. It did here (2026-10-14 21:59:52 local): the shared `better-sqlite3` was switched to the Node ABI for about four minutes, until `.abi-cache/better_sqlite3-abi143.node` was copied back (no rebuild). That source daemon used the isolated settings and the fake compute service and was killed with `taskkill /T /F`. Agent rule to add: a TUI or CLI started from a worktree MUST get `--no-daemon` (or `ADF_NO_AUTOSTART=1`) and an explicit `--url`.
- **F4.** Without an owner identity every Studio boot in local mode logs `adf:templates:list` failing with 409 `identity_not_ready` (main and renderer error lines). Noise only; the UI works.
- **F5.** First daemon boot installs the sandbox standard library from npm (about 10 packages). Expected; it is the only network use of an isolated run.

## Not covered

- 24 h soak (the owner's daily use is that run; record Defender events 1116/1117 and `%APPDATA%\ADF Studio\logs\adf-daemon.log` after it).
- Packaged macOS arm64 and Linux AppImage starts in local mode. CI builds both in `release.yml`; neither runs the smoke scenario.
- K11, macOS keychain prompts for the daemon process: needs a signed macOS build on a Mac. The CI parity job does not exercise it (the harness never reads the login keychain).
- A Windows machine without Defender exclusions.

## CI

`.github/workflows/ci.yml` job `daemon-parity` (windows-2022, ubuntu-latest, macos-14 best effort): `npm ci --ignore-scripts`, `node node_modules/electron/install.js` (the Electron binary), `npx electron-rebuild -f -o better-sqlite3` (Electron ABI), a load check of `better-sqlite3` under Electron-as-Node, `npm run build`, then `tests/parity` alone, under Electron-as-Node, with `PARITY_REQUIRE_DAEMON=1`. Daemon logs are uploaded on failure. The same recipe (with a full `npm ci`) passed locally in the clean checkout: 141 passed in 112 s.

## Installing the build for daily use (Windows)

1. Quit the installed Studio (File → Quit; this stops its containers as every quit does). If the scheduled task "ADF Studio Watchdog" exists, disable it until step 4, or it relaunches Studio during the install.
2. Run `%TEMP%\adf-w5b-dist\ADF Studio Setup 0.7.8.exe`. It is unsigned: SmartScreen asks; choose More info → Run anyway. It installs over the 0.7.8 release in `%LOCALAPPDATA%\Programs\adf-studio`, so the existing Defender exclusions still apply.
3. Start Studio, Settings → Backend → Local daemon, and confirm the switch (the handover moves client settings, ChatGPT/Grok sessions, MCP sign-ins and the runtime identity entry). Leave "Keep the daemon running when Studio quits" off unless agents should outlive Studio.
4. Turn off Settings → Privacy → "Check for updates": the build reports version 0.7.8, and the next GitHub release would be offered as an update over it. Re-enable the watchdog task if it was disabled.
5. Way back: Settings → Backend → Embedded, or start once with `ADF_STUDIO_BACKEND=embedded`; reinstalling the 0.7.8 release restores the released code.
