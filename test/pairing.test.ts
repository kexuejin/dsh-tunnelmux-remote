import { describe, expect, it } from 'vitest'
import { PairingService, UnknownLanAddressError } from '../src/pairing.ts'

/** Deterministic clock/entropy for tests. */
function makeClock(start = 1_000_000) {
  let now = start
  let serial = 0
  return {
    now: () => now,
    tick(ms: number) {
      now += ms
    },
    randomToken: () => `tok-${(serial += 1)}`,
    clock: {
      now: () => now,
      randomToken: () => `tok-${(serial += 1)}`,
    },
  }
}

const CONFIG = {
  tokenTtlMs: 600_000,
  offlineAfterMs: 25_000,
  maxDevices: 4,
  cookieName: 'dsh_pair',
}

function serviceWithLan(clock = makeClock()) {
  const service = new PairingService(CONFIG, clock.clock)
  service.setLanBases([{ address: '192.168.1.5', base: 'http://192.168.1.5:3080' }])
  return { service, clock }
}

describe('PairingService', () => {
  it('issues a token and exposes it in the snapshot', () => {
    const { service } = serviceWithLan()
    const { token, expiresAt } = service.issue()
    expect(token).toBe('tok-1')
    expect(expiresAt).toBe(1_000_000 + CONFIG.tokenTtlMs)
    const snap = service.snapshot()
    expect(snap.phase).toBe('waiting')
    expect(snap.tokenId).toBe('t1')
    expect(snap.lanAddresses).toEqual(['192.168.1.5'])
  })

  it('issue() replaces the previous token, invalidating the old QR', () => {
    const { service } = serviceWithLan()
    const first = service.issue()
    const second = service.issue()
    expect(second.token).not.toBe(first.token)
    const result = service.accept(first.token)
    expect(result).toEqual({ ok: false, code: 'invalid' })
  })

  it('accept() consumes a token once; reuse is refused with used', () => {
    const { service } = serviceWithLan()
    const { token } = service.issue()
    const first = service.accept(token)
    expect(first.ok).toBe(true)
    const second = service.accept(token)
    expect(second).toEqual({ ok: false, code: 'used' })
  })

  it('refuses expired tokens like unknown ones', () => {
    const { service, clock } = serviceWithLan()
    const { token } = service.issue()
    clock.tick(CONFIG.tokenTtlMs + 1)
    expect(service.accept(token)).toEqual({ ok: false, code: 'invalid' })
    expect(service.snapshot().tokenId).toBeUndefined()
  })

  it('stop() revokes every device and clears the token', () => {
    const { service } = serviceWithLan()
    const { token } = service.issue()
    const accepted = service.accept(token)
    expect(accepted.ok).toBe(true)
    if (!accepted.ok) throw new Error('unreachable')
    service.stop()
    expect(service.snapshot().phase).toBe('stopped')
    expect(service.touchDevice(accepted.deviceId)).toBe(false)
    // Re-arm via a fresh issue.
    service.issue()
    expect(service.snapshot().phase).toBe('waiting')
  })

  it('tracks presence: heartbeat keeps a device online, then it ages offline', () => {
    const { service, clock } = serviceWithLan()
    const { token } = service.issue()
    const accepted = service.accept(token)
    if (!accepted.ok) throw new Error('unreachable')
    expect(service.snapshot().phase).toBe('connected')
    clock.tick(CONFIG.offlineAfterMs / 2)
    expect(service.heartbeat(accepted.deviceId)).toBe(true)
    clock.tick(CONFIG.offlineAfterMs + 1)
    service.sweep()
    expect(service.snapshot().phase).toBe('disconnected')
    expect(service.snapshot().onlineCount).toBe(0)
  })

  it('evicts the oldest device when maxDevices is reached', () => {
    const { service } = serviceWithLan()
    for (let i = 0; i < CONFIG.maxDevices; i += 1) {
      const { token } = service.issue()
      const accepted = service.accept(token)
      if (!accepted.ok) throw new Error('unreachable')
    }
    expect(service.snapshot().deviceCount).toBe(CONFIG.maxDevices)
    // After maxDevices accepts, adding one more evicts the oldest.
    const { token } = service.issue()
    const accepted = service.accept(token)
    if (!accepted.ok) throw new Error('unreachable')
    expect(service.snapshot().deviceCount).toBe(CONFIG.maxDevices)
    expect(service.snapshot().onlineCount).toBe(CONFIG.maxDevices)
  })

  it('rejects a LAN address outside the sampled literals', () => {
    const { service } = serviceWithLan()
    expect(() => service.issue(undefined, '10.0.0.9')).toThrow(UnknownLanAddressError)
  })

  it('issue() throws without a reachable base', () => {
    const service = new PairingService(CONFIG, makeClock().clock)
    expect(() => service.issue()).toThrow(/reachable bind/)
    expect(service.snapshot().phase).toBe('lan-required')
  })

  it('public base URL alone is enough to pair (tunnel mode)', () => {
    const service = new PairingService(CONFIG, makeClock().clock)
    service.setPublicBaseUrl('https://abc.trycloudflare.com')
    const { token } = service.issue()
    const accepted = service.accept(token)
    expect(accepted.ok).toBe(true)
    expect(service.snapshot().publicUrl).toBe('https://abc.trycloudflare.com')
  })

  it('notifies listeners only on real changes', () => {
    const { service } = serviceWithLan()
    let emissions = 0
    service.onState(() => {
      emissions += 1
    })
    service.issue()
    const before = emissions
    service.sweep() // no change
    expect(emissions).toBe(before)
    service.touchDevice('unknown') // no change
    expect(emissions).toBe(before)
  })

  it('tunnel status is carried in the snapshot', () => {
    const { service } = serviceWithLan()
    service.setTunnelStatus({ state: 'starting' })
    expect(service.snapshot().tunnel?.state).toBe('starting')
    service.setTunnelStatus({ state: 'running', url: 'https://x.trycloudflare.com' })
    expect(service.snapshot().tunnel?.url).toBe('https://x.trycloudflare.com')
  })
})
