# Remote daemon

Run the daemon on a server and use `adf` (the terminal app or one-shot
commands) from your laptop. Every client needs two things: the daemon's URL
and its access token.

```bash
adf --url <url> --token <token>             # terminal app
adf --url <url> --token <token> agents      # a command
export ADF_DAEMON_URL=<url> ADF_DAEMON_TOKEN=<token>   # or once per shell
```

Get the token on the server with `adf daemon token` (it prints only the
token). `adf` never starts a daemon for a remote URL (or a tunnelled local
port), and never sends your machine's own token file to another host. In the app, `/url <url> --token
<token>` switches daemons live.

## The token is as powerful as your seed phrase

Whoever holds the daemon token can run code on the server as the daemon's
user: attaching an MCP server or a channel adapter sets the command the
daemon starts, and starting the agent runs it. That code can read what the
daemon reads, including the owner seed phrase in the OS keychain (or in the
daemon's memory once its passphrase file is unlocked). Treat the token as you
treat the 12 words:

- Give it only to machines you trust with the seed phrase. Never paste it
  into a chat, a ticket, a shared shell history or a CI log.
- Send it only over an encrypted transport (SSH tunnel, https). Plain http
  on a network you do not control hands it to that network.
- If it leaks, rotate it: on the server run `adf daemon stop`, delete the
  `daemon-token` file (`adf daemon status` names the data directory) or set a
  new `ADF_DAEMON_TOKEN`, and start the daemon again. If the daemon held the
  seed phrase, also move your agents to a new owner (`adf identity import`).

Routes that hand secrets out directly (owner import, stored values, full
`.adf` exports) additionally need the local proof file, which only the
server's own user can read; that does not stop the path above.

## Remote access

The simplest way on a home or office network or a tailnet. No environment
variable, no foreground daemon, no restart (agents keep running).

```bash
# on the server (the computer whose agents you want to reach)
adf daemon remote on          # also Settings → Networking → Remote access in ADF Studio
adf daemon pair               # shows a 6-digit code for 2 minutes

# on your laptop
adf pair                      # lists the ADF computers it finds; or: adf pair <host>
```

- `adf pair` asks for the code; the server then asks (Allow device).
  Only after Allow does the laptop get its own device token, saved in the
  OS keychain (or a file only you can read). `adf` then talks to that
  server by default (`adf remotes use local` switches back; `--remote
  <name>` picks one for a command).
- Without pairing: `adf daemon devices add <label>` prints a device token
  once; use it with `--url` and `--token`, or paste both in ADF Studio.
- `adf daemon devices` lists the computers (connected now, last seen);
  `adf daemon devices revoke <id|label>` disconnects one at once and voids
  its token. `adf daemon remote off` disconnects them all and keeps the list.
- The daemon listens only on private and Tailscale addresses, and only on a
  network you allowed, once per network (the tailnet too).
  `adf daemon remote status` shows the networks; `adf daemon remote
  allow-network` allows the current one, `adf daemon remote forget-network
  <id|name>` removes one and closes its listeners at once.
- This computer's own token (`adf daemon token`) is refused from other
  computers. A device token cannot reach the owner identity, stored
  values, shutdown or remote-access management; it can still run agents
  and their tools, so it is as powerful as your seed phrase (below).
- On a LAN the connection is plain http: the token travels unencrypted.
  With Tailscale, pair over the tailnet address (WireGuard encrypts it), or
  run `adf daemon remote serve on` for https through `tailscale serve`.
- Windows and macOS ask once whether ADF may accept connections: allow it
  on private networks. On Linux, open the port in ufw or firewalld if they
  run (`adf daemon remote status` prints the commands).
- It works while the daemon runs. A daemon ADF Studio started stops when
  Studio quits unless **Keep the daemon running** is on; Studio asks first
  when other computers are connected.

Design and every rule: [remote-access.md](../design/remote-access.md).

## Option 1: SSH tunnel (recommended)

The daemon stays on the server's loopback, where it is by default; SSH does
the transport and encryption.

```bash
# on your laptop: local port 7386 → the server's daemon on 7385
ssh -N -L 7386:127.0.0.1:7385 user@server &
adf --url http://127.0.0.1:7386 --token "$(ssh user@server adf daemon token)"
# or once per shell
export ADF_DAEMON_URL=http://127.0.0.1:7386
export ADF_DAEMON_TOKEN="$(ssh user@server adf daemon token)"
adf
```

- Use a local port other than your own daemon's (7385, or
  `ADF_DAEMON_PORT`). `adf` treats any other loopback port as a tunnel: it
  never auto-starts a daemon there (a down tunnel gives "Cannot reach…"),
  and never sends your laptop's token file there.
- So the token is required: `--token` or `ADF_DAEMON_TOKEN`. Without it the
  daemon answers `401` and `adf` points you to `adf daemon token`.
- Through the tunnel the daemon sees a loopback connection, so owner identity
  create / restore / unlock and `adf daemon stop` work as on the server.
  This holds for `adf` only: ADF Studio in remote mode (URL
  `http://127.0.0.1:7386`) never sends a seed phrase to another machine and
  has no local proof for the server, so its owner identity actions say to run
  `adf identity` on the server, through the tunnel too.

