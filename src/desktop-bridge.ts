/**
 * Desktop pairing bridge for dsh-tunnelmux-remote.
 *
 * Port of the standalone `~/.dsh/bin/dsh-web-cookie serve` tool so the plugin
 * owns the whole remote-access story: it mints DSH browser-session cookies
 * offline (the HMAC secret in $DSH_HOME/.credentials.yaml is persistent, unlike
 * the per-launch ?token=), serves a loopback-only pairing page that installs
 * them, and upserts the TunnelMux routes that expose the page and the GUI.
 *
 * Security model (unchanged from the standalone tool): anyone who can reach the
 * bridge can obtain a session cookie, so the listener binds 127.0.0.1 only and
 * MUST sit behind an access-gated reverse-proxy route (TunnelMux access code).
 *
 * Cookie format authority: deepseek-harness/packages/client/connection/src/browser-auth.ts
 *   name  = "dsh-auth-" + base64url(sha256(authority))
 *   value = "v1." + base64url(JSON{version,authority,issuedAt,expiresAt})
 *         + "." + base64url(hmac_sha256(secret, body))
 */
import { createHash, createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import http from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { TunnelMuxHttpClient } from './tunnelmux.ts'

export const COOKIE_PREFIX = 'dsh-auth-'
export const COOKIE_PAYLOAD_VERSION = 1
export const SECRET_BYTES = 32
/** The credentials record holding the persistent browser-session HMAC secret. */
export const BROWSER_SESSION_RECORD = 'client-connection/browser-session'
export const DAY_MILLISECONDS = 24 * 60 * 60 * 1000

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/

/** base64url without padding, matching browser-auth.ts encodeBase64Url. */
export function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '')
}

function decodeBase64Url(value: string): Buffer {
  if (!BASE64URL_PATTERN.test(value) || value.length % 4 === 1) {
    throw new Error('malformed base64url value')
  }
  const padding = '='.repeat((4 - value.length % 4) % 4)
  const decoded = Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/') + padding, 'base64')
  if (base64UrlEncode(decoded) !== value) throw new Error('malformed base64url value')
  return decoded
}

/** The cookie name DSH expects for `authority` ("host:port" of what the server sees). */
export function browserSessionCookieName(authority: string): string {
  return COOKIE_PREFIX + base64UrlEncode(createHash('sha256').update(authority).digest())
}

export interface MintedSessionCookie {
  name: string
  value: string
}

/** Mint one DSH browser-session cookie. `days` must be <= dsh cookieMaxAgeDays (default 30). */
export function mintSessionCookie(input: {
  secret: Buffer
  authority: string
  days?: number
  nowMs?: number
}): MintedSessionCookie {
  const { secret, authority, nowMs = Date.now() } = input
  const days = input.days ?? 30
  if (!Number.isInteger(days) || days < 1) throw new Error('cookie lifetime must be an integer number of days >= 1')
  const body = base64UrlEncode(Buffer.from(JSON.stringify({
    version: COOKIE_PAYLOAD_VERSION,
    authority,
    issuedAt: nowMs,
    expiresAt: nowMs + days * DAY_MILLISECONDS,
  })))
  const signature = base64UrlEncode(createHmac('sha256', secret).update(body).digest())
  return {
    name: browserSessionCookieName(authority),
    value: `v1.${body}.${signature}`,
  }
}

/** One Set-Cookie value with DSH's own attributes (HttpOnly, SameSite=Strict). */
export function sessionSetCookieHeader(minted: MintedSessionCookie, cookiePath: string, days: number): string {
  const maxAge = days * 86_400
  const expires = new Date(Date.now() + maxAge).toUTCString()
  return `${minted.name}=${minted.value}; Max-Age=${String(maxAge)}; Path=${cookiePath}; Expires=${expires}; HttpOnly; SameSite=Strict`
}

/**
 * Extract the persistent browser-session HMAC secret from the credentials YAML.
 * Scans by indentation so the file's other records (API keys, tokens) are never
 * parsed — a direct port of the standalone tool's reader.
 */
