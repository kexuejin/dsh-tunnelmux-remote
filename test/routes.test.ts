import { describe, expect, it } from 'vitest'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { PairingService } from '../src/pairing.ts'
import { makePairingRoutes, PAIR_PATHS, lanIPv4Addresses } from '../src/routes.ts'
import type { RouteDef } from '../src/routes.ts'

const CONFIG = {
  tokenTtlMs: 600_000,
  offlineAfterMs: 25_000,
  maxDevices: 4,
  cookieName: 'dsh_pair',
}

function makeService() {
  const service = new PairingService(CONFIG, {
    now: () => Date.now(),
    randomToken: () => 'tok-' + Math.random().toString(36).slice(2),
  })
  service.setLanBases([{ address: '192.168.1.5', base: 'http://192.168.1.5:3080' }])
  return service
}

/** Minimal fake req/res pair for handler testing. */
function makeExchange(remoteAddress = '127.0.0.1', cookie = '', method = 'POST') {
  const req = Readable.from([]) as IncomingMessage & Readable
  req.method = method
  req.url = '/'
  req.headers = { ...(cookie ? { cookie } : {}) }
  Object.defineProperty(req, 'socket', { value: { remoteAddress }, configurable: true })
  const res = new EventEmitterLike() as unknown as ServerResponse
  const raw = res as unknown as {
    statusCode: number
    headersSent: boolean
    writeHead(status: number, headers?: Record<string, string | string[]>): unknown
    setHeader(name: string, value: string | string[]): unknown
    write(chunk: unknown): boolean
    end(chunk?: unknown): unknown
    emit(event: string): void
  }
  const chunks: Buffer[] = []
  raw.writeHead = (status, headers) => {
    raw.statusCode = status
    raw.headersSent = true
    if (headers !== undefined) {
      for (const [name, value] of Object.entries(headers)) {
        raw.setHeader(name, value)
      }
    }
    return res
  }
  raw.setHeader = (name: string, value: string | string[]) => {
    ;(res as unknown as { _h: Record<string, unknown> })._h ??= {}
    ;(res as unknown as { _h: Record<string, unknown> })._h[name] = value
  }
  raw.write = (chunk: unknown) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
    return true
  }
  raw.end = (chunk?: unknown) => {
    if (chunk !== undefined) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
    res.emit('finish')
    return res
  }
  const headers = () => (res as unknown as { _h: Record<string, unknown> })._h ?? {}
  const body = () => Buffer.concat(chunks).toString('utf8')
  const json = () => JSON.parse(body())
  return { req, res, headers, body, json }
}

/** Minimal event emitter with .on/.emit for the ServerResponse surface. */
class EventEmitterLike {
  private listeners = new Map<string, Array<() => void>>()
  on(event: string, fn: () => void) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), fn])
    return this
  }
  emit(event: string) {
    for (const fn of this.listeners.get(event) ?? []) fn()
  }
}

async function runHandler(route: RouteDef, req: IncomingMessage, res: ServerResponse) {
  await route.handler(req, res)
}

function findRoute(routes: RouteDef[], path: string): RouteDef {
  const route = routes.find((r) => r.path === path)
  if (!route) throw new Error('missing route ' + path)
  return route
}

