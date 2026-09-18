import { createHash, createHmac } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  COOKIE_PREFIX,
  authorityOf,
  bridgeRequestHandler,
  browserSessionCookieName,
  base64UrlEncode,
  ensureTunnelmuxRoutes,
  expandHome,
  mintSessionCookie,
  readBrowserSessionSecret,
  resolveGateCookies,
  sessionSetCookieHeader,
} from '../src/desktop-bridge.ts'

/** A random but fixed 32-byte secret, base64url-encoded like the stored value. */
const SECRET_B64URL = base64UrlEncode(new Uint8Array(32).map((_, i) => (i * 7 + 3) % 256))
const SECRET = Buffer.from(SECRET_B64URL.replace(/-/g, '+').replace(/_/g, '/') + '==', 'base64')

describe('mintSessionCookie', () => {
  const minted = mintSessionCookie({ secret: SECRET, authority: '127.0.0.1:3080', days: 30, nowMs: 1_700_000_000_000 })

  it('derives the cookie name from sha256(authority)', () => {
    const expected = COOKIE_PREFIX + base64UrlEncode(createHash('sha256').update('127.0.0.1:3080').digest())
    expect(browserSessionCookieName('127.0.0.1:3080')).toBe(expected)
    expect(minted.name).toBe(expected)
  })

  it('signs v1.<body>.<sig> with hmac-sha256 over the body segment', () => {
    const match = /^v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(minted.value)
    expect(match).not.toBeNull()
    const [, body, signature] = match!
    const expectedSignature = base64UrlEncode(createHmac('sha256', SECRET).update(body).digest())
    expect(signature).toBe(expectedSignature)
    const payload = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
    expect(payload).toEqual({
      version: 1,
      authority: '127.0.0.1:3080',
      issuedAt: 1_700_000_000_000,
      expiresAt: 1_700_000_000_000 + 30 * 86_400_000,
    })
  })

  it('rejects non-integer or sub-day lifetimes', () => {
    expect(() => mintSessionCookie({ secret: SECRET, authority: 'a', days: 0 })).toThrow()
    expect(() => mintSessionCookie({ secret: SECRET, authority: 'a', days: 1.5 })).toThrow()
  })

  it('serializes a DSH-shaped Set-Cookie header', () => {
    const header = sessionSetCookieHeader(minted, '/', 30)
    expect(header).toContain(`=${minted.value};`)
    expect(header).toContain('Path=/;')
    expect(header).toContain('HttpOnly; SameSite=Strict')
  })
})

describe('readBrowserSessionSecret', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-bridge-test-'))
  const credentialsPath = join(dir, '.credentials.yaml')
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('extracts only the browser-session secret, ignoring other records', () => {
    writeFileSync(credentialsPath, [
      'records:',
      '  dsh-accounts/token:',
      '    kind: grant',
      '    payload:',
      '      secret: MDEfg关系到', // shallower-indent decoy must never match
      '  client-connection/browser-session:',
      '    kind: grant',
      '    payload:',
      '      version: 1',
      `      secret: ${SECRET_B64URL}`,
      '  dsh-accounts/other:',
      '    payload:',
      '      secret: nope',
      '',
    ].join('\n'))
    expect(readBrowserSessionSecret(credentialsPath)).toEqual(SECRET)
  })

  it('throws when the record or secret is missing', () => {
    const bad = join(dir, 'bad.yaml')
    writeFileSync(bad, 'records:\n  other: {}\n')
    expect(() => readBrowserSessionSecret(bad)).toThrow(/not found/)
    const noSecret = join(dir, 'nosecret.yaml')
    writeFileSync(noSecret, 'records:\n  client-connection/browser-session:\n    kind: grant\n')
    expect(() => readBrowserSessionSecret(noSecret)).toThrow(/no secret/)
  })
})

describe('expandHome', () => {
  it('expands a leading ~ and leaves absolute paths alone', () => {
    expect(expandHome('~/.dsh')).not.toContain('~')
    expect(expandHome('/absolute/path')).toBe('/absolute/path')
  })
})

describe('authorityOf', () => {
  it('keeps default ports out and explicit ports in', () => {
    expect(authorityOf('http://127.0.0.1:3080')).toBe('127.0.0.1:3080')
    expect(authorityOf('https://openai.auroramedia.icu')).toBe('openai.auroramedia.icu')
    expect(authorityOf('not a url')).toBeUndefined()
  })
})