export function readBrowserSessionSecret(credentialsPath: string): Buffer {
  const lines = readFileSync(credentialsPath, 'utf8').split(/\r?\n/)
  const recordPattern = new RegExp(`^(\\s*)${BROWSER_SESSION_RECORD.replace('/', '/')}:\\s*$`)
  let start = -1
  let indent = 0
  for (let index = 0; index < lines.length; index++) {
    const match = recordPattern.exec(lines[index])
    if (match !== null) {
      start = index
      indent = match[1].length
      break
    }
  }
  if (start === -1) throw new Error(`record ${BROWSER_SESSION_RECORD!} not found in ${credentialsPath}`)
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index]!
    if (line.trim() === '') continue
    if (line.length - line.trimStart().length <= indent) break
    const match = /^\s*secret:\s*(\S+)\s*$/.exec(line)
    if (match === null) continue
    const raw = match[1]!.replace(/^['"]|['"]$/g, '')
    let secret: Buffer
    try {
      secret = decodeBase64Url(raw)
    } catch {
      throw new Error(`malformed secret in ${credentialsPath}`)
    }
    if (secret.byteLength !== SECRET_BYTES) {
      throw new Error(`unexpected secret length ${secret.byteLength} (want ${String(SECRET_BYTES)})`)
    }
    return secret
  }
  throw new Error(`no secret under record ${BROWSER_SESSION_RECORD} in ${credentialsPath}`)
}

/** Default credentials location ($DSH_HOME/.credentials.yaml with ~ expansion). */
export function defaultCredentialsPath(dshHome = '~/.dsh'): string {
  return expandHome(`${dshHome.replace(/\/$/, '')}/.credentials.yaml`)
}

/** Expand a leading `~` to the user home directory. */
export function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return homedir() + path.slice(1)
  return path
}

/** "host:port" authority of a URL, as DSH's requestAuthority would compute it. */
export function authorityOf(url: string): string | undefined {
  try {
    return new URL(url).host
  } catch {
    return undefined
  }
}

export interface DesktopBridgeOptions {
  /** Loopback port to listen on (127.0.0.1 only). */
  port: number
  /** Minted per request so a late-resolving public tunnel URL is picked up. */
  authorities: () => string[]
  secret: Buffer
  days?: number
  /** Cookie Path attribute — must cover the public mount ('/'). */
  cookiePath?: string
  /** Where the landing page navigates after pairing. */
  redirect?: string
  /** Extra NAME=VALUE cookies to install (e.g. the proxy's gate cookies). */
  gateCookies?: string[]
  /** Answer 303 instead of 200+JS (only for proxies that pass 3xx through). */
  httpRedirect?: boolean
}

export interface DesktopBridgeHandle {
  port: number
  close(): Promise<void>
  /** Raw node server, exposed for tests and diagnostics only. */
  server: http.Server
}

function landingBody(redirect: string): string {
  const escaped = redirect.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
  return `<!doctype html><meta charset="utf-8"><title>Paired</title><script>location.replace(${JSON.stringify(redirect)})</script><noscript><a href="${escaped}">Continue</a></noscript>`
}

function plain(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

/**
 * The bridge request listener, separable from the listener for tests.
 * Every GET/HEAD installs fresh session cookies for the current authorities
 * plus the gate cookies, then hands the browser to `redirect`.
 */
export function bridgeRequestHandler(options: {
  authorities: () => string[]
  secret: Buffer
  days?: number
  cookiePath?: string
  redirect?: string
  gateCookies?: string[]
  httpRedirect?: boolean
}): (req: IncomingMessage, res: ServerResponse) => void {
  const {
    authorities,
    secret,
    days = 30,
    cookiePath = '/',
    redirect = '/',
    gateCookies = [],
    httpRedirect = false,
  } = options
  return function bridgeHandler(req: IncomingMessage, res: ServerResponse): void {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405)
        res.end()
        return
      }
      if ((req.url ?? '/').startsWith('/health')) {
        plain(res, 200, 'ok\n')
        return
      }
      const cookies = authorities().map((authority) => {
        const minted = mintSessionCookie({ secret, authority, days })
        return sessionSetCookieHeader(minted, cookiePath, days)
      })
      for (const gate of gateCookies) {
        cookies.push(`${gate}; Path=${cookiePath}; Max-Age=${String(days * 86_400)}; HttpOnly; SameSite=Lax`)
      }
      const status = httpRedirect ? 303 : 200
      // node flushes headers on writeHead, so every header (Set-Cookie as an
      // array included) must be in place BEFORE it — an appendHeader afterwards
      // throws ERR_HTTP_HEADERS_SENT, and an escaping throw would kill the host.
      const headers: Record<string, string | number | string[]> = {
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
      }
      if (httpRedirect) headers.location = redirect
      else headers['content-type'] = 'text/html; charset=utf-8'
      const body = httpRedirect ? undefined : Buffer.from(landingBody(redirect), 'utf8')
      if (body !== undefined) headers['content-length'] = body.byteLength
      if (cookies.length > 0) headers['set-cookie'] = cookies
      res.writeHead(status, headers)
      res.end(body)
    } catch (error) {
      console.error('tunnelmux-remote: bridge request failed —', error instanceof Error ? error.message : error)
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('internal error')
      } else {
        res.end()
      }
    }
  }
}

