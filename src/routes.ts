/**
 * Host-side routing for dsh-tunnelmux-remote: the /api/pair route family plus
 * the browser-trust fence. Mirrors the DSH connection trust model: loopback
 * and trusted hosts may call the desktop control endpoints; phones may call
 * accept/heartbeat/status from the LAN literals or the public tunnel host.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { networkInterfaces } from 'node:os'
import type { PairingService, PairingSnapshot } from './pairing.ts'

/** Route descriptor consumed by the webServer service. */
export interface RouteDef {
  kind: 'exact' | 'prefix'
  path: string
  handler(req: IncomingMessage, res: ServerResponse): void | Promise<void>
}

export const PAIR_PATHS = {
  issue: '/api/pair/issue',
  accept: '/api/pair/accept',
  stop: '/api/pair/stop',
  heartbeat: '/api/pair/heartbeat',
  status: '/api/pair/status',
  events: '/api/pair/events',
} as const

const MAX_BODY_BYTES = 16 * 1024
const COOKIE_MAX_AGE_SEC = 60 * 60 * 24 * 30

/** Per-source-IP accept rate limit (brute-force defense in depth). */
const ACCEPT_MAX_ATTEMPTS = 10
const ACCEPT_WINDOW_MS = 30_000

/** LAN address derivation: non-internal IPv4 interface addresses. */
export function lanIPv4Addresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((iface): iface is NonNullable<typeof iface> => iface !== undefined && iface.family === 'IPv4' && !iface.internal)
    .map((iface) => iface.address)
}

/** Whether the request source passes the given fence (loopback + allowed literals). */
export function isTrustedRequest(
  req: IncomingMessage,
  allowedAddresses: string[],
): boolean {
  const remote = req.socket?.remoteAddress ?? ''
  if (remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1') return true
  // IPv4-mapped IPv6 literals arrive as ::ffff:a.b.c.d
  const plain = remote.startsWith('::ffff:') ? remote.slice(7) : remote
  return allowedAddresses.includes(plain)
}

/** The public host (no port) of a tunnel URL, for the phone fence. */
export function publicHostOf(publicBaseUrl: string | undefined): string | undefined {
  if (!publicBaseUrl) return undefined
  try {
    return new URL(publicBaseUrl).hostname
  } catch {
    return undefined
  }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
  })
  res.end(JSON.stringify(body))
}

function requireMethod(req: IncomingMessage, res: ServerResponse, method: string): boolean {
  if (req.method === method) return true
  res.writeHead(405)
  res.end()
  return false
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return rest.join('=') || undefined
  }
  return undefined
}

/** SSE fan-out for desktop panel status. */
export class PairingEventsStream {
  private streams = new Set<ServerResponse>()
  private service: PairingService

  constructor(service: PairingService) {
    this.service = service
    service.onState((snapshot) => this.push(snapshot))
  }

  open(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    this.streams.add(res)
    const close = () => {
      this.streams.delete(res)
    }
    res.on('close', close)
    req.on('close', close)
  }

  push(snapshot: PairingSnapshot): void {
    const frame = `data: ${JSON.stringify({ type: 'state', ...snapshot })}\n\n`
    for (const res of this.streams) {
      try {
        res.write(frame)
      } catch {
        this.streams.delete(res)
      }
    }
  }

  get size(): number {
    return this.streams.size
  }
}

export interface PairingRoutesDeps {
  service: PairingService
  lanAddresses: () => string[]
}

