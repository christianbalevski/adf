# Owner Secret Storage

Where ADF Studio and the daemon keep the owner seed phrase and the keys around
it. Covers Linux desktops, headless servers, systemd, containers and WSL.
Task-level commands are in
[Identity and security](../cli/identity-and-security.md). The identity model
itself is in [Security and Identity](../guides/security-and-identity.md).

## What is stored, and where

| Secret | What it is | Daemon | Studio |
|---|---|---|---|
| Owner seed phrase | The 12-word BIP-39 phrase. It derives the owner identity and opens every owner keyslot | OS keychain entry `ADF` / `owner-mnemonic`, or the passphrase file `owner-secrets.json` | `ownerMnemonic` in `adf-settings.json`, encrypted with Electron `safeStorage` when available. Also mirrored into the keychain entry `ADF` / `owner-mnemonic` when one is usable |
| Owner signing and encryption keys | Ed25519 at `m/44'/0'/0'`, X25519 at `m/44'/0'/1'` | Not stored. Derived from the phrase when needed | Same |
| Daemon runtime signing key | The daemon's own runtime identity | The same store as the phrase, account `daemon-runtime-signing-key:<scope>` | n/a |
| Daemon runtime encryption key | X25519 key that opens runtime and trusted-daemon keyslots | `runtime-enc-key` next to the settings file. Plain JSON, mode 0600, not covered by the passphrase | n/a |
| Studio runtime keys | Studio's runtime signing and encryption keys | Read from keychain entry `studio-runtime:<scope>` when Studio shared it (Local mode) | `safeStorage` in `adf-settings.json` |
| Per-agent envelope keys | A random key per agent envelope, wrapped once per keyslot | Inside each `.adf`. Opened by Studio's runtime key, then the daemon's `runtime-enc-key`, then the owner key | Same |
| Provider API keys added through the daemon | `provider-api-key:<scope>:<id>` | Same store as the phrase | Read from the same keychain entry |

Sources: `src/main/services/owner-secret-store.ts`,
`src/main/daemon/daemon-identity.ts` (module comment, `DaemonIdentitySettings`),
`src/main/daemon/daemon-enc-key.ts`, `src/main/crypto/mnemonic-identity.ts`,
`src/main/services/settings.service.ts` (`setSecret`).

