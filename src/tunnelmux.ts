/**
 * TunnelMux tunnel adapter: drives the TunnelMux control API
 * (default http://127.0.0.1:4765) to start/stop the tunnel and observe its
 * status. The daemon owns restart policy (auto_restart) — this adapter never
 * restarts on its own; it only reports state and exposes the daemon health.
 *
 * Lifecycle (observed):
 *   stopped → starting (POST /v1/tunnel/start) → running (public_base_url)
 *            → stopped/error (daemon reports), daemon-unreachable → failed
 *
 * Per the 2026-08-16 design revision: POST /v1/tunnel/start waits
 * synchronously for the provider startup and returns public_base_url in the
 * response, so no polling-for-URL loop is needed. status polling is only for
 * panel presentation (5s) and daemon health.
 */

/** Status frame exposed to the pairing service and panel. */
export type TunnelMuxTunnelPhase = 'stopped' | 'starting' | 'running' | 'failed'

export interface TunnelMuxStatusFrame {
  phase: TunnelMuxTunnelPhase
  url?: string
  error?: string
  daemonOk?: boolean
  raw?: Record<string, unknown>
}

/** HTTP seams (injectable for tests). */
export interface TunnelMuxHttpClient {
  request(path: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }): Promise<{
    ok: boolean
    status: number
    json(): Promise<unknown>
    text(): Promise<string>
  }>
}

/** Real fetch-based client for the TunnelMux control API. */
export function createTunnelMuxHttpClient(baseUrl: string, apiToken?: string): TunnelMuxHttpClient {
  return {
    async request(path, init = {}) {
      const headers: Record<string, string> = { 'content-type': 'application/json', ...init.headers }
      if (apiToken) headers.authorization = `Bearer ${apiToken}`
      const response = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
        method: init.method ?? 'GET',
        headers,
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      })
      return {
        ok: response.ok,
        status: response.status,
        json: () => response.json(),
        text: () => response.text(),
      }
    },
  }
}

export interface TunnelMuxAdapterOptions {
  tunnelId?: string
  provider?: 'cloudflared' | 'ngrok'
  targetUrl?: string
  autoRestart?: boolean
  pollMs?: number
  startTimeoutMs?: number
}

/**
 * Owns the lifecycle of one TunnelMux-managed tunnel. All timers and the HTTP
 * client are injectable for unit tests without a daemon.
 */
export class TunnelMuxTunnelManager {
  private client: TunnelMuxHttpClient
  private tunnelId: string
  private provider: 'cloudflared' | 'ngrok'
  private targetUrl: string
  private autoRestart: boolean
  private pollMs: number
  private startTimeoutMs: number
  private phase: TunnelMuxTunnelPhase = 'stopped'
  private url?: string
  private error?: string
  private daemonOk?: boolean
  private raw?: Record<string, unknown>
  private pollTimer?: ReturnType<typeof setInterval>
  private disposed = false
  private listeners = new Set<() => void>()

  constructor(client: TunnelMuxHttpClient, options: TunnelMuxAdapterOptions = {}) {
    this.client = client
    this.tunnelId = options.tunnelId ?? 'dsh-remote'
    this.provider = options.provider ?? 'cloudflared'
    this.targetUrl = options.targetUrl ?? 'http://127.0.0.1:3080'
    this.autoRestart = options.autoRestart ?? true
    this.pollMs = options.pollMs ?? 5_000
    this.startTimeoutMs = options.startTimeoutMs ?? 30_000
  }

  get info(): TunnelMuxStatusFrame {
    return {
      phase: this.phase,
      ...(this.url !== undefined ? { url: this.url } : {}),
      ...(this.error !== undefined ? { error: this.error } : {}),
      ...(this.daemonOk !== undefined ? { daemonOk: this.daemonOk } : {}),
      ...(this.raw !== undefined ? { raw: this.raw } : {}),
    }
  }