/** Build the /api/pair route family. */
export function makePairingRoutes(deps: PairingRoutesDeps): RouteDef[] {
  const { service, lanAddresses } = deps
  const events = new PairingEventsStream(service)
  const acceptAttempts = new Map<string, { count: number; windowStart: number }>()

  const lanFence = (req: IncomingMessage): boolean => {
    if (isTrustedRequest(req, lanAddresses())) return true
    // Phones reach us through the public tunnel: their source IP is not a
    // predictable LAN literal, so the Host header (the DNS name) is the fence.
    const publicHost = publicHostOf(service.publicBaseUrl)
    if (publicHost === undefined) return false
    const host = (req.headers.host ?? '').toLowerCase()
    return host === publicHost || host.startsWith(publicHost + ':')
  }
  const loopbackFence = (req: IncomingMessage): boolean => isTrustedRequest(req, [])

  const rateLimited = (req: IncomingMessage): boolean => {
    const ip = req.socket?.remoteAddress ?? 'unknown'
    const now = Date.now()
    const entry = acceptAttempts.get(ip)
    if (entry === undefined || now - entry.windowStart > ACCEPT_WINDOW_MS) {
      acceptAttempts.set(ip, { count: 1, windowStart: now })
      return false
    }
    entry.count += 1
    return entry.count > ACCEPT_MAX_ATTEMPTS
  }

  const handleIssue = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!requireMethod(req, res, 'POST')) return
    if (!loopbackFence(req)) {
      writeJson(res, 403, { ok: false, code: 'forbidden' })
      return
    }
    const body = await readJsonBody(req)
    if (body !== undefined && (body.workspaceId !== undefined && typeof body.workspaceId !== 'string' || body.address !== undefined && typeof body.address !== 'string')) {
      writeJson(res, 400, { ok: false, code: 'bad-payload' })
      return
    }
    const workspaceId = typeof body?.workspaceId === 'string' ? body.workspaceId : undefined
    const address = typeof body?.address === 'string' ? body.address : undefined
    try {
      const { token, expiresAt } = service.issue(workspaceId, address)
      const base =
        address === undefined ? service.publicBaseUrl ?? service.lanBaseUrl : service.lanBaseUrlFor(address)
      if (base === undefined) throw new Error('base unavailable')
      writeJson(res, 200, {
        ok: true,
        url: `${base}/?pair=${token}${workspaceId === undefined ? '' : `&workspace=${encodeURIComponent(workspaceId)}`}`,
        token,
        expiresAt,
        lanAddresses: service.lanAddresses,
        ...(service.publicBaseUrl !== undefined ? { publicBaseUrl: service.publicBaseUrl } : {}),
      })
    } catch (error) {
      const unknownAddress = error instanceof Error && error.name === 'UnknownLanAddressError'
      writeJson(res, unknownAddress ? 400 : 409, {
        ok: false,
        code: unknownAddress ? 'unknown-address' : 'lan-required',
      })
    }
  }

  const handleAccept = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!requireMethod(req, res, 'POST')) return
    if (!lanFence(req)) {
      writeJson(res, 403, { ok: false, code: 'forbidden' })
      return
    }
    if (rateLimited(req)) {
      writeJson(res, 429, { ok: false, code: 'rate-limited' })
      return
    }
    const body = await readJsonBody(req)
    const token = typeof body?.token === 'string' ? body.token : ''
    const result = service.accept(token)
    if (!result.ok) {
      writeJson(res, result.code === 'used' ? 409 : 404, { ok: false, code: result.code })
      return
    }
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'set-cookie': [
        `${service.cookieName}=${result.deviceId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${String(COOKIE_MAX_AGE_SEC)}`,
      ],
    })
    res.end(JSON.stringify({ ok: true, deviceId: result.deviceId }))
  }

  const handleStop = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!requireMethod(req, res, 'POST')) return
    if (!loopbackFence(req)) {
      writeJson(res, 403, { ok: false, code: 'forbidden' })
      return
    }
    await readJsonBody(req)
    service.stop()
    writeJson(res, 200, { ok: true })
  }

  const handleHeartbeat = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!requireMethod(req, res, 'POST')) return
    if (!lanFence(req)) {
      writeJson(res, 403, { ok: false, code: 'forbidden' })
      return
    }
    await readJsonBody(req)
    const deviceId = readCookie(req.headers.cookie, service.cookieName)
    if (deviceId === undefined || !service.heartbeat(deviceId)) {
      writeJson(res, 401, { ok: false, code: 'unpaired' })
      return
    }
    writeJson(res, 200, { ok: true })
  }

  const handleStatus = (req: IncomingMessage, res: ServerResponse): void => {
    if (!requireMethod(req, res, 'GET')) return
    if (!lanFence(req)) {
      writeJson(res, 403, { ok: false, code: 'forbidden' })
      return
    }
    const deviceId = readCookie(req.headers.cookie, service.cookieName)
    writeJson(res, 200, {
      ok: true,
      paired: deviceId !== undefined && service.hasDevice(deviceId),
      ...service.snapshot(),
    })
  }

  const handleEvents = (req: IncomingMessage, res: ServerResponse): void => {
    if (!requireMethod(req, res, 'GET')) return
    if (!loopbackFence(req)) {
      writeJson(res, 403, { ok: false, code: 'forbidden' })
      return
    }
    events.open(req, res)
    events.push(service.snapshot())
  }

  return [
    { kind: 'exact', path: PAIR_PATHS.issue, handler: handleIssue },
    { kind: 'exact', path: PAIR_PATHS.accept, handler: handleAccept },
    { kind: 'exact', path: PAIR_PATHS.stop, handler: handleStop },
    { kind: 'exact', path: PAIR_PATHS.heartbeat, handler: handleHeartbeat },
    { kind: 'exact', path: PAIR_PATHS.status, handler: handleStatus },
    { kind: 'exact', path: PAIR_PATHS.events, handler: handleEvents },
  ]
}
