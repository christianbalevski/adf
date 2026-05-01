# ADF — Agent Document File

ADF is an open standard for portable AI agents. A single SQLite file
(`.adf`) contains a complete agent: identity, memory, instructions, tools,
and execution state. Move the file, you move the agent.

This repository contains the spec, the runtime daemon, the CLI, and the
desktop Studio — the reference implementation of ADF.

## What's in here

- **`ADF_SPEC_v0.4.md`** — the file format specification.
- **`src/main/`** — the runtime, daemon, CLI, providers, tools, mesh, and IPC.
- **`src/renderer/`** — the Electron Studio UI.
- **`docs/`** — guides for using ADF Studio and building agents.
- **`examples/`** — example agents and configurations.
- **`tests/`** — test suite.

## Quick start

Requires Node.js 20+.

```bash
git clone https://github.com/christianbalevski/adf.git
cd adf
npm install
npm run dev
```

This launches ADF Studio. From there you can create your first agent.

For the headless CLI:

```bash
npm run build
node dist/cli/index.js --help
```

## Documentation

- [Getting Started](docs/getting-started.md)
- [Core Concepts](docs/core-concepts.md)
- [The ADF spec](ADF_SPEC_v0.4.md)
- Full guide index in [`docs/`](docs/)

## Status

This is an early public release. The format and APIs may change. The
runtime, daemon, CLI, and Studio are all in active development under one
roof; expect ongoing structural changes as the codebase matures.

## License

MIT — see [LICENSE](LICENSE).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). All contributions require DCO
sign-off (`git commit -s`).

## Security

See [SECURITY.md](SECURITY.md) for vulnerability disclosure.

---

Created and maintained by Christian Balevski.