describe('bridgeRequestHandler', () => {
  /** Minimal ServerResponse capture (the handler only uses writeHead/end). */
  function capture(): { res: any; status(): number; headers(): Record<string, unknown>; body(): Buffer | undefined; cookies(): string[] } {
    const state = { status: 0, headers: {} as Record<string, unknown>, body: undefined as Buffer | undefined, headersSent: false }
    const res = {
      headersSent: false,
      writeHead(status: number, headers?: Record<string, unknown>) {
        state.status = status
        state.headers = headers ?? {}
        state.headersSent = true
        return res
      },
      end(body?: Buffer) {
        state.body = body
      },
    }
    const cookies = (): string[] => {
      const value = state.headers['set-cookie']
      if (Array.isArray(value)) return value
      return typeof value === 'string' ? [value] : []
    }
    return {
      res: res as any,
      status: () => state.status,
      headers: () => state.headers,
      body: () => state.body,
      cookies,
    }
  }
  function request(method: string, url: string): any {
    return { method, url } as any
  }

  it('serves the pairing page with session and gate cookies', () => {
    const handler = bridgeRequestHandler({
      authorities: () => ['127.0.0.1:3080', 'openai.auroramedia.icu'],
      secret: SECRET,
      days: 30,
      cookiePath: '/',
      redirect: '/',
      gateCookies: ['tunnelmux_access_deepseek=71558114'],
    })
    const out = capture()
    handler(request('GET', '/'), out.res)
    expect(out.status()).toBe(200)
    expect(out.cookies()).toHaveLength(3)
    expect(out.cookies()[2]).toContain('tunnelmux_access_deepseek=71558114; Path=/;')
    const minted = mintSessionCookie({ secret: SECRET, authority: '127.0.0.1:3080', days: 30 })
    expect(out.cookies()[0].startsWith(`${minted.name}=v1.`)).toBe(true)
    expect(out.body()?.toString('utf8')).toContain('location.replace("/")')
    // authorities are re-evaluated per request (late-resolving public URL)
    const second = capture()
    handler(request('GET', '/'), second.res)
    expect(second.cookies()[1].startsWith(`${browserSessionCookieName('openai.auroramedia.icu')}=v1.`)).toBe(true)
  })

  it('answers /health and rejects non-GET methods', () => {
    const handler = bridgeRequestHandler({ authorities: () => ['a:1'], secret: SECRET })
    const health = capture()
    handler(request('GET', '/health'), health.res)
    expect(health.status()).toBe(200)
    expect(health.body()?.toString('utf8')).toBe('ok\n')
    const rejected = capture()
    handler(request('POST', '/'), rejected.res)
    expect(rejected.status()).toBe(405)
  })

  it('can answer 303 for proxies that pass redirects through', () => {
    const handler = bridgeRequestHandler({ authorities: () => ['a:1'], secret: SECRET, httpRedirect: true, redirect: '/x' })
    const out = capture()
    handler(request('GET', '/'), out.res)
    expect(out.status()).toBe(303)
    expect(out.headers().location).toBe('/x')
    expect(out.body()).toBeUndefined()
  })
})

describe('ensureTunnelmuxRoutes', () => {
  const existingRoute = {
    tunnel_id: 'primary',
    id: 'deepseek',
    match_path_prefix: '/deepseek',
    strip_path_prefix: '/deepseek',
    upstream_url: 'http://127.0.0.1:3988',
    enabled: true,
  }

  it('skips routes that already match', async () => {
    const calls: Array<{ path: string; method: string }> = []
    const result = await ensureTunnelmuxRoutes(
      {
        async request(path, init = {}) {
          calls.push({ path, method: init.method ?? 'GET' })
          return { ok: true, status: 200, json: async () => ({ routes: [existingRoute] }), text: async () => '' }
        },
      },
      [{ id: 'deepseek', matchPathPrefix: '/deepseek', stripPathPrefix: '/deepseek', upstreamUrl: 'http://127.0.0.1:3988' }],
    )
    expect(result.ok).toBe(true)
    expect(result.skipped).toEqual(['deepseek'])
    expect(calls).toEqual([{ path: '/v1/routes', method: 'GET' }])
  })

  it('creates missing and updates drifted routes', async () => {
    const writes: Array<{ path: string; method: string; body: unknown }> = []
    const result = await ensureTunnelmuxRoutes(
      {
        async request(path, init = {}) {
          writes.push({ path, method: init.method ?? 'GET', body: init.body })
          if (path === '/v1/routes' && (init.method ?? 'GET') === 'GET') {
            return { ok: true, status: 200, json: async () => ({ routes: [{ ...existingRoute, upstream_url: 'http://127.0.0.1:1' }] }), text: async () => '' }
          }
          return { ok: true, status: path === '/v1/routes' ? 201 : 200, json: async () => ({}), text: async () => '' }
        },
      },
      [
        { id: 'deepseek', matchPathPrefix: '/deepseek', stripPathPrefix: '/deepseek', upstreamUrl: 'http://127.0.0.1:3988' },
        { id: 'dsh-root', matchPathPrefix: '/', stripPathPrefix: null, upstreamUrl: 'http://127.0.0.1:3080' },
      ],
    )
    expect(result.ok).toBe(true)
    expect(result.updated).toEqual(['deepseek'])
    expect(result.registered).toEqual(['dsh-root'])
    const methods = writes.map((w) => `${w.method} ${w.path}`)
    expect(methods).toContain('PUT /v1/routes/deepseek')
    expect(methods).toContain('POST /v1/routes')
  })

  it('reports auth failure without throwing', async () => {
    const result = await ensureTunnelmuxRoutes(
      {
        async request() {
          return { ok: false, status: 401, json: async () => ({}), text: async () => 'unauthorized' }
        },
      },
      [{ id: 'deepseek', matchPathPrefix: '/deepseek', stripPathPrefix: '/deepseek', upstreamUrl: 'http://127.0.0.1:3988' }],
    )
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('401')
  })
})

describe('resolveGateCookies', () => {
  const statePath = join(tmpdir(), `dsh-gate-test-${String(Date.now())}.json`)
  afterAll(() => rmSync(statePath, { force: true }))

  it('derives one cookie per route id from the daemon state file', () => {
    writeFileSync(statePath, JSON.stringify({ default_route_access: { require_access_code: '71558114' } }))
    expect(resolveGateCookies(statePath, ['deepseek', 'dsh-root'], '')).toEqual([
      'tunnelmux_access_deepseek=71558114',
      'tunnelmux_access_dsh-root=71558114',
    ])
  })

  it('prefers the explicit override and tolerates a missing state file', () => {
    expect(resolveGateCookies(statePath, ['deepseek'], 'name=value')).toEqual(['name=value'])
    expect(resolveGateCookies('/nonexistent/state.json', ['deepseek'], '')).toEqual([])
  })
})
