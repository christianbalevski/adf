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
  accepts the proxied `Host`.
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
  [Studio backend › Remote daemon in Studio](../guides/studio-backend.md#remote-daemon-in-studio).
