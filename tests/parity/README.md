# Parity harness

The harness runs one renderer-side call sequence (a scenario) against a Studio backend and records what the renderer would see. It then compares the recording with a committed baseline and with other backends. It is how embedded mode and daemon mode are shown to be indistinguishable (design §12 item 2).

## Running

```
ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe node_modules/vitest/vitest.mjs run tests/parity
PARITY_RUNS=10 … run tests/parity        # every scenario 10 times; all runs MUST be identical
… run tests/parity -u                    # refresh recordings/ after reviewing the diff
PARITY_SLICE_BOUND_MS=600 … run tests/parity   # a wider streaming bound on a loaded machine
```

The daemon-side suites (`daemon.test.ts`, `daemon-reconnect.test.ts`) need the built daemon bundle: `npx electron-vite build` first. Without `out/main/daemon.js` they are skipped, and the test report says so; `PARITY_REQUIRE_DAEMON=1` makes a missing bundle a failure. A bundle older than the newest file under `src/main` always fails. `PARITY_RUNS` applies to the daemon side too.

`npm test` also runs it, under plain Node on CI.

## Files

| File | Role |
|---|---|
| `harness/scenario.ts` | `ParityScenario`, `runScenario`, `diffBackends`, `streamingReport` |
| `harness/backend.ts` | `ParityBackend` / `BootedBackend`, `embeddedBackend`, module stubs |
| `harness/env.ts` | One isolated machine per run: directories, env, fingerprints, link-safe delete |
| `harness/fence.cjs` | Spawn and network fence, in process or as `-r fence.cjs` |
| `harness/fake-compute.ts` | `FakePodmanService`: a machine without Podman |
| `harness/electron-fake.ts` | Strict `electron` stand-in: captured `ipcMain`, recorded pushes and native calls |
| `harness/mock-llm.ts` | Scripted OpenAI-compatible model on loopback |
| `harness/fixtures.ts`, `identity.fixture.json` | Fixture agents, base settings, fixed owner/runtime identity |
| `harness/state-dump.ts` | `.adf` table dump, user-data JSON, file listing |
| `harness/recording.ts`, `format.ts` | Recording shape, per-agent timelines, text rendering, line diff |
| `harness/normalize.ts` | Every normalization rule, each with what it hides |
| `harness/daemon-backend.ts` | `daemonBackend()`: the built daemon in a fenced child process, Studio's daemon-mode handlers in this process; `switchToLocalMode()` |
| `harness/gaps.ts` | The daemon side's known differences: named, workstream-tagged transforms (the gap allowlist) |
| `scenarios/core.ts` | open, start, chat turn with a tool call |
| `recordings/*.embedded.txt` | Embedded baseline (golden form, rules G1 and G2) |
| `daemon-reconnect.test.ts` | Daemon killed under a connected Studio, restarted: not-connected state, reconnect, resync |
| `daemon-respawn.test.ts` | The daemon Studio started is killed: exit notice, Studio starts it again (`revivable`: its own connector, `DaemonProcessController.ensure` on the bundle, fenced), re-holds the open file, starts the agents again |

## What a recording contains

- Steps: each invoke with its arguments, its result and the push watermark when it started and when it resolved. `[pushes 0→17]` means the invoke resolved after 17 pushes, i.e. after its whole turn.
- Timelines: per agent, every push across channels in send order, interleaved with step start (`> n`) and resolve (`< n`) markers. App-level pushes (approvals, templates, …) appear in every agent's timeline, marked `[app]`; FILE_RENAMED appears in the timelines of both files.
- Pushes per channel, in order.
- Local calls: dialogs, shell, notifications, application menu, tray, badge, recent documents.
- LLM requests: model, stream flag, tool names, system prompt, messages.
- State once the scenario is done, before shutdown: file listing of the run root, every top-level JSON file in user data, and a table dump of every fixture `.adf`.

Push times are recorded as well, but they are used only by the streaming assertions and never written to a recording.

## Isolation and fences

Every run gets its own root for user data, leases, temp, home and app data. Inherited `ADF_*` variables are removed. `ADF_KEYCHAIN=0` and `ADF_SECRET_STORE=file` are set, and `ADF_MACHINE_ID` is a random id per run (lease records never wait on reg.exe or ioreg). A run fails when:

