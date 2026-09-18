# dsh-tunnelmux-remote

Mobile remote control for the DeepSeek Harness web GUI, with **TunnelMux as the
tunnel backend**. Scan a QR code beside the sidebar to pair your phone, chat
with your sessions from /m, and revoke any device at any time. The public URL
comes from the local TunnelMux control API (cloudflared/ngrok) — no embedded
tunnel binary in the plugin.

Built from scratch (2026-08-16) following the design in
[TunnelMux docs/plans/2026-08-16-dsh-tunnelmux-remote-design.md](https://github.com/kexuejin/TunnelMux/blob/main/docs/plans/2026-08-16-dsh-tunnelmux-remote-design.md)
and referencing @linxin666/dsh-remote-web-ui (Apache-2.0) for the pairing model.

## Features

- **Scan-to-pair QR** beside the official sidebar footer: one-time token, first
  accept consumes it, refresh invalidates the old QR immediately.
- **Device sessions**: HttpOnly cookie gate, presence tracking with offline
  detection, max 4 devices (oldest evicted), revoke all with one click.
- **Mobile surface** at `/m`: session list (cursor pagination), create /
  rename / history / prompt / models — bridged through the host apiProxy with a
  strict method allowlist.
- **TunnelMux backend**: `POST /v1/tunnel/start` returns the public URL
  synchronously (daemon waits for provider startup); the plugin **observes**
  status for the panel and never restarts the tunnel itself — the daemon owns
  `auto_restart`.
- **Live updates**: SSE `/api/pair/events` for the desktop panel and
  `/m/api/events.mux` for the phone.
- **Desktop browser pairing**: opens the real GUI on the public URL, not just
  the phone page — see [Desktop bridge](#desktop-bridge-browser-sessions-over-the-public-url).

## Install

Requires a running TunnelMux daemon (control API on 127.0.0.1:4765) and the DSH
web profile:

```bash
cd ~/.dsh/profiles/web
dsh plugin add github:kexuejin/dsh-tunnelmux-remote   # or link:/path/to/this/repo
```

Or add to `cordis.patch.yml` manually:

```yaml
- insert:
    - id: tunnelmux-remote
      name: dsh-tunnelmux-remote
```

## Configuration (settings namespace `tunnelmux-remote`)

| key | default | meaning |
|---|---|---|
| `enabled` | `true` | master switch |
| `tunnelmuxBaseUrl` | `http://127.0.0.1:4765` | TunnelMux control API |
| `tunnelmuxApiToken` | `''` (secret) | optional Bearer token |
| `targetUrl` | `http://127.0.0.1:3080` | local GUI the tunnel exposes |
| `tunnelProvider` | `cloudflared` | `cloudflared` or `ngrok` |
| `autoTunnel` | `false` | start the tunnel on plugin load |
| `publicBaseUrl` | `''` | existing public entry (skips auto-tunnel) |
| `tokenTtlMs` / `offlineAfterMs` / `maxDevices` | 10min / 25s / 4 | pairing tuning |
| `cookieName` | `dsh_pair` | device cookie |
| `mobileEnterToSend` | `true` | Enter sends in the phone chat box |
| `desktopBridge` | `true` | start the loopback pairing bridge |
| `bridgePort` | `3988` | bridge listen port (127.0.0.1 only) |
| `bridgeRedirect` | `/` | where the browser goes after pairing |
| `bridgeDays` | `30` | minted cookie lifetime in days (≤ DSH `cookieMaxAgeDays`) |
| `registerRoutes` | `true` | upsert the two TunnelMux routes on load |
| `pairRouteId` / `pairRoutePrefix` | `deepseek` / `/deepseek` | gated entry that mints the cookie |
| `rootRouteId` / `rootRoutePrefix` | `dsh-root` / `/` | the GUI itself, reachable at the root |
| `gateCookie` | `''` | explicit `NAME=VALUE` to install; empty = read the daemon's default access code |
| `dshHome` | `~/.dsh` | where `.credentials.yaml` lives |
| `tunnelmuxStateFile` | `~/.tunnelmux/state.json` | source of the default access code |

## Desktop bridge (browser sessions over the public URL)

The QR flow pairs a phone with `/m`. Opening the **full GUI** in a real browser
over the public URL needs something else: a DSH browser-session cookie. The
bridge mints one, so a visitor who passes the access gate lands in the app
already signed in. It replaces the standalone `~/.dsh/bin/dsh-web-cookie` tool
— you no longer run a second process by hand.

```
browser ──► https://host/deepseek          (TunnelMux asks for the access code)
              └─► 127.0.0.1:3988           (bridge: sets cookies, JS redirect)
                    └─► https://host/      (the GUI, already authenticated)
```

- **Cookies are minted offline.** The HMAC secret under
  `client-connection/browser-session` in `$DSH_HOME/.credentials.yaml` is
  persistent, unlike the per-launch `?token=`, so a minted cookie survives
  restarts of both the app and the tunnel.
- **Two routes, both upserted idempotently.** `/deepseek` points at the bridge
  (strip prefix), `/` points at the GUI (no strip). The root entry is not
  decoration: the DSH client builds root-absolute URLs from `location.origin`,
  so under a path mount every RPC asked the tunnel host for `/api/...` and came
  back empty — session list included. Routing around it is the point, because
  the client is not modifiable.
- **The gate code is carried across.** On pairing the bridge also installs
  `tunnelmux_access_<routeId>` for both routes (from the daemon's state file),
  so passing the gate once unlocks `/deepseek` and `/` together.
- **A locked control plane is not fatal.** If the daemon answers 401, route
  sync is deferred and logged; routes persist in the daemon state file and
  apply once it is unlocked.
- **If the secret cannot be read** (missing record, malformed value) the bridge
  stays down and logs once. Everything else — QR pairing, phone page, tunnel
  observation — keeps working.

## Security model

- **One active token**; `issue()` replaces it, so a fresh QR invalidates the
  previous link immediately.
- **One-time accept**; reuse returns `used` (409). Tokens expire (default
  10 min). `stop()` revokes every session and clears the token — the phone's
  next gated request gets 403.
- **Fences**: control endpoints (`issue`/`stop`/`events`) are loopback-only;
  phone endpoints (`accept`/`heartbeat`/`status`) allow loopback, LAN
  literals, or the public tunnel Host. Accept is rate-limited per IP
  (10 attempts / 30 s).
- **Mobile allowlist**: only `workspace.list`, `session.*` and
  `mobile.preferences` are exposed over `/m/api`; everything else 403s.
  `settings.*` / `credentials.*` remain loopback-only host methods and are
  never reachable from a phone.
- **The bridge is a bearer-token dispenser.** Anyone who can reach it gets a
  valid DSH session, so it binds `127.0.0.1` only and **must** sit behind an
  access-gated route (`registerRoutes` puts the access code in front of
  `/deepseek` for exactly this reason). Exposing port 3988 directly — by
  disabling the gate, or by adding an ungated route to it — hands out full
  access to the GUI. Cookies are minted fresh per request, only for the current
  authorities, and only for `GET`/`HEAD`: the session cookie is
  `HttpOnly; SameSite=Strict`, the gate cookie `HttpOnly; SameSite=Lax`.
  `GET /health` on the bridge answers `ok` for local diagnostics.

## Development

```bash
npm install
npm run typecheck   # tsc client + host
npm test            # vitest (64 tests)
npm run build       # tsdown: lib/index.js (host) + lib/mobile.js + client/client.js
node test/smoke-live.mjs   # read-only probe of a live daemon at 127.0.0.1:4765
```

## License

Apache-2.0.
