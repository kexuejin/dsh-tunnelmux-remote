import { describe, expect, it, vi } from 'vitest'
import { TunnelMuxTunnelManager, createTunnelMuxHttpClient, type TunnelMuxHttpClient } from '../src/tunnelmux.ts'

/** Fake HTTP client driven by a handler. */
function fakeClient(handler: (path: string, init?: { method?: string; body?: unknown }) => {
  ok: boolean
  status: number
  json: unknown
  text: string
}): TunnelMuxHttpClient {
  return {
    async request(path, init = {}) {
      const result = handler(path, init)
      return {
        ok: result.ok,
        status: result.status,
        json: async () => result.json,
        text: async () => result.text,
      }
    },
  }
}

const START_OK = {
  tunnel_id: 'dsh-remote',
  tunnel: {
    state: 'running',
    provider: 'cloudflared',
    target_url: 'http://127.0.0.1:3080',
    public_base_url: 'https://abc.trycloudflare.com',
    auto_restart: true,
  },
}

describe('TunnelMuxTunnelManager', () => {
  it('starts and reads the public URL synchronously from the start response', async () => {
    const calls: string[] = []
    const manager = new TunnelMuxTunnelManager(
      fakeClient((path) => {
        calls.push(path)
        if (path === '/v1/health') return { ok: true, status: 200, json: { ok: true }, text: '' }
        if (path === '/v1/tunnel/start') return { ok: true, status: 200, json: START_OK, text: '' }
        throw new Error('unexpected path ' + path)
      }),
    )
    const info = await manager.start()
    expect(info.phase).toBe('running')
    expect(info.url).toBe('https://abc.trycloudflare.com')
    expect(info.daemonOk).toBe(true)
    expect(calls).toContain('/v1/health')
    expect(calls).toContain('/v1/tunnel/start')
  })

  it('sends tunnel_id, provider, target_url and auto_restart to start', async () => {
    let body: unknown
    const manager = new TunnelMuxTunnelManager(
      fakeClient((path, init) => {
        if (path === '/v1/health') return { ok: true, status: 200, json: {}, text: '' }
        if (path === '/v1/tunnel/start') {
          body = init?.body
          return { ok: true, status: 200, json: START_OK, text: '' }
        }
        return { ok: true, status: 200, json: {}, text: '' }
      }),
      { tunnelId: 'dsh-remote', provider: 'ngrok', targetUrl: 'http://127.0.0.1:3000', autoRestart: false },
    )
    await manager.start()
    expect(body).toEqual({
      tunnel_id: 'dsh-remote',
      provider: 'ngrok',
      target_url: 'http://127.0.0.1:3000',
      auto_restart: false,
    })
  })

  it('fails without restarting when the daemon is unreachable', async () => {
    const manager = new TunnelMuxTunnelManager(
      fakeClient(() => {
        throw new Error('connection refused')
      }),
    )
    const info = await manager.start()
    expect(info.phase).toBe('failed')
    expect(info.daemonOk).toBe(false)
    expect(info.error).toMatch(/daemon unreachable/)
  })

  it('fails when health is not ok', async () => {
    const manager = new TunnelMuxTunnelManager(
      fakeClient((path) => {
        if (path === '/v1/health') return { ok: false, status: 503, json: {}, text: 'down' }
        throw new Error('should not start')
      }),
    )
    const info = await manager.start()
    expect(info.phase).toBe('failed')
    expect(info.error).toMatch(/daemon unreachable/)
  })

  it('fails when start returns an error status', async () => {
    const manager = new TunnelMuxTunnelManager(
      fakeClient((path) => {
        if (path === '/v1/health') return { ok: true, status: 200, json: {}, text: '' }
        if (path === '/v1/tunnel/start') return { ok: false, status: 500, json: {}, text: 'provider missing' }
        return { ok: true, status: 200, json: {}, text: '' }
      }),
    )
    const info = await manager.start()
    expect(info.phase).toBe('failed')
    expect(info.error).toMatch(/tunnel start failed \(500\): provider missing/)
  })

  it('falls back to one status read when start has no public URL yet', async () => {
    const calls: string[] = []
    const manager = new TunnelMuxTunnelManager(
      fakeClient((path) => {
        calls.push(path)
        if (path === '/v1/health') return { ok: true, status: 200, json: {}, text: '' }
        if (path === '/v1/tunnel/start') {
          return { ok: true, status: 200, json: { tunnel: { state: 'starting' } }, text: '' }
        }
        if (path === '/v1/tunnel/status') {
          return { ok: true, status: 200, json: START_OK, text: '' }
        }
        return { ok: true, status: 200, json: {}, text: '' }
      }),
    )
    const info = await manager.start()
    expect(calls).toContain('/v1/tunnel/status')
    expect(info.phase).toBe('running')
    expect(info.url).toBe('https://abc.trycloudflare.com')
  })

  it('fails when the fallback status read still has no public URL', async () => {
    const manager = new TunnelMuxTunnelManager(
      fakeClient((path) => {
        if (path === '/v1/health') return { ok: true, status: 200, json: {}, text: '' }
        if (path === '/v1/tunnel/start') return { ok: true, status: 200, json: { tunnel: { state: 'starting' } }, text: '' }
        if (path === '/v1/tunnel/status') return { ok: true, status: 200, json: { tunnel: { state: 'starting' } }, text: '' }
        return { ok: true, status: 200, json: {}, text: '' }
      }),
    )
    const info = await manager.start()
    expect(info.phase).toBe('failed')
    expect(info.error).toMatch(/timed out waiting for a public tunnel URL/)
  })

  it('stop() calls the stop endpoint and clears state', async () => {
    const calls: string[] = []
    const manager = new TunnelMuxTunnelManager(
      fakeClient((path, init) => {
        calls.push(path)
        if (path === '/v1/health') return { ok: true, status: 200, json: {}, text: '' }
        if (path === '/v1/tunnel/start') return { ok: true, status: 200, json: START_OK, text: '' }
        if (path === '/v1/tunnel/stop') {
          expect(init?.body).toEqual({ tunnel_id: 'dsh-remote' })
          return { ok: true, status: 200, json: {}, text: '' }
        }
        return { ok: true, status: 200, json: {}, text: '' }
      }),
    )
    await manager.start()
    await manager.stop()
    expect(calls).toContain('/v1/tunnel/stop')
    expect(manager.info.phase).toBe('stopped')
  })

  it('startPolling() observes status without restarting', async () => {
    vi.useFakeTimers()
    try {
      const statusCalls: string[] = []
      const manager = new TunnelMuxTunnelManager(
        fakeClient((path) => {
          if (path === '/v1/health') return { ok: true, status: 200, json: {}, text: '' }
          if (path === '/v1/tunnel/start') return { ok: true, status: 200, json: START_OK, text: '' }
          if (path === '/v1/tunnel/status') {
            statusCalls.push(path)
            return { ok: true, status: 200, json: { tunnel: { state: 'stopped' } }, text: '' }
          }
          return { ok: true, status: 200, json: {}, text: '' }
        }),
        { pollMs: 1000 },
      )
      await manager.start()
      expect(manager.info.phase).toBe('running')
      manager.startPolling()
      await vi.advanceTimersByTimeAsync(1000)
      expect(statusCalls.length).toBeGreaterThan(0)
      expect(manager.info.phase).toBe('stopped') // observed, not restarted
      manager.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('dispose() stops the tunnel', async () => {
    const stopCalls: string[] = []
    const manager = new TunnelMuxTunnelManager(
      fakeClient((path, init) => {
        if (path === '/v1/health') return { ok: true, status: 200, json: {}, text: '' }
        if (path === '/v1/tunnel/start') return { ok: true, status: 200, json: START_OK, text: '' }
        if (path === '/v1/tunnel/stop') {
          stopCalls.push(path)
          return { ok: true, status: 200, json: {}, text: '' }
        }
        return { ok: true, status: 200, json: {}, text: '' }
      }),
    )
    await manager.start()
    manager.dispose()
    expect(stopCalls).toContain('/v1/tunnel/stop')
  })
})

describe('createTunnelMuxHttpClient', () => {
  it('sends a Bearer token when configured', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => '',
    }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const client = createTunnelMuxHttpClient('http://127.0.0.1:4765', 'sekret')
      await client.request('/v1/health')
      const [, init] = fetchMock.mock.calls[0]
      expect(init.headers.authorization).toBe('Bearer sekret')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('uses the base URL verbatim', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => '',
    }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const client = createTunnelMuxHttpClient('http://127.0.0.1:4765/')
      await client.request('/v1/health')
      expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:4765/v1/health')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
