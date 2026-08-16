/**
 * Mobile surface for dsh-tunnelmux-remote: serves the standalone phone page
 * (/m), the mobile bundle (/m/mobile.js), and the /m/api RPC channel with an
 * allowlist bridged through the host apiProxy. The phone talks exclusively
 * through the shared /api transport — the paired-device cookie crosses the
 * same fence as the pairing routes.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { PairingService } from './pairing.ts'
import type { RouteDef } from './routes.ts'
import { isTrustedRequest, publicHostOf } from './routes.ts'

/** Methods the phone surface may call. Everything else is refused. */
export const MOBILE_ALLOWLIST = new Set([
  'workspace.list',
  'session.create',
  'session.list',
  'session.history',
  'session.search',
  'session.prompt',
  'session.models',
  'session.selectModel',
  'session.rename',
])

/** Locally answered display-preference method (never proxied). */
export const MOBILE_PREFERENCES_METHOD = 'mobile.preferences'

/** One session.list page (thin phones load incrementally). */
const SESSION_PAGE_SIZE = 20

/** SSE keep-alive ping cadence for the live mux stream. */
const DEFAULT_EVENTS_HEARTBEAT_MS = 15_000

export const MOBILE_API_PREFIX = '/m/api'
export const MOBILE_API_METHOD_PREFIX = MOBILE_API_PREFIX + '/'
export const MOBILE_API_PATHS = { events: '/m/api/events.mux' } as const

function sessionListCursor(updatedAt: number, sessionId: string): string {
  return `${updatedAt}:${sessionId}`
}

function parseSessionListCursor(cursor: string | undefined): { updatedAt: number; sessionId: string } | undefined {
  if (!cursor) return undefined
  const separator = cursor.indexOf(':')
  if (separator < 0) return undefined
  const updatedAt = Number(cursor.slice(0, separator))
  if (!Number.isFinite(updatedAt)) return undefined
  return { updatedAt, sessionId: cursor.slice(separator + 1) }
}

function afterCursor(row: { updatedAt: number; sessionId: string }, position: { updatedAt: number; sessionId: string }): boolean {
  return row.updatedAt < position.updatedAt || (row.updatedAt === position.updatedAt && row.sessionId > position.sessionId)
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return rest.join('=') || undefined
  }
  return undefined
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > 64 * 1024) throw new Error('body too large')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** A minimal structural subset of the host apiProxy used by the mobile channel. */
export interface MobileApiProxy {
  events: {
    mux(request: { rpcId: unknown; payload: unknown }, signal: AbortSignal): AsyncIterable<unknown>
  }
  workspace: { list(request: unknown): Promise<{ result: { ok: boolean; value?: unknown } }> }
  sessions: {
    create(request: unknown): Promise<{ result: { ok: boolean; value?: unknown } }>
    list(request: unknown): Promise<{ result: { ok: boolean; value: { items: Array<{ updatedAt: number; sessionId: string }> } } }>
    history(request: unknown): Promise<{ result: { ok: boolean; value?: unknown } }>
    search(request: unknown, signal: AbortSignal): Promise<{ result: { ok: boolean; value?: unknown } }>
    prompt(request: unknown): Promise<{ result: { ok: boolean; value?: unknown } }>
    models(request: unknown): Promise<{ result: { ok: boolean; value?: unknown } }>
    selectModel(request: unknown): Promise<{ result: { ok: boolean; value?: unknown } }>
    rename(request: unknown): Promise<{ result: { ok: boolean; value?: unknown } }>
  }
}

export interface MobileRoutesDeps {
  service: PairingService
  apiProxy: MobileApiProxy
  lanAddresses: () => string[]
  mobileEnterToSend: () => boolean
  eventsHeartbeatMs?: number
  mobileBundlePath?: () => string
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function writeStatic(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, {
    'content-type': `${type}; charset=utf-8`,
    'cache-control': 'no-cache',
    'referrer-policy': 'no-referrer',
  })
  res.end(body)
}

function pageHtml(bundleUrl: string): string {
  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">',
    '<meta name="theme-color" content="#f3f5f9">',
    '<meta name="referrer" content="no-referrer">',
    '<link rel="apple-touch-icon" href="/m/apple-touch-icon.png">',
    '<title>移动端远程控制</title>',
    '</head>',
    '<body>',
    '<div id="root"></div>',
    `<script type="module" src="${bundleUrl}"><\/script>`,
    '</body>',
    '</html>',
  ].join('')
}

export function defaultMobileBundlePath(): string {
  return fileURLToPath(new URL('../lib/mobile.js', import.meta.url))
}

