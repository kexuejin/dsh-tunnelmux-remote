/**
 * dsh-tunnelmux-remote host half: pairs phones to the DSH web GUI and drives
 * a TunnelMux-managed tunnel as the public backend. Wires the pairing
 * service, the TunnelMux adapter, the /api/pair route family, and the mobile
 * surface into the DSH host. Config is declared with schemastery and applied
 * by the loader; a settings namespace is registered when the settings
 * service is present so the user can tune pairing without editing YAML.
 */
import z from 'schemastery'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the webServer/apiProxy/settings Context merges into the program.
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-host-apiproxy'
import type { MobileApiProxy } from './mobile.ts'
import { PairingService, defaultClock } from './pairing.ts'
import { TunnelMuxTunnelManager, createTunnelMuxHttpClient } from './tunnelmux.ts'

export { createTunnelMuxHttpClient, TunnelMuxTunnelManager } from './tunnelmux.ts'
import { lanIPv4Addresses, makePairingRoutes } from './routes.ts'
import { makeMobileRoutes } from './mobile.ts'

export const name = 'tunnelmux-remote'

/** Services required before the pairing surfaces can mount. */
export const inject = ['webServer', 'apiProxy']

/** Settings namespace of the remote-control capability. */
export const REMOTE_SETTINGS_NAMESPACE = 'tunnelmux-remote'

export const Config = z.object({
  enabled: z.boolean().default(true),
  tunnelmuxBaseUrl: z.string().default('http://127.0.0.1:4765'),
  tunnelmuxApiToken: z.string().default('').role('secret'),
  targetUrl: z.string().default('http://127.0.0.1:3080'),
  tunnelProvider: z.union([z.const('cloudflared'), z.const('ngrok')]).default('cloudflared'),
  autoTunnel: z.boolean().default(false),
  publicBaseUrl: z.string().default(''),
  tokenTtlMs: z.number().min(60_000).default(600_000),
  offlineAfterMs: z.number().min(5_000).default(25_000),
  maxDevices: z.number().min(1).max(64).default(4),
  cookieName: z.string().default('dsh_pair'),
  mobileEnterToSend: z.boolean().default(true),
})

/** Presence sweep cadence (a stale device flips to disconnected within two sweeps). */
const SWEEP_INTERVAL_MS = 10_000

const DEFAULTS = {
  enabled: true,
  tunnelmuxBaseUrl: 'http://127.0.0.1:4765',
  tunnelmuxApiToken: '',
  targetUrl: 'http://127.0.0.1:3080',
  tunnelProvider: 'cloudflared' as const,
  autoTunnel: false,
  publicBaseUrl: '',
  tokenTtlMs: 600_000,
  offlineAfterMs: 25_000,
  maxDevices: 4,
  cookieName: 'dsh_pair',
  mobileEnterToSend: true,
}

/**
 * Mount the pairing service, routes, tunnel adapter, and presence sweep.
 * @param ctx - host plugin context carrying webServer and apiProxy.
 * @param config - resolved plugin config (schema defaults applied by the loader).
 */
export function apply(ctx: Context, config: Partial<typeof DEFAULTS> = {}): void {
  const resolved = {
    enabled: config.enabled ?? DEFAULTS.enabled,
    tunnelmuxBaseUrl: config.tunnelmuxBaseUrl ?? DEFAULTS.tunnelmuxBaseUrl,
    tunnelmuxApiToken: config.tunnelmuxApiToken ?? DEFAULTS.tunnelmuxApiToken,
    targetUrl: config.targetUrl ?? DEFAULTS.targetUrl,
    tunnelProvider: config.tunnelProvider ?? DEFAULTS.tunnelProvider,
    autoTunnel: config.autoTunnel ?? DEFAULTS.autoTunnel,
    publicBaseUrl: config.publicBaseUrl ?? DEFAULTS.publicBaseUrl,
    tokenTtlMs: config.tokenTtlMs ?? DEFAULTS.tokenTtlMs,
    offlineAfterMs: config.offlineAfterMs ?? DEFAULTS.offlineAfterMs,
    maxDevices: config.maxDevices ?? DEFAULTS.maxDevices,
    cookieName: config.cookieName ?? DEFAULTS.cookieName,
    mobileEnterToSend: config.mobileEnterToSend ?? DEFAULTS.mobileEnterToSend,
  }

  const service = new PairingService({
    tokenTtlMs: resolved.tokenTtlMs,
    offlineAfterMs: resolved.offlineAfterMs,
    maxDevices: resolved.maxDevices,
    cookieName: resolved.cookieName,
  }, defaultClock)

  // LAN bases: derive the port from the target URL (the exposed GUI).
  let lanPort = '3080'
  try {
    lanPort = new URL(resolved.targetUrl).port || '3080'
  } catch {
    /* keep default */
  }
  const lanEntries = lanIPv4Addresses().map((address) => ({
    address,
    base: `http://${address}:${lanPort}`,
  }))
  service.setLanBases(lanEntries)

  if (resolved.publicBaseUrl.trim() !== '') {
    service.setPublicBaseUrl(resolved.publicBaseUrl.trim())
  }

  // TunnelMux adapter: owns the tunnel only when autoTunnel is enabled.
  const tunnel = new TunnelMuxTunnelManager(
    createTunnelMuxHttpClient(resolved.tunnelmuxBaseUrl, resolved.tunnelmuxApiToken || undefined),
    {
      tunnelId: 'dsh-remote',
      provider: resolved.tunnelProvider,
      targetUrl: resolved.targetUrl,
      autoRestart: true,
    },
  )

  const lanAddresses = () => service.lanAddresses
  const routes = [
    ...makePairingRoutes({ service, lanAddresses }),
    ...makeMobileRoutes({
      service,
      apiProxy: ctx.apiProxy as unknown as MobileApiProxy,
      lanAddresses,
      mobileEnterToSend: () => resolved.mobileEnterToSend,
    }),
  ]

  const applyRoutes = () => {
    for (const route of routes) {
      ctx.webServer.register(route)
    }
  }

  ctx.effect(() => {
    if (!resolved.enabled) return () => {}
    applyRoutes()
    const sweep = setInterval(() => service.sweep(), SWEEP_INTERVAL_MS)
    if (resolved.autoTunnel) {
      tunnel.onStatus(() => {
        service.setTunnelStatus({
          state: tunnel.info.phase,
          ...(tunnel.info.url !== undefined ? { url: tunnel.info.url } : {}),
          ...(tunnel.info.error !== undefined ? { error: tunnel.info.error } : {}),
        })
        if (tunnel.info.phase === 'running' && tunnel.info.url !== undefined) {
          service.setPublicBaseUrl(tunnel.info.url)
        }
      })
      void tunnel.start()
      tunnel.startPolling()
    } else if (resolved.publicBaseUrl.trim() === '') {
      service.setTunnelStatus({ state: 'stopped' })
    }
    return () => {
      clearInterval(sweep)
      tunnel.dispose()
    }
  }, 'tunnelmux-remote: pairing surface')

  // Optional settings namespace for live tuning (skip when absent).
  ctx.inject(['settings'], (sctx) => {
    sctx.settings.register(settingsNamespace(REMOTE_SETTINGS_NAMESPACE), Config, {
      base: resolved as never,
    })
  })
}
