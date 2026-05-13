# ADF — Agent Document Format

ADF is an open standard for portable AI agents. A single SQLite file
(`.adf`) contains a complete agent: identity, memory, instructions, tools,
and execution state. Move the file, you move the agent.

This repository contains the spec, the runtime daemon, the CLI, and the
desktop Studio — the reference implementation of ADF.

## Why ADF

AI agents are starting to look less like apps and more like prosthetics
for thinking. They read on your behalf, write on your behalf, remember
things for you, and increasingly make decisions for you. An agent that
filters your information and shapes your conclusions is closer to your
mind than any tool we've built before — and right now, almost every
major one is owned by the platform that runs it. That's a fine model
for a search box. It's a worse model for something that thinks
alongside you.

I don't think any single technical decision solves that. But portability
is a precursor. The reason your photos in iCloud or Google Drive feel
like *yours* is that you can download them and walk away. The host is
a convenience; the file is the asset. If your agent can't move — if
its memory, its instructions, its conversation history are stuck
behind someone else's API — then whatever ownership you claim over it
is mostly rhetorical.

ADF started much smaller. The original idea was: what if a document
could come with its own agent attached? Ship them together — a working
document with an agent that knows the document's history and can act
on it. The first version was a zip with four files: an agent config, a
working document, the agent's private memory, and a chat log. SQLite
turned out to be the right substrate. Once a few agents existed as
portable files on the same machine, the next question — how do they
talk to each other? — pulled the project into territory I hadn't
planned on, including a small communication protocol for asynchronous,
sovereign agents that sits alongside the format.

The thesis I've ended up with: 
>ADF is less about what an agent can *do* and more about what an agent *is*. 

If "an agent" is a portable
file with a defined shape, then any runtime that conforms to the spec
can run it — the same way dozens of photo viewers can open a JPEG.

"What an agent *is*" was never meant to constrain "what an agent can *do*." A lot of work in the runtime has gone into the primitives, controls, and security gates an agent needs to be configurable in roughly any direction. The trade-off is that an ADF takes a bit more thought to configure up front — but because the result is a file, once you've configured an agent you like, replicating or sharing it is just copying the file.

I don't know whether ADF specifically becomes the standard people land
on. I do think it's a useful demonstration that an open, interoperable
primitive for AI agents is buildable, and that the alternative — every
agent permanently bound to the platform that birthed it — isn't the
only way this can go.

## What's in here

- **`ADF_SPEC_v0.1.md`** — the file format specification.
- **`ALF_SPEC_v0.1.md`** — the agent communication protocol specification.
- **`src/main/`** — the runtime, daemon, CLI, providers, tools, mesh, and IPC.
- **`src/renderer/`** — the Electron Studio UI.
- **`docs/`** — guides for using ADF Studio and building agents.
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
- [The ADF spec](ADF_SPEC_v0.1.md)
- [The ALF protocol spec](ALF_SPEC_v0.1.md)
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
