/**
 * Pairing state machine for dsh-tunnelmux-remote: one active one-time token,
 * a device-session table, and presence tracking. Pure TypeScript with
 * injected clock/randomness so the whole security semantics are unit-testable
 * without cordis or a network.
 *
 * Security invariants:
 * - One active token at a time; issue() replaces it, so a refreshed QR
 *   immediately invalidates the previous link.
 * - A token is consumed by the first successful accept() — reuse is refused
 *   with 'used'.
 * - Tokens expire; accept() on an expired token is refused like an unknown
 *   one (no oracle for validity).
 * - stop() revokes every device session and clears the token, so paired
 *   devices are cut off on their next gated request.
 */

/** Thrown by issue() for an address outside the sampled LAN literals. */
export class UnknownLanAddressError extends Error {
  constructor(address: string) {
    super(`tunnelmux-remote: unknown LAN address ${JSON.stringify(address)}`)
    this.name = 'UnknownLanAddressError'
  }
}

/** Clock/entropy source (injectable for tests). */
export interface PairingClock {
  now(): number
  randomToken(): string
}

/** Real clock/entropy: 32 random hex chars per token. */
export const defaultClock: PairingClock = {
  now: () => Date.now(),
  randomToken: () => {
    const bytes = new Uint8Array(16)
    crypto.getRandomValues(bytes)
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  },
}

/** Tunables; re-read from a fresh object whenever settings commit. */
export interface PairingConfig {
  tokenTtlMs: number
  offlineAfterMs: number
  maxDevices: number
  cookieName: string
}

interface TokenRecord {
  id: string
  issuedAt: number
  expiresAt: number
  consumed: boolean
  workspaceId?: string
  address?: string
}

interface DeviceSession {
  createdAt: number
  lastSeenAt: number
}

export type PairingPhase =
  | 'lan-required'
  | 'stopped'
  | 'waiting'
  | 'disconnected'
  | 'connected'

/** The derived, JSON-safe snapshot emitted to listeners. */
export interface PairingSnapshot {
  phase: PairingPhase
  lanAvailable: boolean
  lanAddresses: string[]
  publicUrl?: string
  tunnel?: { state: 'starting' | 'running' | 'failed' | 'stopped'; url?: string; error?: string }
  tokenId?: string
  tokenExpiresAt?: number
  deviceCount: number
  onlineCount: number
}

type StateListener = (snapshot: PairingSnapshot) => void

/**
 * The pairing state machine. All mutations notify state listeners after the
 * commit point that makes them true, and notification dedupes against the
 * last emitted snapshot.
 */
export class PairingService {
  private config: PairingConfig
  private clock: PairingClock
  private tokens = new Map<string, TokenRecord>()
  private devices = new Map<string, DeviceSession>()
  private listeners = new Set<StateListener>()
  private lastEmitted?: PairingSnapshot
  private stopped = false
  private tokenSerial = 0
  /** LAN base URLs keyed by the advertised IP literal (interface order). */
  private lanBases = new Map<string, string>()
  /** Public (tunneled) base URL, e.g. a TunnelMux quick URL. */
  private publicBase?: string
  /** Auto-tunnel status frame while the auto-tunnel feature is active. */
  private tunnelStatus?: PairingSnapshot['tunnel']

  constructor(config: PairingConfig, clock: PairingClock = defaultClock) {
    this.config = config
    this.clock = clock
  }

  /** The default LAN base URL (first interface; undefined when not reachable). */
  get lanBaseUrl(): string | undefined {
    return this.lanBases.values().next().value
  }

  /** The LAN base URL for one specific literal. */
  lanBaseUrlFor(address: string): string | undefined {
    return this.lanBases.get(address)
  }

  /** LAN IP literals QR links can be built from (interface order). */
  get lanAddresses(): string[] {
    return [...this.lanBases.keys()]
  }

  /** Configure the LAN base URLs once the server bind is known. */
  setLanBases(entries: Array<{ address: string; base: string }>): void {
    this.lanBases = new Map(entries.map((e) => [e.address, e.base]))
    this.notify()
  }

  get publicBaseUrl(): string | undefined {
    return this.publicBase
  }

  setPublicBaseUrl(url: string | undefined): void {
    this.publicBase = url
    this.notify()
  }

  setTunnelStatus(status: PairingSnapshot['tunnel'] | undefined): void {
    this.tunnelStatus = status
    this.notify()
  }

  /**
   * Issue a fresh token, replacing (invalidating) any previous one. A stopped
   * service re-arms through this call.
   * @throws {Error} when no reachable base exists.
   */
  issue(workspaceId?: string, address?: string): { token: string; expiresAt: number } {
    if (this.lanBases.size === 0 && this.publicBase === undefined) {
      throw new Error('tunnelmux-remote: pairing requires a reachable bind (--host 0.0.0.0 or publicBaseUrl)')
    }
    if (address !== undefined && !this.lanBases.has(address)) {
      throw new UnknownLanAddressError(address)
    }
    const now = this.clock.now()
    const token = this.clock.randomToken()
    this.tokens.clear()
    this.stopped = false
    this.tokenSerial += 1
    this.tokens.set(token, {
      id: `t${this.tokenSerial}`,
      issuedAt: now,
      expiresAt: now + this.config.tokenTtlMs,
      consumed: false,
      ...(workspaceId !== undefined ? { workspaceId } : {}),
      ...(address !== undefined ? { address } : {}),
    })
    this.notify()
    return { token, expiresAt: now + this.config.tokenTtlMs }
  }