  /** Subscribe to status-frame changes. */
  onStatus(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Start (or keep) the TunnelMux-managed tunnel toward the target URL. */
  async start(): Promise<TunnelMuxStatusFrame> {
    if (this.phase === 'starting' || this.phase === 'running') return this.info
    this.phase = 'starting'
    this.error = undefined
    this.emit()
    try {
      const health = await this.client.request('/v1/health')
      this.daemonOk = health.ok
      if (!health.ok) {
        this.fail('tunnelmux daemon unreachable: check that tunnelmuxd is running on the control port')
        return this.info
      }
      const response = await this.client.request('/v1/tunnel/start', {
        method: 'POST',
        body: {
          tunnel_id: this.tunnelId,
          provider: this.provider,
          target_url: this.targetUrl,
          auto_restart: this.autoRestart,
        },
      })
      if (!response.ok) {
        const text = await response.text()
        this.fail(`tunnel start failed (${response.status}): ${text}`)
        return this.info
      }
      const payload = (await response.json()) as Record<string, unknown>
      const tunnel = (payload.tunnel ?? payload) as Record<string, unknown>
      this.raw = tunnel as Record<string, unknown>
      const publicUrl = typeof tunnel.public_base_url === 'string' ? tunnel.public_base_url : undefined
      const state = typeof tunnel.state === 'string' ? tunnel.state : 'running'
      if (publicUrl) {
        this.url = publicUrl
        this.phase = 'running'
      } else if (state === 'error') {
        this.fail(typeof tunnel.last_error === 'string' ? tunnel.last_error : 'tunnel start returned an error state')
      } else {
        // No public URL yet: fall back to one status read (the daemon usually
        // returns it synchronously; this is the documented fallback).
        this.url = undefined
        this.phase = 'starting'
        await this.refreshStatusOnce()
        if (this.phase === 'starting') this.fail('timed out waiting for a public tunnel URL')
      }
      this.emit()
    } catch (error) {
      this.daemonOk = false
      this.fail(error instanceof Error ? `tunnelmux daemon unreachable: ${error.message}` : 'tunnelmux daemon unreachable')
    }
    return this.info
  }

  /** Stop the tunnel for good and clear state. */
  async stop(): Promise<void> {
    this.disposePolling()
    try {
      await this.client.request('/v1/tunnel/stop', { method: 'POST', body: { tunnel_id: this.tunnelId } })
    } catch {
      // best-effort stop; the daemon may already be gone
    }
    this.phase = 'stopped'
    this.url = undefined
    this.error = undefined
    this.emit()
  }

  /** Begin periodic status observation (panel presentation only). */
  startPolling(): void {
    if (this.pollTimer !== undefined) return
    this.pollTimer = setInterval(() => {
      void this.refreshStatusOnce()
    }, this.pollMs)
  }

  dispose(): void {
    this.disposed = true
    this.disposePolling()
    void this.stop()
  }

  private async refreshStatusOnce(): Promise<void> {
    if (this.disposed) return
    try {
      const health = await this.client.request('/v1/health')
      this.daemonOk = health.ok
      if (!health.ok) {
        this.fail('tunnelmux daemon unreachable')
        return
      }
      const response = await this.client.request('/v1/tunnel/status')
      if (!response.ok) return
      const payload = (await response.json()) as Record<string, unknown>
      const tunnel = (payload.tunnel ?? payload) as Record<string, unknown>
      this.raw = tunnel as Record<string, unknown>
      const state = typeof tunnel.state === 'string' ? tunnel.state : undefined
      const publicUrl = typeof tunnel.public_base_url === 'string' ? tunnel.public_base_url : undefined
      if (state === 'running') {
        this.phase = 'running'
        if (publicUrl) this.url = publicUrl
        this.error = undefined
      } else if (state === 'stopped' || state === 'idle') {
        this.phase = 'stopped'
        this.url = undefined
        this.error = undefined
      } else if (state === 'error') {
        this.phase = 'failed'
        this.error = typeof tunnel.last_error === 'string' ? tunnel.last_error : 'tunnel in error state'
      } else if (state === 'starting') {
        this.phase = 'starting'
      }
      this.emit()
    } catch (error) {
      this.daemonOk = false
      this.fail(error instanceof Error ? `tunnelmux daemon unreachable: ${error.message}` : 'tunnelmux daemon unreachable')
    }
  }

  private fail(message: string): void {
    this.error = message
    this.phase = 'failed'
    this.emit()
  }

  private disposePolling(): void {
    if (this.pollTimer !== undefined) {
      clearInterval(this.pollTimer)
      this.pollTimer = undefined
    }
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch (error) {
        console.error('tunnelmux-remote: tunnel status listener failed', error)
      }
    }
  }
}
