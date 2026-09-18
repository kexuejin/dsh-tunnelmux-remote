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
import {
  authorityOf,
  defaultCredentialsPath,
  ensureTunnelmuxRoutes,
  expandHome,
  readBrowserSessionSecret,
  resolveGateCookies,
  startDesktopBridge,
} from './desktop-bridge.ts'

export { createTunnelMuxHttpClient, TunnelMuxTunnelManager } from './tunnelmux.ts'
import { lanIPv4Addresses, makePairingRoutes } from './routes.ts'
import { makeMobileRoutes } from './mobile.ts'

export const name = 'tunnelmux-remote'

/** Services required before the pairing surfaces can mount (apiProxy is probed at runtime). */
export const inject = ['webServer']

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
  desktopBridge: z.boolean().default(true),
  bridgePort: z.number().min(1024).max(65_535).default(3988),
  bridgeRedirect: z.string().default('/'),
  bridgeDays: z.number().min(1).max(30).default(30),
  registerRoutes: z.boolean().default(true),
  pairRouteId: z.string().default('deepseek'),
  pairRoutePrefix: z.string().default('/deepseek'),
  rootRouteId: z.string().default('dsh-root'),
  rootRoutePrefix: z.string().default('/'),
  gateCookie: z.string().default(''),
  dshHome: z.string().default('~/.dsh'),
  tunnelmuxStateFile: z.string().default('~/.tunnelmux/state.json'),
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
  desktopBridge: true,
  bridgePort: 3988,
  bridgeRedirect: '/',
  bridgeDays: 30,
  registerRoutes: true,
  pairRouteId: 'deepseek',
  pairRoutePrefix: '/deepseek',
  rootRouteId: 'dsh-root',
  rootRoutePrefix: '/',
  gateCookie: '',
  dshHome: '~/.dsh',
  tunnelmuxStateFile: '~/.tunnelmux/state.json',
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
    desktopBridge: config.desktopBridge ?? DEFAULTS.desktopBridge,
    bridgePort: config.bridgePort ?? DEFAULTS.bridgePort,
    bridgeRedirect: config.bridgeRedirect ?? DEFAULTS.bridgeRedirect,
    bridgeDays: config.bridgeDays ?? DEFAULTS.bridgeDays,
    registerRoutes: config.registerRoutes ?? DEFAULTS.registerRoutes,
    pairRouteId: config.pairRouteId ?? DEFAULTS.pairRouteId,
    pairRoutePrefix: config.pairRoutePrefix ?? DEFAULTS.pairRoutePrefix,
    rootRouteId: config.rootRouteId ?? DEFAULTS.rootRouteId,
    rootRoutePrefix: config.rootRoutePrefix ?? DEFAULTS.rootRoutePrefix,
    gateCookie: config.gateCookie ?? DEFAULTS.gateCookie,
    dshHome: config.dshHome ?? DEFAULTS.dshHome,
    tunnelmuxStateFile: config.tunnelmuxStateFile ?? DEFAULTS.tunnelmuxStateFile,
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
  const tunnelmuxClient = createTunnelMuxHttpClient(resolved.tunnelmuxBaseUrl, resolved.tunnelmuxApiToken || undefined)
  const tunnel = new TunnelMuxTunnelManager(
    tunnelmuxClient,
    {
      tunnelId: 'dsh-remote',
      provider: resolved.tunnelProvider,
      targetUrl: resolved.targetUrl,
      autoRestart: true,
    },
  )

  const lanAddresses = () => service.lanAddresses
  const routes = [...makePairingRoutes({ service, lanAddresses })]

  const applyRoutes = () => {
    for (const route of routes) {
      ctx.webServer.register(route)
    }
  }

  ctx.effect(() => {
    if (!resolved.enabled) return () => {}
    applyRoutes()
    // The mobile surface is optional: it needs the apiProxy service, which not
    // every profile provides. Detecting it at runtime (instead of declaring an
    // inject) keeps the fiber from pending forever and failing the boot.
    const apiProxy = (ctx as unknown as { get(name: string): unknown }).get('apiProxy')
    if (apiProxy !== undefined) {
      for (const route of makeMobileRoutes({
        service,
        apiProxy: apiProxy as MobileApiProxy,
        lanAddresses,
        mobileEnterToSend: () => resolved.mobileEnterToSend,
      })) {
        ctx.webServer.register(route)
      }
    } else {
      console.info('tunnelmux-remote: apiProxy service not present — mobile surface (/m) disabled; desktop pairing bridge and QR panel stay active')
    }
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

  // Desktop pairing bridge: a loopback-only issuer of DSH browser-session
  // cookies (the persistent-secret flow of the former standalone dsh-web-cookie
  // tool), plus idempotent TunnelMux route registration for the public entry
  // points. The listener MUST stay behind an access-gated proxy route.
  ctx.effect(() => {
    if (!resolved.enabled || !resolved.desktopBridge) return () => {}
    let secret: Buffer
    try {
      secret = readBrowserSessionSecret(defaultCredentialsPath(resolved.dshHome))
    } catch (error) {
      console.error('tunnelmux-remote: desktop bridge disabled —', error instanceof Error ? error.message : error)
      return () => {}
    }
    const currentAuthorities = () => {
      const list = new Set<string>()
      const target = authorityOf(resolved.targetUrl)
      if (target !== undefined) list.add(target)
      const publicUrl = resolved.publicBaseUrl.trim() !== '' ? resolved.publicBaseUrl : tunnel.info.url
      const publicAuthority = publicUrl === undefined ? undefined : authorityOf(publicUrl)
      if (publicAuthority !== undefined) list.add(publicAuthority)
      return [...list]
    }
    let bridge
    try {
      bridge = startDesktopBridge({
        port: resolved.bridgePort,
        authorities: currentAuthorities,
        secret,
        days: resolved.bridgeDays,
        cookiePath: '/',
        redirect: resolved.bridgeRedirect,
        gateCookies: resolveGateCookies(
          resolved.tunnelmuxStateFile,
          [resolved.pairRouteId, resolved.rootRouteId],
          resolved.gateCookie,
        ),
      })
    } catch (error) {
      console.error('tunnelmux-remote: desktop bridge failed to start —', error instanceof Error ? error.message : error)
      return () => {}
    }
    console.info(`tunnelmux-remote: desktop bridge on http://127.0.0.1:${String(resolved.bridgePort)}/ -> ${resolved.bridgeRedirect}`)
    if (resolved.registerRoutes) {
      void ensureTunnelmuxRoutes(tunnelmuxClient, [
        {
          id: resolved.pairRouteId,
          matchPathPrefix: resolved.pairRoutePrefix,
          stripPathPrefix: resolved.pairRoutePrefix,
          upstreamUrl: `http://127.0.0.1:${String(resolved.bridgePort)}`,
        },
        {
          id: resolved.rootRouteId,
          matchPathPrefix: resolved.rootRoutePrefix,
          stripPathPrefix: null,
          upstreamUrl: resolved.targetUrl,
        },
      ]).then((result) => {
        if (result.ok) {
          const touched = [
            ...result.registered.map((id) => `+${id}`),
            ...result.updated.map((id) => `~${id}`),
          ]
          if (touched.length > 0) console.info(`tunnelmux-remote: routes synced (${touched.join(' ')})`)
        } else {
          console.warn(`tunnelmux-remote: route sync deferred — ${result.reason ?? 'unknown'} (routes persist in daemon state; they apply once the control plane is unlocked)`)
        }
      })
    }
    return () => {
      void bridge.close()
    }
  }, 'tunnelmux-remote: desktop bridge')

  // Optional settings namespace for live tuning (skip when absent).
  ctx.inject(['settings'], (sctx) => {
    sctx.settings.register(settingsNamespace(REMOTE_SETTINGS_NAMESPACE), Config, {
      base: resolved as never,
    })
  })
}