describe('pairing routes', () => {
  it('issue is loopback-only and mints a QR link', async () => {
    const service = makeService()
    const routes = makePairingRoutes({ service, lanAddresses: () => service.lanAddresses })
    const { req, res, json } = makeExchange()
    await runHandler(findRoute(routes, PAIR_PATHS.issue), req, res)
    expect(res.statusCode).toBe(200)
    const payload = json()
    expect(payload.ok).toBe(true)
    expect(payload.url).toContain('http://192.168.1.5:3080/?pair=')
  })

  it('issue from a non-loopback address is forbidden', async () => {
    const service = makeService()
    const routes = makePairingRoutes({ service, lanAddresses: () => service.lanAddresses })
    const { req, res, json } = makeExchange('10.0.0.9')
    await runHandler(findRoute(routes, PAIR_PATHS.issue), req, res)
    expect(res.statusCode).toBe(403)
    expect(json().code).toBe('forbidden')
  })

  it('accept from a LAN literal works and sets the cookie', async () => {
    const service = makeService()
    const routes = makePairingRoutes({ service, lanAddresses: () => service.lanAddresses })
    const { token } = service.issue()
    const { req, res, headers, json } = makeExchange('192.168.1.5')
    req.push(Buffer.from(JSON.stringify({ token })))
    req.push(null)
    await runHandler(findRoute(routes, PAIR_PATHS.accept), req, res)
    expect(res.statusCode).toBe(200)
    expect(json().ok).toBe(true)
    const cookie = String(headers()['set-cookie'])
    expect(cookie).toContain('dsh_pair=')
    expect(cookie).toContain('HttpOnly')
  })

  it('accept from an unknown host is forbidden', async () => {
    const service = makeService()
    const routes = makePairingRoutes({ service, lanAddresses: () => service.lanAddresses })
    const { token } = service.issue()
    const { req, res, json } = makeExchange('203.0.113.7')
    req.push(Buffer.from(JSON.stringify({ token })))
    req.push(null)
    await runHandler(findRoute(routes, PAIR_PATHS.accept), req, res)
    expect(res.statusCode).toBe(403)
    expect(json().code).toBe('forbidden')
  })

  it('accept from the public tunnel host works once a tunnel is running', async () => {
    const service = makeService()
    service.setPublicBaseUrl('https://abc.trycloudflare.com')
    const routes = makePairingRoutes({ service, lanAddresses: () => service.lanAddresses })
    const { token } = service.issue()
    const { req, res } = makeExchange('104.18.1.1')
    req.headers.host = 'abc.trycloudflare.com'
    req.push(Buffer.from(JSON.stringify({ token })))
    req.push(null)
    await runHandler(findRoute(routes, PAIR_PATHS.accept), req, res)
    expect(res.statusCode).toBe(200)
  })

  it('accept rate-limits a single source IP', async () => {
    const service = makeService()
    const routes = makePairingRoutes({ service, lanAddresses: () => service.lanAddresses })
    for (let i = 0; i < 10; i += 1) {
      const { token } = service.issue()
      const { req, res } = makeExchange('192.168.1.5')
      req.push(Buffer.from(JSON.stringify({ token })))
      req.push(null)
      await runHandler(findRoute(routes, PAIR_PATHS.accept), req, res)
      expect(res.statusCode).toBe(200)
    }
    // The 11th attempt is rate-limited even with a valid token.
    const { token } = service.issue()
    const { req, res, json } = makeExchange('192.168.1.5')
    req.push(Buffer.from(JSON.stringify({ token })))
    req.push(null)
    await runHandler(findRoute(routes, PAIR_PATHS.accept), req, res)
    expect(res.statusCode).toBe(429)
    expect(json().code).toBe('rate-limited')
  })

  it('reuses of a consumed token returns 409 used', async () => {
    const service = makeService()
    const routes = makePairingRoutes({ service, lanAddresses: () => service.lanAddresses })
    const { token } = service.issue()
    const { req: req1, res: res1 } = makeExchange('192.168.1.5')
    req1.push(Buffer.from(JSON.stringify({ token })))
    req1.push(null)
    await runHandler(findRoute(routes, PAIR_PATHS.accept), req1, res1)
    const { req: req2, res: res2, json } = makeExchange('192.168.1.5')
    req2.push(Buffer.from(JSON.stringify({ token })))
    req2.push(null)
    await runHandler(findRoute(routes, PAIR_PATHS.accept), req2, res2)
    expect(res2.statusCode).toBe(409)
    expect(json().code).toBe('used')
  })

  it('stop is loopback-only and revokes everything', async () => {
    const service = makeService()
    const routes = makePairingRoutes({ service, lanAddresses: () => service.lanAddresses })
    const { token } = service.issue()
    service.accept(token)
    expect(service.snapshot().deviceCount).toBe(1)
    const { req, res, json } = makeExchange('10.0.0.9')
    await runHandler(findRoute(routes, PAIR_PATHS.stop), req, res)
    expect(res.statusCode).toBe(403)
    expect(service.snapshot().deviceCount).toBe(1) // not stopped
    const { req: req2, res: res2 } = makeExchange()
    req2.push(Buffer.from('{}'))
    req2.push(null)
    await runHandler(findRoute(routes, PAIR_PATHS.stop), req2, res2)
    expect(res2.statusCode).toBe(200)
    expect(service.snapshot().phase).toBe('stopped')
  })

  it('heartbeat requires a live paired cookie', async () => {
    const service = makeService()
    const routes = makePairingRoutes({ service, lanAddresses: () => service.lanAddresses })
    const { token } = service.issue()
    const accepted = service.accept(token)
    if (!accepted.ok) throw new Error('unreachable')
    // No cookie → 401
    const { req, res, json } = makeExchange('192.168.1.5')
    req.push(Buffer.from('{}'))
    req.push(null)
    await runHandler(findRoute(routes, PAIR_PATHS.heartbeat), req, res)
    expect(res.statusCode).toBe(401)
    expect(json().code).toBe('unpaired')
    // With cookie → 200
    const { req: req2, res: res2 } = makeExchange('192.168.1.5', `dsh_pair=${accepted.deviceId}`)
    req2.push(Buffer.from('{}'))
    req2.push(null)
    await runHandler(findRoute(routes, PAIR_PATHS.heartbeat), req2, res2)
    expect(res2.statusCode).toBe(200)
  })

  it('status reports pairing state', async () => {
    const service = makeService()
    const routes = makePairingRoutes({ service, lanAddresses: () => service.lanAddresses })
    const { req, res, json } = makeExchange('192.168.1.5')
    req.method = 'GET'
    await runHandler(findRoute(routes, PAIR_PATHS.status), req, res)
    expect(res.statusCode).toBe(200)
    const payload = json()
    expect(payload.paired).toBe(false)
    expect(payload.lanAddresses).toEqual(['192.168.1.5'])
  })

  it('events is loopback-only SSE', async () => {
    const service = makeService()
    const routes = makePairingRoutes({ service, lanAddresses: () => service.lanAddresses })
    const { req, res } = makeExchange('10.0.0.9')
    req.method = 'GET'
    await runHandler(findRoute(routes, PAIR_PATHS.events), req, res)
    expect(res.statusCode).toBe(403)
  })

  it('bad payload shape on issue returns 400', async () => {
    const service = makeService()
    const routes = makePairingRoutes({ service, lanAddresses: () => service.lanAddresses })
    const { req, res, json } = makeExchange()
    req.push(Buffer.from(JSON.stringify({ workspaceId: 42 })))
    req.push(null)
    await runHandler(findRoute(routes, PAIR_PATHS.issue), req, res)
    expect(res.statusCode).toBe(400)
    expect(json().code).toBe('bad-payload')
  })
})

describe('lanIPv4Addresses', () => {
  it('returns a list (possibly empty) of non-internal IPv4 addresses', () => {
    const addresses = lanIPv4Addresses()
    expect(Array.isArray(addresses)).toBe(true)
  })
})
