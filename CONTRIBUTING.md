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