- `fence.cjs` refused something, in this process, a worker or a child process: a filesystem mutation outside fresh isolated directories, a native SQLite open/statement/backup outside them, an unfenced shell or non-Node executable, a podman or wsl spawn, a TCP or UDP connection to a port other than the run's own loopback ports, port 7385, a non-loopback host, or a multicast join;
- `@napi-rs/keyring` was loaded;
- a real per-user file changed: settings, backend selection, daemon token and pid files, the lease registry, `~/.adf`, Claude or Codex credentials. The only allowed ambient change is the existing compute-users heartbeat: an unchanged `hosts/<pid>.json` record belonging to an unrelated process alive before and after the run may advance its mtime. Its bytes, inode, permissions, owner and size must stay identical, and its link count must remain exactly one. New/deleted records, dead PIDs, content changes and every other fingerprint change still fail. A test-origin heartbeat is blocked and logged, even when its exception is caught;
- the backend pushed or called the model after the scenario said it was done (`quietMs`);
- a streamed text slice did not arrive as its own `text_delta_batch` within 300 ms;
- a file watcher or other handle opened during the run is still open after shutdown;
- code under test used an `electron` member the fake lacks.

A child process spawned with its own `env` object (a "clean env" child) gets the fence variables and `NODE_OPTIONS=--require fence.cjs` added to that env, so it is fenced too. A fenced child also refuses to load `@napi-rs/keyring`. The filesystem fence covers sync, callback, promises, streams and file descriptors; resolves symlink aliases; and patches the shared SQLite native addon so cached constructors and prepared statements are protected. Only the bundled sqlite-vec extension is allowed. Other SQL file escapes (`ATTACH`, `VACUUM INTO`, `load_extension`) are refused. Harness control directories are allocated through `env.createIsolatedDirectory`, which exposes only fresh directories rather than allowing arbitrary existing paths. On Windows a named pipe is allowed only when it is the lease endpoint of a record in the run's own lease registry (`<root>/leases/{hosts,clients}`).

Tolerant runs (`runScenario(s, backend, { tolerant: true })`) record a rejected invoke, a push that never comes (`wait-timeout` step) and the quiet-window and streaming problems (a `## problems` section) instead of throwing, so a candidate backend's remaining differences can be listed. The fences, the real-state check and leaks still throw. Only the daemon side uses it, until its dependencies land.

The real `PodmanService` is never constructed. A graceful shutdown of the real one stops every running `adf-*` container on the machine.

The run root is deleted only when it contains no symlink or junction.

## Adding a scenario

Write a `ParityScenario` in your own file under `tests/parity/<domain>/`. Wait explicitly (`ctx.waitForPush`) for every push the flow produces. Set `quietMs`. Add a test that runs it against `embeddedBackend` and matches a recording, as `embedded.test.ts` does. If a value varies between two correct runs, add a rule to `normalize.ts` scoped as narrowly as possible, with a comment saying what it hides.

## Daemon backend (W2-C)

The in-process mode (`vi.doMock` stubs, the daemon in the test process, started from source) is a development loop only. The acceptance runs use the built daemon bundle in a child process, because that is what Studio ships and runs. `daemonBackend()` (`harness/daemon-backend.ts`):