  /**
   * Consume a token and bind a device session. One-time.
   * @returns the new device id, or a refusal code.
   */
  accept(token: string): { ok: true; deviceId: string } | { ok: false; code: 'used' | 'invalid' } {
    const record = this.tokens.get(token)
    if (record === undefined || record.consumed || this.stopped || this.clock.now() > record.expiresAt) {
      return { ok: false, code: record?.consumed === true ? 'used' : 'invalid' }
    }
    record.consumed = true
    const deviceId = this.clock.randomToken()
    const now = this.clock.now()
    if (this.devices.size >= this.config.maxDevices) {
      let oldest: { id: string; createdAt: number } | undefined
      for (const [id, session] of this.devices) {
        if (oldest === undefined || session.createdAt < oldest.createdAt) {
          oldest = { id, createdAt: session.createdAt }
        }
      }
      if (oldest !== undefined) this.devices.delete(oldest.id)
    }
    this.devices.set(deviceId, { createdAt: now, lastSeenAt: now })
    this.notify()
    return { ok: true, deviceId }
  }

  /** Stop remote control: revoke every session and clear the token. */
  stop(): void {
    this.tokens.clear()
    this.devices.clear()
    this.stopped = true
    this.notify()
  }

  /** Record activity for a device id and report whether the request may proceed. */
  touchDevice(deviceId: string): boolean {
    const session = this.devices.get(deviceId)
    if (session === undefined || this.stopped) return false
    session.lastSeenAt = this.clock.now()
    this.notify()
    return true
  }

  /** Explicit presence heartbeat. */
  heartbeat(deviceId: string): boolean {
    return this.touchDevice(deviceId)
  }

  /** Whether a cookie value names a currently live device session. */
  hasDevice(deviceId: string): boolean {
    return this.devices.get(deviceId) !== undefined && !this.stopped
  }

  /** Periodic sweep: re-evaluate the derived snapshot (devices aging offline). */
  sweep(): void {
    this.notify()
  }

  /** The current snapshot (fresh object per call). */
  snapshot(): PairingSnapshot {
    const now = this.clock.now()
    const onlineCount = [...this.devices.values()].filter((s) => this.isOnlineAt(s, now)).length
    const token = this.activeToken()
    const snapshot: PairingSnapshot = {
      phase: this.derivePhase(onlineCount, token !== undefined),
      lanAvailable: this.lanBases.size > 0,
      lanAddresses: [...this.lanBases.keys()],
      ...(this.publicBase !== undefined ? { publicUrl: this.publicBase } : {}),
      ...(this.tunnelStatus !== undefined ? { tunnel: this.tunnelStatus } : {}),
      ...(token !== undefined ? { tokenId: token.record.id, tokenExpiresAt: token.record.expiresAt } : {}),
      deviceCount: this.devices.size,
      onlineCount,
    }
    return snapshot
  }

  /** Subscribe to snapshot changes (each emit passes a fresh snapshot). */
  onState(listener: StateListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private activeToken(): { token: string; record: TokenRecord } | undefined {
    for (const [token, record] of this.tokens) {
      if (this.stopped) return undefined
      if (this.clock.now() > record.expiresAt) continue
      return { token, record }
    }
    return undefined
  }

  private derivePhase(onlineCount: number, hasToken: boolean): PairingPhase {
    if (this.lanBases.size === 0 && this.publicBase === undefined) return 'lan-required'
    if (this.stopped) return 'stopped'
    if (onlineCount > 0) return 'connected'
    if (this.devices.size > 0) return 'disconnected'
    if (hasToken) return 'waiting'
    return 'stopped'
  }

  private isOnlineAt(session: DeviceSession, now: number): boolean {
    return now - session.lastSeenAt <= this.config.offlineAfterMs
  }

  private notify(): void {
    const snapshot = this.snapshot()
    if (this.lastEmitted !== undefined && snapshotsEqual(this.lastEmitted, snapshot)) return
    this.lastEmitted = snapshot
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch (error) {
        console.error('tunnelmux-remote: pairing state listener failed', error)
      }
    }
  }
}

/** Structural equality over the JSON-safe snapshot fields. */
function snapshotsEqual(a: PairingSnapshot, b: PairingSnapshot): boolean {
  if (a.phase !== b.phase || a.lanAvailable !== b.lanAvailable) return false
  if (a.publicUrl !== b.publicUrl || a.tokenId !== b.tokenId || a.tokenExpiresAt !== b.tokenExpiresAt) return false
  if (a.deviceCount !== b.deviceCount || a.onlineCount !== b.onlineCount) return false
  if (a.lanAddresses.length !== b.lanAddresses.length) return false
  for (let i = 0; i < a.lanAddresses.length; i += 1) {
    if (a.lanAddresses[i] !== b.lanAddresses[i]) return false
  }
  if (a.tunnel?.state !== b.tunnel?.state || a.tunnel?.url !== b.tunnel?.url || a.tunnel?.error !== b.tunnel?.error) return false
  return true
}