/** Build the mobile page + API routes. */
export function makeMobileRoutes(deps: MobileRoutesDeps): RouteDef[] {
  const { service, apiProxy, lanAddresses, mobileEnterToSend } = deps
  const eventsHeartbeatMs = deps.eventsHeartbeatMs ?? DEFAULT_EVENTS_HEARTBEAT_MS
  const bundlePath = deps.mobileBundlePath ?? defaultMobileBundlePath

  const gateOk = (req: IncomingMessage): boolean => {
    const deviceId = readCookie(req.headers.cookie, service.cookieName)
    return deviceId !== undefined && service.touchDevice(deviceId)
  }

  const handlePage = (_req: IncomingMessage, res: ServerResponse): void => {
    writeStatic(res, 200, 'text/html', pageHtml('/m/mobile.js'))
  }

  const handleBundle = async (_req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = bundlePath()
    if (!existsSync(path)) {
      writeStatic(res, 503, 'text/plain', 'mobile bundle not built: run pnpm --filter dsh-tunnelmux-remote build')
      return
    }
    try {
      writeStatic(res, 200, 'text/javascript', await readFile(path, 'utf8'))
    } catch {
      writeStatic(res, 500, 'text/plain', 'failed to read the mobile bundle')
    }
  }

  const handleMethod = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'POST') {
      res.writeHead(405)
      res.end()
      return
    }
    if (!gateOk(req)) {
      writeJson(res, 403, { ok: false, error: { code: 'unpaired', message: 'mobile session is not paired' } })
      return
    }
    const pathname = new URL(req.url ?? '/', 'http://x').pathname
    if (!pathname.startsWith(MOBILE_API_METHOD_PREFIX)) {
      writeJson(res, 404, { ok: false, error: { code: 'not-found', message: 'unknown mobile api path' } })
      return
    }
    const method = pathname.slice(MOBILE_API_METHOD_PREFIX.length)
    const local = method === MOBILE_PREFERENCES_METHOD
    if (!MOBILE_ALLOWLIST.has(method) && !local) {
      writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: `method ${method} is not exposed to the mobile surface` } })
      return
    }
    let envelope: { rpcId?: unknown; payload?: unknown } = {}
    try {
      const parsed = (await readJsonBody(req)) as { rpcId?: unknown; payload?: unknown }
      envelope = parsed ?? {}
    } catch {
      writeJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'invalid json body' } })
      return
    }
    const rpcId = typeof envelope.rpcId === 'string' ? envelope.rpcId : ''
    if (rpcId === '') {
      writeJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'missing rpcId' } })
      return
    }
    if (local) {
      writeJson(res, 200, { type: 'server-response', rpcId, result: { ok: true, value: { mobileEnterToSend: mobileEnterToSend() } } })
      return
    }
    try {
      const response = await dispatch(apiProxy, method, envelope.payload, rpcId)
      writeJson(res, 200, response)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      writeJson(res, 200, {
        type: 'server-response',
        rpcId,
        result: { ok: false, error: { code: 'internal', message } },
      })
    }
  }

  const handleEvents = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'GET') {
      res.writeHead(405)
      res.end()
      return
    }
    if (!gateOk(req)) {
      res.writeHead(403)
      res.end('forbidden')
      return
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const controller = new AbortController()
    let closed = false
    const heartbeat = setInterval(() => {
      if (closed) return
      const deviceId = readCookie(req.headers.cookie, service.cookieName)
      if (deviceId !== undefined) service.touchDevice(deviceId)
      try {
        res.write(': ping\n\n')
      } catch {
        /* stream closed */
      }
    }, eventsHeartbeatMs)
    const onClose = () => {
      if (closed) return
      closed = true
      controller.abort()
      clearInterval(heartbeat)
    }
    res.on('close', onClose)
    req.on('close', onClose)
    try {
      const frames = apiProxy.events.mux(
        { rpcId: `mobile-mux-${Date.now().toString(36)}`, payload: {} },
        controller.signal,
      )
      for await (const frame of frames) {
        if (closed) break
        res.write(`data: ${JSON.stringify(frame)}\n\n`)
      }
    } catch {
      /* stream ended */
    } finally {
      controller.abort()
      clearInterval(heartbeat)
    }
    if (!closed) res.end()
  }

  return [
    { kind: 'exact', path: '/m', handler: handlePage },
    { kind: 'exact', path: '/m/mobile.js', handler: handleBundle },
    { kind: 'prefix', path: MOBILE_API_PREFIX, handler: handleMethod },
    { kind: 'exact', path: MOBILE_API_PATHS.events, handler: handleEvents },
  ]
}

/** Dispatch one allowlisted method through the host apiProxy. */
export async function dispatch(
  apiProxy: MobileApiProxy,
  method: string,
  payload: unknown,
  rpcId: string,
): Promise<unknown> {
  const request = { rpcId, payload }
  if (method === 'session.list') {
    const full = await apiProxy.sessions.list(request)
    if (!full.result.ok) return full
    const items = full.result.value.items
    const cursor = (payload as { cursor?: string } | undefined)?.cursor
    items.sort((a, b) => b.updatedAt - a.updatedAt || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0))
    const position = parseSessionListCursor(cursor)
    const from = position === undefined ? 0 : items.findIndex((row) => afterCursor(row, position))
    const start = from < 0 ? items.length : from
    const page = items.slice(start, start + SESSION_PAGE_SIZE)
    const last = page[page.length - 1]
    const nextCursor = last !== undefined && start + page.length < items.length ? sessionListCursor(last.updatedAt, last.sessionId) : undefined
    return {
      type: 'server-response',
      rpcId,
      result: { ok: true, value: { items: page, hasMore: nextCursor !== undefined, ...(nextCursor !== undefined ? { nextCursor } : {}) } },
    }
  }
  const wrap = (response: { result: unknown }) => ({ type: 'server-response', rpcId, result: response.result })
  if (method === 'workspace.list') return wrap(await apiProxy.workspace.list(request))
  if (method === 'session.create') return wrap(await apiProxy.sessions.create(request))
  if (method === 'session.history') return wrap(await apiProxy.sessions.history(request))
  if (method === 'session.search') return wrap(await apiProxy.sessions.search(request, new AbortController().signal))
  if (method === 'session.prompt') return wrap(await apiProxy.sessions.prompt(request))
  if (method === 'session.models') return wrap(await apiProxy.sessions.models(request))
  if (method === 'session.selectModel') return wrap(await apiProxy.sessions.selectModel(request))
  if (method === 'session.rename') return wrap(await apiProxy.sessions.rename(request))
  throw new Error(`unhandled allowlisted method ${method}`)
}
