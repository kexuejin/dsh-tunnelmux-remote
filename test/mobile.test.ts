import { describe, expect, it } from 'vitest'
import { Readable } from 'node:stream'
import { IncomingMessage, ServerResponse } from 'node:http'
import { PairingService } from '../src/pairing.ts'
import { dispatch, makeMobileRoutes, MOBILE_ALLOWLIST, MOBILE_API_PATHS, MOBILE_API_PREFIX } from '../src/mobile.ts'
import type { MobileApiProxy, MobileRoutesDeps } from '../src/mobile.ts'
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
  const { token } = service.issue()
  const accepted = service.accept(token)
  if (!accepted.ok) throw new Error('unreachable')
  return { service, deviceId: accepted.deviceId }
}

function fakeApiProxy(): MobileApiProxy {
  const ok = <T>(value: T) => ({ result: { ok: true, value } })
  return {
    events: {
      async *mux() {
        yield { type: 'hello' }
      },
    },
    workspace: { list: async () => ok({ items: [] }) },
    sessions: {
      create: async () => ok({ sessionId: 's-new' }),
      list: async () =>
        ok<{ items: Array<{ updatedAt: number; sessionId: string }> }>({
          items: [
            { sessionId: 'a', updatedAt: 300 },
            { sessionId: 'b', updatedAt: 200 },
            { sessionId: 'c', updatedAt: 100 },
            { sessionId: 'd', updatedAt: 50 },
            { sessionId: 'e', updatedAt: 40 },
            { sessionId: 'f', updatedAt: 30 },
          ],
        }),
      history: async () => ok({ messages: [] }),
      search: async () => ok({ items: [] }),
      prompt: async () => ok({ ok: true }),
      models: async () => ok({ items: [] }),
      selectModel: async () => ok({ ok: true }),
      rename: async () => ok({ ok: true }),
    },
  }
}

function makeExchange(deviceId: string, method = 'POST', url = '/m/api/session.list', body?: string) {
  const req = Readable.from(body ? [Buffer.from(body)] : []) as IncomingMessage & Readable
  req.method = method
  req.url = url
  req.headers = { cookie: `dsh_pair=${deviceId}` }
  Object.defineProperty(req, 'socket', { value: { remoteAddress: '192.168.1.5' }, configurable: true })
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
  raw.setHeader = () => res
  raw.write = (chunk: unknown) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
    return true
  }
  raw.end = (chunk?: unknown) => {
    if (chunk !== undefined) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
    res.emit('finish')
    return res
  }
  const bodyText = () => Buffer.concat(chunks).toString('utf8')
  const json = () => JSON.parse(bodyText())
  return { req, res, bodyText, json }
}

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

function makeDeps(apiProxy = fakeApiProxy()): MobileRoutesDeps & { service: PairingService; deviceId: string } {
  const { service, deviceId } = makeService()
  return {
    service,
    deviceId,
    apiProxy,
    lanAddresses: () => service.lanAddresses,
    mobileEnterToSend: () => true,
    mobileBundlePath: () => '/nonexistent/mobile.js',
  }
}

function findRoute(routes: RouteDef[], path: string): RouteDef {
  const route = routes.find((r) => r.path === path)
  if (!route) throw new Error('missing route ' + path)
  return route
}