1. Picks a free port P and calls `env.allowPort(P)`.
2. `switchToLocalMode()` runs W4-A's real switch (`src/main/backend/handover.ts`, design §4.3, §5.3, §11) before Studio first attaches: the client keys MOVE from `adf-settings.json` into `studio-client-settings.json`, and the owner phrase plus the `studio-runtime:<scope>` entry are written to a plaintext test keychain file (`ADF_TEST_KEYCHAIN_FILE`), so the daemon adopts the fixture's runtime identity. The marker it leaves (`studio-handover.json`) is the `mode:handover-marker` entry.
3. Writes the sandbox standard-library manifest the embedded side's module stub stands for, and removes it once the daemon logged that it read it (module stubs do not reach the child; its real service would `npm install`).
4. Spawns `node_modules/electron/dist/electron.exe` with `ELECTRON_RUN_AS_NODE=1`, `--require <abs>/tests/parity/harness/fence.cjs` and `out/main/daemon.js`. The child inherits the run's environment (fence variables, `NODE_OPTIONS=--require "<fence>"`), plus `ADF_DAEMON_SETTINGS=<userData>/adf-settings.json`, the port, a per-run `ADF_DAEMON_TOKEN`, `ADF_TEST_SEAMS=1` with `ADF_COMPUTE=fake`, and the test keychain file; `ADF_KEYCHAIN` and `ADF_SECRET_STORE` are removed for the child only, so the test keychain file is the daemon's keychain, and the fence refuses the real keychain addon in the child. The pid file, the daemon log and the keychain file live in a separately allocated, write-fenced temp directory outside the run root. These variables are passed only to the spawn, never set on `process.env`.
5. `ADF_COMPUTE=fake` with `ADF_TEST_SEAMS=1` is the product seam from W1-G: the daemon uses a fake compute service instead of `PodmanService`.
6. Checks the child logged `[Compute] ADF_COMPUTE=fake` (else it is killed and the run fails), then registers `registerDaemonModeHandlers` into the same `FakeElectron`, pointed at `http://127.0.0.1:P`. A failure anywhere after the spawn kills the child (`finally`); a process-exit hook kills any child still alive.
7. `shutdown()` runs Studio's daemon-mode quit path (session end), then stops the daemon with `taskkill /T /F /PID <pid>` on Windows (a process-group SIGKILL elsewhere). Never `POST /daemon/shutdown`, `adf daemon stop` or another graceful stop. `killDaemon()` and `restartDaemon()` do the same mid-run (daemon-reconnect.test.ts).
8. `normalization()` names the daemon's port (`DAEMON_PORT`), pid and scratch root, and its port-named local-proof file.
9. Violations from the child and its descendants land in `<root>/violations.log`, which `env.assertRealStateUntouched()` already reads.

`daemon.test.ts` runs each core scenario against both backends and compares the recordings. The acceptance bar is no difference: `diffBackends(scenario, embeddedBackend, daemonBackend())` returning `''`. Until W2-A, W2-B and the bug fixes it names land, the daemon run is tolerant and every remaining difference is an entry of `harness/gaps.ts`: a transform scoped to one place, tagged with the workstream that removes it (or `mode` for a documented per-mode expectation), applied to the daemon side only. Each entry MUST match in every scenario it lists, so a fixed gap fails the test until its entry is removed, and nothing may be left after them; the list can only shrink. docs/design/daemon-backend-gaps.md "Parity diffs after W2-C" is generated from it (`gaps-doc.test.ts`). Tolerant runs record the streaming check as its category and slice counts only, never timing. `PARITY_DAEMON_LOG_DIR=<dir>` keeps a copy of each run's daemon log.

### State and shutdown

`runScenario` dumps the persisted state once the scenario is done and BEFORE shutdown (`state`, compared), and again after shutdown (`stateAfterShutdown`, raw only). Shutdown is where the modes legitimately differ: in daemon mode with `keepDaemonRunning` on, agents keep running after Studio quits, while embedded Studio stops them. W2-C compares shutdown per mode: the teardown pushes and `stateAfterShutdown` against the documented behaviour of that mode (§8.3), not against embedded.

### Reconnect

`daemon-reconnect.test.ts` kills the daemon child under a connected Studio: the Help menu shows the connection problem and "Reconnect to the ADF Daemon", one dialog says so, and a call fails with "Cannot reach daemon". A restarted daemon (a new epoch) is reconnected to by itself; the client stream reports `stream.gap`, the pushes include the D6 resync set the daemon can answer today (tracked directories, the approvals snapshot), and FILE_GET_CURRENT still names the open file. A second test drops the client stream in the middle of a streamed turn: the resume is exact, the chat message's turn settles, and the chat and the written file end as they would have. The resync's `chat_updated`, `DOC_AGENT_CONFIG_CHANGED` and running-agent batch are covered by tests/backend/daemon-mode-bridge.test.ts; a stream that LOSES frames mid-turn (the resync after an evicted cursor) is a `todo` pending W2-B's per-session ring.
