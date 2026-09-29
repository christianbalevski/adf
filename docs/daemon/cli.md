# ADF CLI

The ADF CLI docs moved to [docs/cli](../cli/index.md):

- [ADF CLI overview and install](../cli/index.md)
- [Getting started](../cli/getting-started.md)
- [Reference](../cli/reference.md): every command, flag and environment variable (generated from the code)
- [Identity and security](../cli/identity-and-security.md): `adf identity`, the daemon token
- [Remote daemon](../cli/remote-daemon.md)
- [Troubleshooting](../cli/troubleshooting.md)

## Background daemon

`adf daemon start | status | stop | restart | logs | token`: see
[Reference › Daemon](../cli/reference.md#daemon) and
[Troubleshooting](../cli/troubleshooting.md).

## Auth

`adf auth`, `adf auth login chatgpt|grok`, `adf auth logout`: see
[Models and providers](../cli/models-and-providers.md#chatgpt-and-grok-subscriptions)
and, for a remote daemon, [Sign in to ChatGPT](../cli/remote-daemon.md#sign-in-to-chatgpt).