Envelope encryption covers an agent's `adf_identity` rows only: its private
signing key (`identity` envelope) and its credentials, such as channel tokens,
MCP keys and credential files (`credentials` envelope)
(`envelopeForPurpose` in `src/main/crypto/envelope-crypto.ts`). The rest of an
`.adf` file is plain SQLite. That includes loop transcripts, documents, files
and config ([what's inside](../../ADF_SPEC_v0.2.md#13-one-file-one-agent)).
Protect `.adf` files and their backups with file permissions or disk
encryption.

## How the daemon picks its store

At start the daemon chooses one backend and keeps it until it restarts
(`selectBackend` in `src/main/daemon/daemon-identity.ts`):

1. `ADF_SECRET_STORE=file`: the passphrase file.
2. `ADF_SECRET_STORE=keychain`: the keychain, or the daemon does not start
   ([Requiring the keychain](#requiring-the-keychain)).
3. `ADF_SECRET_STORE` set to any other value: the daemon does not start. An
   empty value counts as unset.
4. `ADF_KEYCHAIN=0` or `off`: the passphrase file.
5. Otherwise it reads the keychain once through `@napi-rs/keyring`. On Linux
   that reaches only the Secret Service API over D-Bus, never the kernel
   keyring. A successful read selects the keychain.
6. On Windows and macOS, a keychain that does not answer is retried twice,
   after 1 s and 4 s. If it still fails, the daemon uses the passphrase file
   and reports `keychainProblem`. While it runs that way, it refuses create,
   restore, import and trust-daemon with `409 keychain_unavailable`. Setting
   `ADF_SECRET_STORE=file` lifts the refusal.
7. On Linux, a read that fails for any reason (no Secret Service, no session
   bus, a locked keyring), or a missing native keyring binary, selects the
   passphrase file with no retry and no `keychainProblem`.

`adf identity` and `GET /identity` show the result in `storage`
(`keychain` or `file`).

### Requiring the keychain

With `ADF_SECRET_STORE=keychain`, the daemon reads the keychain with the
same tries as steps 5 to 7: once on Linux, up to three times over 5 s on
Windows and macOS. It does not start when:

- no read succeeds (no Secret Service, no session bus, a locked keyring, a
  keychain that does not answer);
- the native keyring binary does not load;
- `ADF_KEYCHAIN` is `0` or `off` as well.

The daemon then logs `[ADF Daemon] Owner secret store:` with the reason and
exits with code 1 before it listens. `adf daemon start` reports "The daemon
exited during startup (code 1)" and the end of the log.

On that path the daemon does not create, open or unlock `owner-secrets.json`,
also when `ADF_OWNER_PASSPHRASE` or `ADF_OWNER_PASSPHRASE_FILE` is set. A file
already there keeps its bytes. Nothing is copied between the keychain and the
file, and nothing is deleted.

Once the daemon runs on the keychain, it keeps it until it restarts. A
keychain read that fails later does not switch it to the file.

To start the daemon again, choose one:

- Make the keychain usable, then start the daemon. On Linux see
  [Linux desktop: Secret Service](#linux-desktop-secret-service). On macOS
  and Windows, sign in to the desktop session and unlock the keychain.
- Unset `ADF_KEYCHAIN` when it conflicts.
- Set `ADF_SECRET_STORE=file`, or unset it, to run on the passphrase file.

Switching stores does not move secrets. The keychain entries and
`owner-secrets.json` each keep what they hold, and the daemon reads only the
store it selected. If `owner-secrets.json` already exists, the file store
opens that file (with the boot passphrase or `adf identity unlock`) and its
owner. `adf identity` then shows `locked` while that file is not unlocked.
If the selected store has no owner phrase, `adf identity` shows `none` on a
fresh install and `restore-needed` when the settings already record an
owner. In both cases restore that owner there with `adf identity restore`
and its 12 words.
Provider API keys added through the daemon stay in the store they were
added to; add them again on the new store.

Rationale: a daemon that fell back to the file would keep new owner secrets
where Studio does not read them, and a boot passphrase would unlock an older
file that may belong to another owner.

## ADF Studio

Studio encrypts its own copy of the phrase with Electron `safeStorage`
(`SettingsService.setSecret`). On macOS that uses the Keychain, on Windows
DPAPI, and on Linux a Secret Service keyring. If `safeStorage` reports
encryption unavailable, Studio writes the phrase to `adf-settings.json` as
plain text. Settings → Identity then shows "The OS keychain is unavailable, so
the seed phrase is stored unencrypted in app settings."

On Linux with no keyring, Electron selects the `basic_text` backend, and
Studio does not call `safeStorage.setUsePlainTextEncryption`. In the Electron
release Studio is built with (40.10.6, `package-lock.json`),
`isEncryptionAvailable()` on Linux returns true only when Chromium has a key
from a real keyring, or when plain-text encryption was turned on with
`basic_text` ([`electron_api_safe_storage.cc` at v40.10.6](https://github.com/electron/electron/blob/v40.10.6/shell/browser/api/electron_api_safe_storage.cc);
Chromium 144 [`os_crypt_linux.cc`](https://github.com/chromium/chromium/blob/144.0.7559.236/components/os_crypt/sync/os_crypt_linux.cc)).
So under `basic_text` it returns false, and Studio writes the phrase as plain
text with that warning.

Studio has no passphrase file of its own. In Local mode, Studio starts the
daemon with its own settings file (`ADF_DAEMON_SETTINGS` set to Studio's
`adf-settings.json`), so the daemon's `owner-secrets.json` sits in Studio's
user data folder. Studio has no prompt for that file's passphrase. Unlock it
with `adf identity unlock` in a terminal on the same machine. A daemon that
Studio starts inherits Studio's environment, so `ADF_OWNER_PASSPHRASE_FILE`
set for Studio also reaches it (`src/main/backend/daemon-process.ts`).

## Linux desktop: Secret Service

A running, unlocked Secret Service provider, such as GNOME Keyring or
KWallet, gives Studio and the daemon a keychain. Both then share `ADF` /
`owner-mnemonic`. Nothing ADF-specific has to be unlocked after a restart.
The keyring itself does: it is locked at every boot until your desktop login
(or you) unlocks it.

### GNOME Keyring (Debian, Ubuntu)

```bash
sudo apt install gnome-keyring libpam-gnome-keyring libsecret-tools dbus-user-session
```

- `gnome-keyring`: the Secret Service daemon.
- `libpam-gnome-keyring`: unlocks the `login` keyring with the password you
  log in with
  ([GNOME Keyring PAM](https://wiki.gnome.org/Projects/GnomeKeyring/Pam)).
  If the keyring password differs from your login password, or you log in
  automatically without typing a password, the keyring stays locked after
  login.
- `libsecret-tools`: `secret-tool`, used for the check below.
- `dbus-user-session`: one session bus per user, shared by the graphical
  login, SSH sessions and `systemctl --user` units
  ([package](https://packages.debian.org/stable/dbus-user-session)).

Log out and back in, then check with a throwaway value, never a real secret:

```bash
printf 'not-a-secret' | secret-tool store --label='ADF keyring check' adf-check probe
secret-tool lookup adf-check probe     # prints: not-a-secret
secret-tool clear adf-check probe
```

`secret-tool` uses the same Secret Service API over the same session bus as
ADF ([secret-tool(1)](https://manpages.debian.org/stable/libsecret-tools/secret-tool.1.en.html)).
Then restart the daemon in that session, so it probes again, and confirm:

```bash
adf daemon restart
adf identity          # storage keychain
```

### KWallet (KDE)

KWallet provides the Secret Service API from KDE Frameworks 5.97 on
([announcement](https://kde.org/announcements/frameworks/5/5.97.0/)). In the
5.97 source it is on unless `apiEnabled=false` is set in the
`[org.freedesktop.secrets]` group of `~/.config/kwalletrc`. From Frameworks
6.14 KDE is moving the service to `ksecretd`
([announcement](https://kde.org/announcements/frameworks/6/6.14.0/)).
Distributions package and configure this differently, so check your release
rather than assuming. Use the same `secret-tool` check as above, with
`libsecret-tools` (or your distribution's package for `secret-tool`)
installed, and then `adf identity`. The wallet must be open, and PAM
unlocking of KWallet (`pam_kwallet`) is configured per distribution.

### What to check

- The keyring MUST be running and unlocked in the D-Bus session the process
  sees. A system service has no session bus. Without `dbus-user-session`,
  SSH logins and cron jobs usually have their own bus or none. With it they
  share the user's bus, but the keyring may still be locked when no desktop
  login has unlocked it.
- When the daemon's probe fails, the daemon uses the passphrase file, with
  no retry and no warning on Linux. A phrase created or restored then goes
  into that file, not the keyring Studio reads. If this machine already has
  an owner, `adf identity` shows `restore-needed` instead of `ready`. Check
  `storage` before you create or restore an owner, and restart the daemon
  once the keyring is unlocked.
- Use the passphrase file for a systemd system unit.

## The passphrase file

`owner-secrets.json` sits next to the daemon's settings file. It is one JSON
record with mode 0600 (`FileSecretBackend` in
`src/main/services/owner-secret-store.ts`):

- The key is derived from your passphrase with scrypt (N=2^15, r=8, p=1, a
  random 16-byte salt). All stored values are sealed as one AES-256-GCM blob.
  A sealed check value detects a wrong passphrase.
- The passphrase must be at least 8 characters when the file is created.
- It holds the owner phrase, the daemon's runtime signing key, provider API
  keys added through the daemon, and app-level MCP sign-ins.
- It does not hold `runtime-enc-key`, `daemon-token` or `adf-settings.json`.
- There is no command or route that changes the passphrase.

The file starts locked at every daemon start. Unlock it in one of these
ways:

| How | Notes |
|---|---|
| `adf identity unlock` | Prompts for the passphrase on the daemon's machine. Loopback only |
| `POST /identity/unlock {"passphrase": …}` | The same over HTTP. Loopback only |
| `ADF_OWNER_PASSPHRASE_FILE=<path>` in the daemon's environment | Read once at start. Uses the first line of the file, with the line ending removed and nothing else trimmed. An empty first line counts as unset. A read error is logged and the identity stays locked |
| `ADF_OWNER_PASSPHRASE=<value>` in the daemon's environment | Takes precedence over `_FILE` when both are set. Visible to anything that can read the process environment, so prefer `_FILE` |

Source: `readBootPassphrase` and the `DaemonIdentity` constructor in
`src/main/daemon/daemon-identity.ts`, wired in `src/main/daemon/index.ts`.

- Boot unlock only opens an existing file. On a first start, before any
  owner exists, the boot passphrase does nothing. It does not create the
  file.
- Create and restore use the boot passphrase only when the request carries
  none (`openFileBackend`: `passphrase || bootPassphrase`). The CLI always
  asks for a passphrase on a fresh file-storage daemon and sends what you
  type. The file is sealed with what you typed, even if the daemon also
  has `ADF_OWNER_PASSPHRASE_FILE`. If the two differ, nothing complains until
  the next restart. The log then says
  `Owner identity stays locked: wrong passphrase in ADF_OWNER_PASSPHRASE`
  (the same wording for `_FILE`), and `adf identity` shows `locked`.
- A failed boot unlock does not stop the daemon. A locked owner does not
  lock every agent. On load the daemon tries, in order: Studio's runtime key
  when it uses Studio's runtime identity, then its own `runtime-enc-key`
  (agents it created, and trusted-daemon slots), then the owner key
  (`unlockWithLocalRuntimeKeys`, `unlockWorkspaceEnvelopes` and
  `workspaceHooks` in `src/main/daemon/daemon-identity.ts`). An agent whose envelopes still stay
  sealed loads `degraded` (`CREDENTIALS_LOCKED`, `src/main/runtime/runtime-service.ts`)
  and recovers in place once you unlock. While the owner is locked, the
  daemon refuses to create new agents.
- `adf identity lock` (`POST /identity/lock`) locks the file until the next
  unlock or restart. The boot passphrase is not applied again until the
  daemon restarts.

The daemon removes `ADF_DAEMON_TOKEN` and every `ADF_OWNER_PASSPHRASE*`
variable from the environment of MCP server processes and their sign-in
preflights (`src/main/utils/child-env.ts`). That is the only place the code
strips them. The passphrase file itself stays readable by the daemon's OS
user, as does `owner-secrets.json`.

### What the passphrase protects

The passphrase protects `owner-secrets.json` at rest: a copied disk, a backup
or a stolen file. It does not protect against code running as the daemon's OS
user, or as root, on a live host:

- The unlocked phrase is in the daemon's memory.
- The boot passphrase source (environment, file or systemd credential) is
  readable by that user.
- `runtime-enc-key` is a plain key file. It opens the runtime keyslots of
  agents the daemon created and, once the owner trusts it
  (`adf identity trust-daemon`), the credentials of agents made in Studio,
  with no owner passphrase.
- The daemon access token lets its holder run commands as the daemon's user
  ([Identity and security](../cli/identity-and-security.md#daemon-access-token)).

Treat a host compromise as exposure of the owner phrase.

## Setting up a server

1. Choose the service account and a dedicated settings file. Set
   `ADF_DAEMON_SETTINGS` and set `ADF_SECRET_STORE=file`, so a keychain found
   later does not change the store.
2. Create the passphrase source (systemd, container or cloud examples below).
   The value never appears on a command line.
3. Start the daemon under the service manager with
   `ADF_OWNER_PASSPHRASE_FILE` pointing at it.
4. As the service user, with the same `ADF_DAEMON_SETTINGS` and
   `ADF_NO_AUTOSTART=1`, run `adf identity new` (or `adf identity restore`).
   This makes sure the CLI talks to the service rather than starting a second
   daemon. At "Choose a passphrase", type exactly the passphrase in the
   source file. To create the owner without typing it, use the empty-body
   `POST /identity/create` shown under [systemd](#systemd).
5. Write the 12 words down offline and confirm with `yes`. The daemon never
   shows them again, and Studio reveals a phrase only from its own copy or the
   shared keychain entry, neither of which exists on such a server.
6. Restart the service and run `adf identity`. It must show `ready` with
   `storage file`. If it shows `locked`, the file and the typed passphrase
   differ. Run `adf identity unlock` with the passphrase you typed, then fix
   the source file to match.

Over HTTP, `POST /identity/create` with no `passphrase` field seals the new
file with the boot passphrase. Use this only from a loopback client that does
not log response bodies: the response carries the phrase once.
`POST /identity/confirm-backup` then records that the words are written down.

The seed phrase goes into the daemon through one of these:

- the hidden prompt of `adf identity restore` or `adf identity import`
- the same commands with stdin piped, see below
- `POST /identity/restore` or `POST /identity/import` from a loopback caller
- Studio's Import identity

No environment variable, flag, file or file descriptor supplies it
([Not supported](#not-supported)). Do not put the phrase in a unit file,
image, container environment, command line or CI log.

When stdin is not a terminal, the CLI reads its stdin once and answers each
prompt with the next line (`defaultPrompt` in `src/main/cli/index.ts`). For
`adf identity restore` the lines are:

1. the seed phrase
2. the passphrase, when `adf identity` reports `passphraseRequired`
3. the passphrase again, when the passphrase file does not exist yet

Whatever feeds the pipe holds the phrase in plain text: a file, a here-string
saved in shell history, or a CI variable. Prefer the prompt.

### systemd

`LoadCredential=` (systemd 247+) copies a file into the service's
credentials directory. The copy is read-only, kept in non-swappable memory
where possible, readable only by the unit's user and root, and removed when
the service stops. The `%d` specifier (systemd 251+) expands to that
directory. ADF has no systemd integration. It reads an ordinary file path,
so `ADF_OWNER_PASSPHRASE_FILE=%d/<name>` is all it needs.

Prerequisites, as root:

```bash
# Node.js 22 or newer from your distribution or vendor, installed system-wide.
node --version
npm i -g @agentdocumentformat/cli
# The service account. The unit's StateDirectory= creates /var/lib/adf for it.
useradd --system --home-dir /var/lib/adf --shell /usr/sbin/nologin adf
# Absolute paths for ExecStart=. The adf script starts with `#!/usr/bin/env node`,
# so name node explicitly rather than depending on the service's PATH.
command -v node
readlink -f "$(command -v adf)"
```

A Node.js installed under one user's home (nvm, fnm, volta) is not readable
by the `adf` account. Use a system-wide install.

Create the passphrase source file. The value never reaches a command line or
shell history (`read` and `printf` are bash builtins):

```bash
sudo install -d -m 0700 /etc/adf
sudo bash -c 'umask 077; IFS= read -r -s -p "Owner passphrase: " p; echo; printf "%s\n" "$p" > /etc/adf/owner-passphrase'
```

The unit, with the two paths printed above in `ExecStart=`:

```ini
# /etc/systemd/system/adf-daemon.service
[Unit]
Description=ADF daemon
After=network-online.target
Wants=network-online.target

[Service]
User=adf
StateDirectory=adf
StateDirectoryMode=0700
Environment=HOME=/var/lib/adf
Environment=ADF_DAEMON_SETTINGS=/var/lib/adf/adf-settings.json
Environment=ADF_SECRET_STORE=file
LoadCredential=adf-owner-passphrase:/etc/adf/owner-passphrase
Environment=ADF_OWNER_PASSPHRASE_FILE=%d/adf-owner-passphrase
ExecStart=<path of node> <path of adf.mjs> daemon
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now adf-daemon
```

Create the owner. Both ways below talk to the service on `127.0.0.1:7385`
as the `adf` user, and `ADF_NO_AUTOSTART=1` keeps the CLI from starting a
second daemon.

- Interactive: `adf identity new` asks you to choose a passphrase. Type the
  one in `/etc/adf/owner-passphrase`. The file is sealed with what you type.

  ```bash
  sudo -u adf -H env ADF_DAEMON_SETTINGS=/var/lib/adf/adf-settings.json ADF_NO_AUTOSTART=1 adf identity new
  ```

- Without typing the passphrase (needs `curl` and `jq`): `POST /identity/create` with an empty body
  seals the new file with the boot passphrase the daemon already read from
  the credential (`openFileBackend` in `src/main/daemon/daemon-identity.ts`).
  The access token goes to `curl` on stdin (`-K -`), so it stays off the
  command line. The 12 words print once, on your terminal. Run this in a
  terminal that is not being recorded, and write the words down.

  ```bash
  sudo -u adf -H bash -c 'printf "header = \"Authorization: Bearer %s\"\n" "$(cat /var/lib/adf/daemon-token)" | curl -sS -K - -X POST -H "Content-Type: application/json" -d "{}" http://127.0.0.1:7385/identity/create' \
    | jq -r 'if .words then (.words | join(" ")) else "error: \(.error)" end'
  ```

  Once the words are written down, record the backup the same way:

  ```bash
  sudo -u adf -H bash -c 'printf "header = \"Authorization: Bearer %s\"\n" "$(cat /var/lib/adf/daemon-token)" | curl -sS -K - -X POST -H "Content-Type: application/json" -d "{}" http://127.0.0.1:7385/identity/confirm-backup' \
    | jq -r '.identity.backupConfirmed // .error'
  ```

  To restore an existing owner instead, `adf identity restore` asks for
  the seed phrase and, while the passphrase file is not unlocked, for a
  passphrase. Type the one in the credential. Over HTTP, `POST /identity/restore` needs the `mnemonic` in
  the body, and may leave out `passphrase`; the daemon then uses the boot
  passphrase, as for create. Nothing supplies the seed phrase by itself
  ([Not supported](#not-supported)).

Then check that the boot unlock works:

```bash
sudo systemctl restart adf-daemon
sudo -u adf -H env ADF_DAEMON_SETTINGS=/var/lib/adf/adf-settings.json ADF_NO_AUTOSTART=1 adf identity
```

It must show `ready` and `storage file`.

- With `LoadCredential=`, the source file in `/etc/adf` stays plain text on
  disk. Root and anything that can read it there can read the passphrase.
- `LoadCredentialEncrypted=` (systemd 250+) keeps the source encrypted
  (`systemd-creds encrypt`). With the default key choice (`--with-key=auto`),
  systemd uses the TPM2 when it finds one (outside a container) and the host
  key `/var/lib/systemd/credential.secret` when `/var/lib/systemd` is on
  persistent storage, usually both. If neither applies, encryption fails.
  Such a credential decrypts only on this host, or with this TPM.
  Moving the server or restoring it to new hardware then needs the plain
  passphrase again, so keep it with your offline records. Other `--with-key=`
  modes behave differently; see
  [systemd-creds(1)](https://www.freedesktop.org/software/systemd/man/latest/systemd-creds.html).

  To switch an existing service, do the steps in order, and stop at the
  first one that fails. Keep `/etc/adf/owner-passphrase` until the last
  step.

  1. Encrypt, then check that the credential decrypts to the same bytes. The
     decrypted value goes only into `cmp`, never to the terminal:

     ```bash
     sudo install -d -m 0700 /etc/credstore.encrypted
     sudo systemd-creds encrypt --name=adf-owner-passphrase /etc/adf/owner-passphrase /etc/credstore.encrypted/adf-owner-passphrase \
       && sudo systemd-creds decrypt --name=adf-owner-passphrase /etc/credstore.encrypted/adf-owner-passphrase - \
          | sudo cmp -s - /etc/adf/owner-passphrase \
       && echo "encrypted credential matches"
     ```

     Go on only if it prints `encrypted credential matches`.

  2. In the unit, replace the `LoadCredential=` line with this one. Do not
     keep both lines for the same credential name:

     ```ini
     LoadCredentialEncrypted=adf-owner-passphrase:/etc/credstore.encrypted/adf-owner-passphrase
     Environment=ADF_OWNER_PASSPHRASE_FILE=%d/adf-owner-passphrase
     ```

  3. Reload, restart and verify:

     ```bash
     sudo systemctl daemon-reload
     sudo systemctl restart adf-daemon
     systemctl cat adf-daemon | grep '^LoadCredential'   # only the LoadCredentialEncrypted= line
     sudo -u adf -H env ADF_DAEMON_SETTINGS=/var/lib/adf/adf-settings.json ADF_NO_AUTOSTART=1 adf identity
     ```

     It must show `ready` and `storage file`. If it does not, put the
     `LoadCredential=` line back and restart. The plain source is still
     there.

  4. Optional, only after step 3 succeeded and the passphrase is in your
     offline records: remove the plain source with
     `sudo rm /etc/adf/owner-passphrase`. Deleting a file does not erase its
     blocks, and `shred` cannot promise erasure on journaling or
     copy-on-write file systems, or on SSDs. Where that matters, write the
     passphrase straight into `systemd-creds encrypt` (it reads `-` as stdin)
     on a new setup, instead of creating a plain file first.

- A user unit (`systemctl --user`) can use `LoadCredential=`, and `%d`
  resolves there too. Encrypted credentials for user units need
  `systemd-creds encrypt --user` (systemd 256+).
- Do not put the passphrase in `Environment=`. `systemctl show` displays it,
  and systemd.exec(5) advises against environment variables for secrets.

References:
[systemd.exec(5) Credentials](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html#Credentials),
[systemd.unit(5) Specifiers](https://www.freedesktop.org/software/systemd/man/latest/systemd.unit.html#Specifiers),
[systemd-creds(1)](https://www.freedesktop.org/software/systemd/man/latest/systemd-creds.html),
[System and Service Credentials](https://systemd.io/CREDENTIALS/).

### Containers

Mount the passphrase as a file, and point `ADF_OWNER_PASSPHRASE_FILE` at it.
Put the settings folder (`adf-settings.json`, `owner-secrets.json`,
`runtime-enc-key`, `daemon-token`) on a persistent volume. ADF publishes no
container image. These fragments assume an image you build with Node.js 22+
and `@agentdocumentformat/cli`, running as a non-root user (uid 10001 here)
that owns `/data`.

Docker, with the passphrase file created as in [systemd](#systemd) and
handed to the container's uid:

```bash
sudo chown 10001:10001 /etc/adf/owner-passphrase
sudo chmod 0400 /etc/adf/owner-passphrase
docker run -d --name adf --user 10001:10001 \
  -e ADF_DAEMON_SETTINGS=/data/adf-settings.json \
  -e ADF_SECRET_STORE=file \
  -e ADF_OWNER_PASSPHRASE_FILE=/run/secrets/adf_owner_passphrase \
  -v /etc/adf/owner-passphrase:/run/secrets/adf_owner_passphrase:ro \
  -v adf-data:/data \
  <your image> adf daemon
docker exec -it -e ADF_NO_AUTOSTART=1 adf adf identity new
```

- A bind-mounted file keeps its host owner and mode. The container user
  must be able to read it, and nobody else on the host should be able to.
- A new named volume takes the owner of the image's `/data`. If the image
  does not create `/data` owned by uid 10001, the daemon cannot write its
  settings.
- `docker exec` runs inside the container, so the identity routes see a
  loopback caller. The exec inherits the container's `ADF_DAEMON_SETTINGS`,
  so the CLI finds the daemon and its token.

Docker Compose, the same thing as a file secret:

```yaml
# compose.yaml (fragment)
services:
  adf:
    image: <your image>
    user: "10001:10001"
    command: ["adf", "daemon"]
    environment:
      ADF_DAEMON_SETTINGS: /data/adf-settings.json
      ADF_SECRET_STORE: file
      ADF_OWNER_PASSPHRASE_FILE: /run/secrets/adf_owner_passphrase
    secrets: [adf_owner_passphrase]
    volumes: ["adf-data:/data"]
secrets:
  adf_owner_passphrase:
    file: /etc/adf/owner-passphrase
volumes:
  adf-data: {}
```

- Compose delivers a `file:` secret as a bind mount of the host file. The
  host file is plain text, and its host owner and mode apply. Compose
  ignores the `uid`, `gid` and `mode` options for a `file:` source
  ([Compose file reference](https://docs.docker.com/reference/compose-file/services/#secrets)).
  Set ownership on the host as in the `docker run` example.
- Docker Swarm secrets are encrypted in the Swarm Raft log and mounted in
  memory, for swarm services only
  ([Swarm secrets](https://docs.docker.com/engine/swarm/secrets/)).

Kubernetes, with a Secret mounted as a volume:

```bash
# From the file, so the value is not on the command line.
kubectl create secret generic adf-owner-passphrase --from-file=passphrase=./owner-passphrase
```

```yaml
# Pod spec: the StatefulSet's spec.template.spec (fragment)
spec:
  securityContext:
    runAsNonRoot: true
    runAsUser: 10001
    runAsGroup: 10001
    fsGroup: 10001
  containers:
    - name: adf
      image: <your image>
      command: ["adf", "daemon"]
      env:
        - { name: ADF_DAEMON_SETTINGS, value: /data/adf-settings.json }
        - { name: ADF_SECRET_STORE, value: file }
        - { name: ADF_OWNER_PASSPHRASE_FILE, value: /run/secrets/adf/passphrase }
      volumeMounts:
        - { name: data, mountPath: /data }
        - { name: owner-passphrase, mountPath: /run/secrets/adf, readOnly: true }
  volumes:
    - name: owner-passphrase
      secret:
        secretName: adf-owner-passphrase
        defaultMode: 0440
# plus, in the StatefulSet spec, volumeClaimTemplates with an entry named "data"
```

With the Secrets Store CSI Driver, replace the `secret` volume. The file
name under the mount comes from the `SecretProviderClass`, and its
parameters depend on the provider (links under
[Cloud secret managers](#cloud-secret-managers)):

```yaml
    - name: owner-passphrase
      csi:
        driver: secrets-store.csi.k8s.io
        readOnly: true
        volumeAttributes:
          secretProviderClass: adf-owner-passphrase
```

- Kubernetes Secrets are stored unencrypted in etcd unless the cluster
  configures
  [encryption at rest](https://kubernetes.io/docs/tasks/administer-cluster/encrypt-data/).
  A Secret volume is tmpfs on the node
  ([Secrets](https://kubernetes.io/docs/concepts/configuration/secret/)).
  Use a volume, not `env` / `secretKeyRef`.
- RBAC: grant `get`, `list` and `watch` on `secrets` in the namespace only
  to the accounts that need them
  ([good practices for Secrets](https://kubernetes.io/docs/concepts/security/secrets-good-practices/)).
  `pods/exec` into the ADF pod reads the mounted passphrase and
  `owner-secrets.json` on the volume, so treat it as access to the owner
  phrase. The same goes for creating pods that mount that Secret, or for
  reading the volume.
- Create or restore the owner inside the running container, against its
  loopback address: `kubectl exec -it <pod> -- env ADF_NO_AUTOSTART=1 adf identity new`.
  Identity routes answer loopback callers only.

### Cloud secret managers

ADF does not call any cloud secret manager. Use the platform to write the
passphrase to a file, and set `ADF_OWNER_PASSPHRASE_FILE` to that path.
Examples: the
[Secrets Store CSI Driver](https://secrets-store-csi-driver.sigs.k8s.io/)
with the
[Google Secret Manager](https://github.com/GoogleCloudPlatform/secrets-store-csi-driver-provider-gcp),
[AWS Secrets Manager](https://docs.aws.amazon.com/secretsmanager/latest/userguide/integrating_csi_driver.html)
or
[Azure Key Vault](https://learn.microsoft.com/en-us/azure/aks/csi-secrets-store-driver)
providers, authenticated with workload identity
([GKE](https://cloud.google.com/kubernetes-engine/docs/concepts/workload-identity),
[EKS IRSA](https://docs.aws.amazon.com/eks/latest/userguide/iam-roles-for-service-accounts.html)
or [Pod Identity](https://docs.aws.amazon.com/eks/latest/userguide/pod-identities.html),
[AKS](https://learn.microsoft.com/en-us/azure/aks/workload-identity-overview)).
On a VM, a startup step or agent can fetch the secret into a 0600 file or a
systemd credential.

HashiCorp Vault works the same way: Vault Agent renders the secret to a file
([Vault Agent templates](https://developer.hashicorp.com/vault/docs/agent-and-proxy/agent/template)).
A fragment of the agent configuration, for a KV v2 secret with a
`passphrase` field:

```hcl
template {
  contents    = "{{ with secret \"secret/data/adf/owner\" }}{{ .Data.data.passphrase }}{{ end }}"
  destination = "/run/adf/owner-passphrase"
  perms       = "0400"
}
```

Run the agent as the daemon's user, or have it write where the daemon's user
can read, and set `ADF_OWNER_PASSPHRASE_FILE=/run/adf/owner-passphrase`. On
Kubernetes, the
[Vault Agent Injector](https://developer.hashicorp.com/vault/docs/deploy/kubernetes/injector)
writes it to `/vault/secrets/<name>` from the pod annotations
`vault.hashicorp.com/agent-inject-secret-<name>` and
`vault.hashicorp.com/agent-inject-template-<name>`.

- The daemon reads the file once, at start. A rotated secret takes effect at
  the next restart, and only if it still matches `owner-secrets.json`.
- There is no command that re-seals the file under a new passphrase.

## WSL

- WSL distributions usually have no running Secret Service, and Linux
  processes cannot reach the Windows Credential Manager. A daemon in WSL
  normally uses the passphrase file. Check `storage` with `adf identity`.
- A Windows Studio and a daemon inside WSL use different settings folders and
  different secret stores. They are separate runtimes. Restore the same
  phrase in each to be the same owner, or keep a separate owner for WSL.
- systemd in WSL requires WSL 0.67.6 or later and `[boot] systemd=true` in
  `/etc/wsl.conf`
  ([Microsoft: systemd in WSL](https://learn.microsoft.com/en-us/windows/wsl/systemd)).
  systemd services do not keep the WSL instance running. When WSL shuts the
  distribution down, the daemon stops. At its next start it unlocks from
  `ADF_OWNER_PASSPHRASE_FILE`, or waits for `adf identity unlock`.
- Running GNOME Keyring under WSL needs a D-Bus session and an unlocked
  keyring, and there is no login screen to unlock it. The passphrase file is
  the simpler choice there.

## Not supported

ADF has none of the following. Each item gives the way that works today, if
there is one.

| Not supported | What works today |
|---|---|
| Seed phrase from an environment variable, a file, a file descriptor or a secret manager | The prompt, piped stdin, or the loopback restore and import routes ([Setting up a server](#setting-up-a-server)) |
| Passphrase from a file descriptor, a socket or an askpass command | `ADF_OWNER_PASSPHRASE_FILE` (an ordinary file path, including a systemd credential via `%d`) or `ADF_OWNER_PASSPHRASE` |
| Native systemd credential support (reading `$CREDENTIALS_DIRECTORY` by itself) | `ADF_OWNER_PASSPHRASE_FILE=%d/<name>` |
| Native Vault, cloud secret manager or KMS client | An external agent or CSI driver writes the passphrase to a file |
| Changing the passphrase, or re-sealing `owner-secrets.json` | None |
| A check, at create or restore time, that the typed passphrase matches the boot passphrase | Restart and check `adf identity` (step 6 of [Setting up a server](#setting-up-a-server)) |
| A passphrase-file store for Studio's own copy of the phrase | Studio uses `safeStorage`, or plain text with a warning when no keyring is available |
| Encrypting Studio's copy on Linux without a keyring (`basic_text`) | Run a Secret Service keyring ([Linux desktop](#linux-desktop-secret-service)) |
| A Studio prompt to unlock the daemon's passphrase file in Local mode | `adf identity unlock` in a terminal |
| Reading the daemon's passphrase-file phrase back out | None. Keep the offline copy of the 12 words |

## Recommendations

- Back up the 12 words offline, on paper or in a password manager that is
  not on the server. They recover the owner and every owner keyslot. Without
  them, losing `owner-secrets.json` (or its passphrase) loses the owner.
- Consider a separate owner for an unattended server (recommended, not
  required). A server whose secrets unlock unattended exposes its owner
  phrase to whoever compromises it. With a separate owner, that exposure
  stays limited to the server's agents. The cost: the server's agents and
  your desktop's agents have different owners. Opening one owner's agent
  under another goes through review.
- Prefer `adf identity unlock` after each restart where someone is
  available to do it. Boot unlock trades that step for a passphrase stored on
  the host.