## Option 2: bind to the network

For a trusted network only (a LAN, a tailnet): the daemon speaks plain HTTP,
so the token travels unencrypted.

```bash
# on the server, in the foreground (or under systemd / a service manager)
export ADF_DAEMON_TOKEN="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"
ADF_DAEMON_ALLOWED_HOSTS=server.lan adf daemon --host 0.0.0.0
```

- A non-loopback `--host` requires `ADF_DAEMON_TOKEN`: the daemon refuses to
  start without it. The background start (`adf daemon start`) is loopback
  only; run `adf daemon --host …` in the foreground or as a service.
- Clients may use the server's IP address; host names they use (here
  `server.lan`) must be in `ADF_DAEMON_ALLOWED_HOSTS` (comma or space
  separated; `name` or `name:port`).
- Owner identity create / restore / unlock and `adf daemon stop` are refused
  from other machines: run them on the server.
- On a tailnet, bind to the server's tailnet address (`--host 100.x.y.z`).
  `100.64.0.0/10` is also the range internet providers use for carrier-grade
  NAT, so a `http://100.x.y.z` URL on a network you do not control may reach
  another machine with your token. Prefer https through `tailscale serve` and
  the MagicDNS name. ADF Studio accepts plain http to a `100.64.0.0/10`
  address without asking; any other plain-http address (a LAN address, a
  MagicDNS name) needs its "I trust this network" confirmation.

## Option 3: TLS reverse proxy

Keep the daemon on `127.0.0.1:7385` and put a TLS proxy in front, for
example Caddy:

```text
adf.example.com {
    reverse_proxy 127.0.0.1:7385
}
```

- Start the daemon with `ADF_DAEMON_ALLOWED_HOSTS=adf.example.com` so it
  accepts the proxied `Host` (also on its loopback bind).
- The token is the install's file token: `adf daemon token` on the server.
  Clients: `adf --url https://adf.example.com --token <token>`.
- Live events are a streaming response (`/events`). Caddy streams them as is;
  with nginx set `proxy_buffering off` for the daemon location.
- The daemon sees the proxy's loopback connection. Start it with
  `ADF_DAEMON_BEHIND_PROXY=1` so the routes it keeps to its own machine (owner
  identity create / restore / unlock / lock, `adf daemon stop`) stay there:
  they then also need a proof file only this host can read, which `adf` on
  the server sends by itself. Run those commands on the server, against
  `127.0.0.1:7385`, not through the proxy. A request that carries proxy
  headers (`X-Forwarded-For`, `Forwarded`, `X-Real-IP`, …) is never treated
  as local, with or without the setting.

## Option 4: tailscale serve

On a tailnet, `tailscale serve` gives the daemon an https address with a
certificate your devices trust, and the daemon stays on the server's
loopback.

```bash
# on the server: the daemon on loopback, told the tailnet name and that a proxy is in front
export ADF_DAEMON_ALLOWED_HOSTS=<machine>.<tailnet>.ts.net
export ADF_DAEMON_BEHIND_PROXY=1
adf daemon start
# https://<machine>.<tailnet>.ts.net → 127.0.0.1:7385, in the background
tailscale serve --bg 7385
tailscale serve status
adf daemon token
```

- Make the two variables permanent for whatever starts the daemon: `export`
  holds only for that shell, and a daemon that `adf` starts later by
  itself (or after a reboot) would come up without them and refuse the
  `ts.net` name. Use a service with the variables in it, or the account's
  persistent environment:

  ```bash
  # Linux: a systemd user unit (systemctl --user enable --now adf-daemon)
  # ~/.config/systemd/user/adf-daemon.service
  [Service]
  Environment=ADF_DAEMON_ALLOWED_HOSTS=<machine>.<tailnet>.ts.net
  Environment=ADF_DAEMON_BEHIND_PROXY=1
  ExecStart=/usr/bin/env adf daemon
  Restart=on-failure
  [Install]
  WantedBy=default.target

  # macOS: for the login session (or the same keys in a launchd agent's EnvironmentVariables)
  launchctl setenv ADF_DAEMON_ALLOWED_HOSTS <machine>.<tailnet>.ts.net
  launchctl setenv ADF_DAEMON_BEHIND_PROXY 1

  # Windows: the user's persistent environment (new shells and processes)
  setx ADF_DAEMON_ALLOWED_HOSTS <machine>.<tailnet>.ts.net
  setx ADF_DAEMON_BEHIND_PROXY 1
  ```

  Restart the daemon after changing them (`adf daemon stop`, then start it
  the same way).