/**
 * Start the loopback pairing bridge. Every GET/HEAD installs fresh session
 * cookies for the current authorities plus the gate cookies, then hands the
 * browser to `redirect`.
 */
export function startDesktopBridge(options: DesktopBridgeOptions): DesktopBridgeHandle {
  const handler = bridgeRequestHandler(options)
  const server = http.createServer(handler)
  server.listen(options.port, '127.0.0.1')
  return {
    get port(): number {
      const address = server.address()
      return typeof address === 'object' && address !== null ? address.port : options.port
    },
    close(): Promise<void> {
      return new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
    },
    server,
  }
}

// --------------------------------------------------------------------------- //
// TunnelMux route upsert
// --------------------------------------------------------------------------- //

export interface DesiredRoute {
  id: string
  matchPathPrefix: string
  stripPathPrefix: string | null
  upstreamUrl: string
}

export interface RouteUpsertResult {
  ok: boolean
  reason?: string
  registered: string[]
  updated: string[]
  skipped: string[]
}

/**
 * Idempotently make the control API match `desired`: create missing routes,
 * update drifted ones, leave everything else untouched. Best-effort: on 401
 * (control plane locked) the caller should log and move on — routes persist
 * in the daemon's state file, so a one-time registration survives restarts.
 */
export async function ensureTunnelmuxRoutes(
  client: TunnelMuxHttpClient,
  desired: DesiredRoute[],
  tunnelId = 'primary',
): Promise<RouteUpsertResult> {
  const summary: RouteUpsertResult = { ok: true, registered: [], updated: [], skipped: [] }
  let response
  try {
    response = await client.request('/v1/routes')
  } catch (error) {
    return { ...summary, ok: false, reason: error instanceof Error ? error.message : 'list failed' }
  }
  if (!response.ok) return { ...summary, ok: false, reason: `list routes failed (${String(response.status)})` }
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    return { ...summary, ok: false, reason: 'list routes returned invalid JSON' }
  }
  const rows = (payload as { routes?: unknown }).routes
  const existing = new Map<string, Record<string, unknown>>()
  if (Array.isArray(rows)) {
    for (const row of rows) {
      if (typeof row === 'object' && row !== null && typeof (row as Record<string, unknown>).id === 'string') {
        existing.set((row as Record<string, unknown>).id as string, row as Record<string, unknown>)
      }
    }
  }
  for (const want of desired) {
    const row = existing.get(want.id)
    const drifted = row === undefined
      || row.match_path_prefix !== want.matchPathPrefix
      || row.strip_path_prefix !== want.stripPathPrefix
      || row.upstream_url !== want.upstreamUrl
    if (!drifted) {
      summary.skipped.push(want.id)
      continue
    }
    const body = {
      tunnel_id: tunnelId,
      id: want.id,
      match_host: null,
      match_path_prefix: want.matchPathPrefix,
      strip_path_prefix: want.stripPathPrefix,
      upstream_url: want.upstreamUrl,
      fallback_upstream_url: null,
      health_check_path: '/__disabled__',
      enabled: true,
      forward_host_header: false,
      rewrite_response_paths: false,
      ...(row !== undefined ? row : {}),
    }
    try {
      const write = row === undefined
        ? await client.request('/v1/routes', { method: 'POST', body })
        : await client.request(`/v1/routes/${encodeURIComponent(want.id)}`, { method: 'PUT', body })
      if (!write.ok) {
        const text = await write.text().catch(() => '')
        return { ...summary, ok: false, reason: `${row === undefined ? 'create' : 'update'} ${want.id} failed (${String(write.status)}) ${text.slice(0, 200)}` }
      }
    } catch (error) {
      return { ...summary, ok: false, reason: error instanceof Error ? error.message : 'write failed' }
    }
    if (row === undefined) summary.registered.push(want.id)
    else summary.updated.push(want.id)
  }
  return summary
}

/**
 * Gate cookies to install at pairing time. With no explicit override, read the
 * daemon's default access code from its state file and derive one cookie per
 * route id (`tunnelmux_access_<routeId>`), so one code entry unlocks both the
 * pairing route and the root app route.
 */
export function resolveGateCookies(stateFile: string, routeIds: string[], explicit: string): string[] {
  if (explicit.trim() !== '') return [explicit]
  try {
    const state = JSON.parse(readFileSync(expandHome(stateFile), 'utf8')) as {
      default_route_access?: { require_access_code?: unknown }
    }
    const code = state.default_route_access?.require_access_code
    if (typeof code === 'string' && code !== '') return routeIds.map((id) => `tunnelmux_access_${id}=${code}`)
  } catch {
    // state file missing or unreadable: the proxy gate still prompts for the code
  }
  return []
}
