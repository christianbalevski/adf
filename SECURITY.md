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
Argon2id), a code execution sandbox, and inter-agent message routing.
Vulnerabilities in any of these subsystems are taken seriously.

## Out of scope

- Issues in dependencies — please report those upstream.
- Theoretical attacks without a working proof of concept against the latest
  release.
