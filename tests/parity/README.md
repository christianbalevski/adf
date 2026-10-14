# Parity harness

The harness runs one renderer-side call sequence (a scenario) against a Studio backend and records what the renderer would see. It then compares the recording with a committed baseline and with other backends. It is how embedded mode and daemon mode are shown to be indistinguishable (design §12 item 2).

## Running

```
ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe node_modules/vitest/vitest.mjs run tests/parity
PARITY_RUNS=10 … run tests/parity        # every scenario 10 times; all runs MUST be identical
… run tests/parity -u                    # refresh recordings/ after reviewing the diff
```

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
| `scenarios/core.ts` | open, start, chat turn with a tool call |
| `recordings/*.embedded.txt` | Embedded baseline (golden form, rule G1) |

## What a recording contains

- Steps: each invoke with its arguments, its result and the push watermark when it started and when it resolved. `[pushes 0→17]` means the invoke resolved after 17 pushes, i.e. after its whole turn.
- Timelines: per agent, every push across channels in send order, interleaved with step start (`> n`) and resolve (`< n`) markers. App-level pushes (approvals, templates, …) appear in every agent's timeline, marked `[app]`; FILE_RENAMED appears in the timelines of both files.
- Pushes per channel, in order.
- Local calls: dialogs, shell, notifications, application menu, tray, badge, recent documents.
- LLM requests: model, stream flag, tool names, system prompt, messages.
- State once the scenario is done, before shutdown: file listing of the run root, every top-level JSON file in user data, and a table dump of every fixture `.adf`.

Push times are recorded as well, but they are used only by the streaming assertions and never written to a recording.

## Isolation and fences

Every run gets its own root for user data, leases, temp, home and app data. Inherited `ADF_*` variables are removed. `ADF_KEYCHAIN=0` and `ADF_SECRET_STORE=file` are set. A run fails when:

- `fence.cjs` refused something, in this process, a worker or a child process: a podman or wsl spawn (argv, shell line, `cmd /c`, `sh -c`), a TCP or UDP connection to a port other than the run's own loopback ports, port 7385, a non-loopback host, or a multicast join;
- `@napi-rs/keyring` was loaded;
- a real per-user file changed: settings, backend selection, daemon token and pid files, the lease registry, `~/.adf`, Claude or Codex credentials. A real Studio running on the same machine can write its own settings during a run and trip this check. Rerun when that happens;
- the backend pushed or called the model after the scenario said it was done (`quietMs`);
- a streamed text slice did not arrive as its own `text_delta_batch` within 300 ms;
- a file watcher or other handle opened during the run is still open after shutdown;
- code under test used an `electron` member the fake lacks.

The real `PodmanService` is never constructed. A graceful shutdown of the real one stops every running `adf-*` container on the machine.

The run root is deleted only when it contains no symlink or junction.

## Adding a scenario

Write a `ParityScenario` in your own file under `tests/parity/<domain>/`. Wait explicitly (`ctx.waitForPush`) for every push the flow produces. Set `quietMs`. Add a test that runs it against `embeddedBackend` and matches a recording, as `embedded.test.ts` does. If a value varies between two correct runs, add a rule to `normalize.ts` scoped as narrowly as possible, with a comment saying what it hides.

## Daemon backend (W2-C)

The in-process mode (`vi.doMock` stubs, the daemon in the test process, started from source) is a development loop only. The acceptance runs MUST use the built daemon bundle in a child process, because that is what Studio ships and runs.

A child-process `ParityBackend`:

1. Picks a free port P and calls `env.allowPort(P)`.
2. Spawns `node_modules/electron/dist/electron.exe` (Studio's binary) with `ELECTRON_RUN_AS_NODE=1`, `--require <abs>/tests/parity/harness/fence.cjs`, and the built entry `out/main/daemon.js` (W0-D; build it before the run). For the development loop the entry MAY be the source (`src/main/daemon/index.ts` through tsx) instead.
3. The child inherits the run's environment: `PARITY_FENCE_LOG`, `PARITY_FENCE_ROOT` and `PARITY_FENCE_PORTS` (the fence installs itself from these), and `NODE_OPTIONS=--require "<fence>"`, so the daemon's own children (MCP servers, the sandbox host) and their workers are fenced as well. It also gets `ADF_DAEMON_SETTINGS=<userData>/adf-settings.json`, `ADF_DAEMON_PIDFILE=<root>/daemon.pid`, the port P, and `ADF_TEST_SEAMS=1` with `ADF_COMPUTE=fake`. These are passed only to the spawn, never set on `process.env`.
4. `ADF_COMPUTE=fake` with `ADF_TEST_SEAMS=1` is the product seam from W1-G: the daemon uses a fake compute service instead of `PodmanService`. It MUST be honoured only when `ADF_TEST_SEAMS=1` is set and the app is not packaged.
5. Registers `registerDaemonModeHandlers` into the same `FakeElectron`, pointed at `http://127.0.0.1:P`.
6. `shutdown()` runs Studio's daemon-mode quit path (session end), then stops the daemon with `taskkill /T /F /PID <pid>` on Windows (a process-group SIGKILL elsewhere). Never `POST /daemon/shutdown`, `adf daemon stop` or another graceful stop.
7. `normalization()` returns `{ ports: [{ value: String(P), name: 'DAEMON_PORT' }] }` and any daemon-only ids that vary per run.
8. Violations from the child and its descendants land in `<root>/violations.log`, which `env.assertRealStateUntouched()` already reads.

Then `diffBackends(scenario, embeddedBackend, daemonBackend)` MUST return `''` for every scenario.

### State and shutdown

`runScenario` dumps the persisted state once the scenario is done and BEFORE shutdown (`state`, compared), and again after shutdown (`stateAfterShutdown`, raw only). Shutdown is where the modes legitimately differ: in daemon mode with `keepDaemonRunning` on, agents keep running after Studio quits, while embedded Studio stops them. W2-C compares shutdown per mode: the teardown pushes and `stateAfterShutdown` against the documented behaviour of that mode (§8.3), not against embedded.

### Reconnect scenario

Add a daemon-only scenario that kills the client SSE connection in the middle of a streamed turn (the mock LLM writes slices 200 ms apart, so there is time). After reconnect, the pushes MUST include the D6 resync set: `chat_updated` for the focused agent, `DOC_AGENT_CONFIG_CHANGED`, `TRACKED_DIRS_CHANGED`, an approvals snapshot, and the running-agent state batch. The final chat (`DOC_GET_CHAT`) and the persisted state MUST equal the embedded run of the same scenario without the kill.
