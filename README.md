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

## Install

Requires a running TunnelMux daemon (control API on 127.0.0.1:4765) and the DSH
web profile:

```bash
cd ~/.dsh/profiles/web
dsh plugin add github:YOUR_ORG/dsh-tunnelmux-remote   # or link:/path/to/this/repo
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

## Development

```bash
npm install
npm run typecheck   # tsc client + host
npm test            # vitest (48 tests)
npm run build       # tsdown: lib/index.js (host) + lib/mobile.js + client/client.js
node test/smoke-live.mjs   # read-only probe of a live daemon at 127.0.0.1:4765
```

## License

Apache-2.0.
