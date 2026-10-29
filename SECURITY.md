# Security Policy

## Reporting a Vulnerability

Please report security vulnerabilities privately through
[GitHub's private vulnerability reporting](https://github.com/christianbalevski/adf/security/advisories/new)
rather than opening a public issue.

We aim to acknowledge reports within 72 hours and to provide a fix or
mitigation plan within 90 days. Please give us a reasonable disclosure window
before publishing details.

## Scope

This project includes cryptographic identity (Ed25519, XChaCha20-Poly1305,
Argon2id), a code execution sandbox, inter-agent message routing, and daemon
access through native clients and Browser Studio. Authentication, pairing,
session handling, and the browser-to-daemon boundary are in scope.
Vulnerabilities in any of these subsystems are taken seriously.

## Daemon and browser access

Browser Studio is a trusted administrative client: an approved device can
control agents and execute code with the daemon user’s privileges. Local
launch uses a short-lived ticket minted with the host’s master token and local
proof; another device requires pairing and host approval. Browser sessions and
remembered device credentials use HttpOnly cookies. The browser never needs
the install’s master token pasted into a form. Sign-out clears browser access;
revoke a paired device on the host to invalidate its credential.

The daemon speaks HTTP. Browser launch does not enable remote access or set up
TLS; configure an encrypted transport for remote use. See [Studio in a
browser](docs/guides/studio-web.md), [daemon authentication](docs/daemon/http-api.md#authentication-and-cross-site-protection),
and [security architecture](docs/guides/security-architecture.md).

## Out of scope

- Issues in dependencies — please report those upstream.
- Theoretical attacks without a working proof of concept against the latest
  release.