- `tailscale serve` forwards the browser's Host header (the `ts.net` name)
  to the daemon, and adds `X-Forwarded-For`, `X-Forwarded-Host`,
  `X-Forwarded-Proto` and `Tailscale-User-*` headers (Tailscale's
  `ipn/ipnlocal/serve.go`). So the name MUST be in
  `ADF_DAEMON_ALLOWED_HOSTS`; the daemon accepts it on a loopback bind.
  Without it every request answers `403 host_not_allowed`.
- The forwarded headers make every request through `serve` a remote one:
  owner identity create / restore / unlock / lock and `adf daemon stop`
  are refused there. Run them on the server against `127.0.0.1:7385`.
- Clients: `adf --url https://<machine>.<tailnet>.ts.net --token <token>`.
- To stop serving: `tailscale serve reset`.

Without `serve`, a daemon bound to its tailnet address
(`adf daemon --host <100.x.y.z>`, with `ADF_DAEMON_TOKEN`) is reachable as
`http://100.x.y.z:7385`; ADF Studio accepts plain http to a tailnet
address (100.64.0.0/10) without a confirmation. A MagicDNS name over plain
http needs the confirmation; use `serve` instead.

## ADF Studio

Settings → Connection → Add connection takes the same URL and token (or
pairs with a code). Studio checks the address, the token and the client API
version before it saves the connection; **Connect** shows what moves (client
settings only) and restarts Studio connected to it. A computer paired with
`adf pair` is already in Studio's list: Studio and `adf` share
`cli-remotes.json` and the keychain. Details and every message:
[Studio backend › Remote computer](../guides/studio-backend.md#remote-computer).

- Open agent…, New agent, Track folder and folder fields pick paths on
  the server (a picker over `GET /fs/browse`). A remote client lists folder
  and `.adf` names under the server's home folder, tracked folders and
  agents folder; set `ADF_DAEMON_BROWSE_ROOTS` on the server to list
  other folders instead of the home folder.
- A `.adf` this computer's OS hands to Studio (double-click, the command
  line, a second instance) is offered
  as an upload of a copy into a tracked folder or the agents folder on the
  server. Nothing is uploaded without your choice. Open Recent lists paths on
  the server, and Studio adds none of them to the OS recent documents.
- MCP OAuth sign-in: Studio asks before it opens the page, takes the
  browser's callback on this computer and hands it to the daemon
  (`POST /oauth/relay`). No port needs to be tunnelled.
- Owner identity, stored credential values and the agent browser viewer
  stay on the server; Studio says so where you ask for them.

## Sign in to ChatGPT

ChatGPT sign-in redirects the browser to a local callback. Against a remote
daemon, `adf auth login chatgpt` and the app's `/login chatgpt` receive that
callback on your machine and hand the code to the daemon (relay mode, the
default for a non-loopback `--url`). Only the short-lived authorization code
travels, useless without the verifier the daemon kept. Through an SSH tunnel
the URL looks local, so the daemon serves the callback on the server's port
1455: force relay (CLI only), or tunnel that port too (needed for the app's
`/login chatgpt`):

```bash
adf auth login chatgpt --relay
# or
ssh -N -L 7386:127.0.0.1:7385 -L 1455:127.0.0.1:1455 user@server &
adf auth login chatgpt --loopback
```

Grok's device code works anywhere. Claude prints a sign-in URL: open it in
any browser and paste the code the page shows. Claude Code must be installed
and signed in on the server, not your laptop.

## Things that stay on the server

- Agents' files and folders: `/track`, `/load` and `adf new --dir` take
  paths on the daemon's machine.
- The external editor (`e` in Files) runs on your laptop; the file goes back
  to the daemon on save.
- `adf daemon logs`, `status` details (data dir, log) and `token` read the
  local machine: run them on the server.
- ADF Studio in remote mode picks paths on the server, offers files of your
  laptop as uploads, and keeps owner identity, stored credential values and
  the agent browser viewer on the server. See
  [Studio backend › Remote computer](../guides/studio-backend.md#remote-computer).