describe('mobile routes', () => {
  it('serves the page shell', async () => {
    const deps = makeDeps()
    const routes = makeMobileRoutes(deps)
    const { req, res, bodyText } = makeExchange('', 'GET', '/m')
    await routes.find((r) => r.path === '/m')!.handler(req, res)
    expect(res.statusCode).toBe(200)
    expect(bodyText()).toContain('<!doctype html>')
    expect(bodyText()).toContain('/m/mobile.js')
  })

  it('serves 503 when the bundle is not built', async () => {
    const deps = makeDeps()
    const routes = makeMobileRoutes(deps)
    const { req, res } = makeExchange('', 'GET', '/m/mobile.js')
    await findRoute(routes, '/m/mobile.js').handler(req, res)
    expect(res.statusCode).toBe(503)
  })

  it('rejects unpaired calls with 403', async () => {
    const deps = makeDeps()
    const routes = makeMobileRoutes(deps)
    const req = Readable.from([]) as IncomingMessage & Readable
    req.method = 'POST'
    req.url = '/m/api/session.list'
    req.headers = {} // no cookie
    Object.defineProperty(req, 'socket', { value: { remoteAddress: '192.168.1.5' }, configurable: true })
    const res = new EventEmitterLike() as unknown as ServerResponse
    const chunks: Buffer[] = []
    res.writeHead = (status) => {
      res.statusCode = status
      return res
    }
    res.write = (chunk: unknown) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
      return true
    }
    res.end = (chunk?: unknown) => {
      if (chunk !== undefined) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
      return res
    }
    await findRoute(routes, MOBILE_API_PREFIX).handler(req, res)
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(Buffer.concat(chunks).toString('utf8')).error.code).toBe('unpaired')
  })

  it('rejects methods outside the allowlist', async () => {
    const deps = makeDeps()
    const routes = makeMobileRoutes(deps)
    const { req, res, json } = makeExchange(deps.deviceId, 'POST', '/m/api/settings.read', JSON.stringify({ rpcId: 'x' }))
    await findRoute(routes, MOBILE_API_PREFIX).handler(req, res)
    expect(res.statusCode).toBe(403)
    expect(json().error.code).toBe('forbidden')
  })

  it('answers mobile.preferences locally', async () => {
    const deps = makeDeps()
    const routes = makeMobileRoutes(deps)
    const { req, res, json } = makeExchange(deps.deviceId, 'POST', '/m/api/mobile.preferences', JSON.stringify({ rpcId: 'p1' }))
    await findRoute(routes, MOBILE_API_PREFIX).handler(req, res)
    expect(res.statusCode).toBe(200)
    expect(json().result.value.mobileEnterToSend).toBe(true)
  })

  it('proxies an allowlisted method through apiProxy', async () => {
    const deps = makeDeps()
    const routes = makeMobileRoutes(deps)
    const { req, res, json } = makeExchange(deps.deviceId, 'POST', '/m/api/session.create', JSON.stringify({ rpcId: 'c1', payload: { title: 'hi' } }))
    await findRoute(routes, MOBILE_API_PREFIX).handler(req, res)
    expect(res.statusCode).toBe(200)
    expect(json().result.value.sessionId).toBe('s-new')
  })

  it('rejects malformed bodies', async () => {
    const deps = makeDeps()
    const routes = makeMobileRoutes(deps)
    const { req, res, json } = makeExchange(deps.deviceId, 'POST', '/m/api/session.list', 'not-json')
    await findRoute(routes, MOBILE_API_PREFIX).handler(req, res)
    expect(res.statusCode).toBe(400)
    expect(json().error.code).toBe('bad-request')
  })

  it('requires rpcId', async () => {
    const deps = makeDeps()
    const routes = makeMobileRoutes(deps)
    const { req, res, json } = makeExchange(deps.deviceId, 'POST', '/m/api/session.list', JSON.stringify({ payload: {} }))
    await findRoute(routes, MOBILE_API_PREFIX).handler(req, res)
    expect(res.statusCode).toBe(400)
    expect(json().error.code).toBe('bad-request')
  })

  it('events.mux requires a paired cookie', async () => {
    const deps = makeDeps()
    const routes = makeMobileRoutes(deps)
    const req = Readable.from([]) as IncomingMessage & Readable
    req.method = 'GET'
    req.url = MOBILE_API_PATHS.events
    req.headers = {}
    Object.defineProperty(req, 'socket', { value: { remoteAddress: '192.168.1.5' }, configurable: true })
    const res = new EventEmitterLike() as unknown as ServerResponse
    res.writeHead = (status) => {
      res.statusCode = status
      return res
    }
    res.write = () => true
    res.end = () => res
    await findRoute(routes, MOBILE_API_PATHS.events).handler(req, res)
    expect(res.statusCode).toBe(403)
  })
})

describe('session.list pagination', () => {
  const apiProxy = fakeApiProxy()

  it('pages by updatedAt desc with a cursor', async () => {
    const first = (await dispatch(apiProxy, 'session.list', {}, 'r1')) as {
      result: { value: { items: Array<{ sessionId: string }>; hasMore: boolean; nextCursor?: string } }
    }
    expect(first.result.value.items.map((i) => i.sessionId)).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
    expect(first.result.value.hasMore).toBe(false)
  })

  it('allowlist contains the designed session methods', () => {
    expect(MOBILE_ALLOWLIST.has('session.prompt')).toBe(true)
    expect(MOBILE_ALLOWLIST.has('workspace.list')).toBe(true)
    expect(MOBILE_ALLOWLIST.has('session.rename')).toBe(true)
    expect(MOBILE_ALLOWLIST.has('settings.write')).toBe(false)
  })
})
