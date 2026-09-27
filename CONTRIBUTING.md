# Contributing to ADF

Thanks for your interest in contributing.

## Development setup

Requires Node.js 20 or higher.

```bash
git clone https://github.com/christianbalevski/adf.git
cd adf
npm install
npm run build
npm test
npm run dev      # launches the Studio
```

## Building for distribution

To build a packaged macOS app:

```bash
npm run package
```

The output is a universal `.dmg` in `dist/`. Code signing requires an Apple
Developer account; see `electron-builder.yml` for configuration.

## Pull requests

- Keep PRs focused on a single change.
- All tests must pass before merge.
- New behavior should include tests.
- Match the existing code style (TypeScript strict mode, no implicit any).

## Documentation and design-doc status

Documents under `docs/design/` describe proposals, and their status line is
load-bearing: both readers and coding agents use it to decide what exists.
Keep it accurate in the same change that makes it wrong.

- Shipped: `**Status: SHIPPED.**` followed by the file that implements it.
- Not shipped: `**Status:** Proposal · Not yet implemented`.
- Unsure: say unverified. Do not guess.

Never treat a design document as evidence that a feature exists. Three status
lines under `docs/design/` were wrong at the same time, two of them calling a
shipped feature a proposal, and that produced false claims in user-facing
documentation. Verify against `src/`.

The same rule applies to [docs/CAPABILITIES.md](docs/CAPABILITIES.md): every
claim there should trace to code, not to a proposal.

## DCO sign-off

All commits must be signed off under the
[Developer Certificate of Origin](https://developercertificate.org/).
This is a lightweight statement that you wrote the code or have the right to
contribute it under the project's license.

Add the sign-off automatically with:

```bash
git commit -s -m "your message"
```

This appends a `Signed-off-by:` line to your commit.

## Tests

Unit tests live in `tests/unit/` and run with `npm test`. Tests that depend
on external infrastructure (network relays, signing keys, third-party APIs)
should be placed under `tests/integration/` and excluded from the default
test run; document the credentials needed at the top of each integration
test file.

## Reporting bugs

Use the GitHub issue tracker. Include:
- ADF version
- Operating system
- Steps to reproduce
- Expected vs. actual behavior

## Security issues

See [SECURITY.md](SECURITY.md). Do not file public issues for security bugs.

## Questions

Use GitHub Discussions for general questions. Use issues for bugs and feature
requests.
