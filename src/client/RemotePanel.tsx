/**
 * Pairing/QR status panel: polls /api/pair/status, subscribes to
 * /api/pair/events (SSE), renders the QR code (issue), device list, tunnel
 * status, and stop button. Hosted inside the RemoteOverlay drawer.
 */
import { createElement as h, useEffect, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'

interface PairSnapshot {
  phase: string
  lanAvailable: boolean
  lanAddresses: string[]
  publicUrl?: string
  tunnel?: { state: string; url?: string; error?: string }
  tokenId?: string
  tokenExpiresAt?: number
  deviceCount: number
  onlineCount: number
}

interface StatusResponse {
  ok: boolean
  paired: boolean
  phase: string
  lanAvailable: boolean
  lanAddresses: string[]
  publicUrl?: string
  tunnel?: { state: string; url?: string; error?: string }
  deviceCount: number
  onlineCount: number
}

function StatusRow({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return h('div', {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      gap: 12,
      padding: '6px 0',
      fontSize: 13,
    },
  }, [
    h('span', { key: 'label', style: { color: 'var(--dsw-alias-label-secondary, #8b98a5)' } }, label),
    h('span', { key: 'value', style: { color: tone ?? 'var(--dsw-alias-label-primary, #e7e9ea)', wordBreak: 'break-all', textAlign: 'right' } }, value),
  ])
}

export function RemotePanel() {
  const [status, setStatus] = useState<StatusResponse | null>(null)
  const [qrUrl, setQrUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = async () => {
    setError(null)
    try {
      const response = await fetch('/api/pair/status')
      if (!response.ok) throw new Error(`status ${response.status}`)
      const payload = (await response.json()) as StatusResponse
      setStatus(payload)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const issue = async () => {
    setError(null)
    try {
      const response = await fetch('/api/pair/issue', { method: 'POST', body: '{}' })
      const payload = (await response.json()) as { ok: boolean; url?: string; code?: string }
      if (!payload.ok) throw new Error(payload.code ?? 'issue failed')
      setQrUrl(payload.url ?? null)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const stop = async () => {
    setError(null)
    try {
      await fetch('/api/pair/stop', { method: 'POST', body: '{}' })
      setQrUrl(null)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  useEffect(() => {
    void refresh()
    // SSE live updates for the desktop panel.
    const controller = new AbortController()
    const events = new EventSource('/api/pair/events')
    events.onmessage = (event) => {
      try {
        const frame = JSON.parse(event.data) as PairSnapshot
        setStatus((prev) => ({
          ...(prev ?? { ok: true, paired: false, lanAvailable: frame.lanAvailable, lanAddresses: frame.lanAddresses, deviceCount: frame.deviceCount, onlineCount: frame.onlineCount }),
          phase: frame.phase,
          lanAvailable: frame.lanAvailable,
          lanAddresses: frame.lanAddresses,
          publicUrl: frame.publicUrl,
          tunnel: frame.tunnel,
          deviceCount: frame.deviceCount,
          onlineCount: frame.onlineCount,
        }))
      } catch {
        /* ignore malformed frames */
      }
    }
    return () => {
      controller.abort()
      events.close()
    }
  }, [])

  const tunnelTone = status?.tunnel?.state === 'running' ? '#00ba7c' : status?.tunnel?.state === 'failed' ? '#e5484d' : undefined
  const phaseLabel: Record<string, string> = {
    'lan-required': '需要可访问的绑定',
    stopped: '已停止',
    waiting: '等待配对',
    disconnected: '设备离线',
    connected: '已连接',
  }

  return h('div', {
    style: { padding: '0 16px 24px', overflowY: 'auto', fontFamily: 'system-ui, sans-serif' },
  }, [
    error ? h('p', { key: 'error', style: { color: '#e5484d', fontSize: 13 } }, error) : null,
    h(StatusRow, { key: 'phase', label: '配对状态', value: phaseLabel[status?.phase ?? ''] ?? status?.phase ?? '—' }),
    h(StatusRow, { key: 'devices', label: '设备', value: `${status?.onlineCount ?? 0} 在线 / ${status?.deviceCount ?? 0} 已配对` }),
    h(StatusRow, {
      key: 'tunnel',
      label: '隧道',
      value: status?.tunnel?.state === 'running' && status?.tunnel?.url ? status.tunnel.url : status?.tunnel?.error ?? status?.tunnel?.state ?? '—',
      tone: tunnelTone,
    }),

    // Actions
    h('div', { key: 'actions', style: { display: 'flex', gap: 8, margin: '12px 0' } }, [
      h('button', {
        key: 'issue',
        type: 'button',
        onClick: () => void issue(),
        style: actionButton('#00ba7c', '#06281c'),
      }, '生成配对二维码'),
      h('button', {
        key: 'stop',
        type: 'button',
        onClick: () => void stop(),
        style: actionButton('transparent', '#e5484d'),
      }, '停止配对'),
    ]),

    qrUrl
      ? h('div', { key: 'qr', style: { background: '#ffffff', borderRadius: 12, padding: 16, display: 'inline-block' } }, [
          h(QRCodeSVG, { key: 'svg', value: qrUrl, size: 220, level: 'M' }),
          h('p', { key: 'link', style: { color: '#0f1419', fontSize: 12, wordBreak: 'break-all', maxWidth: 220 } }, qrUrl),
        ])
      : h('p', { key: 'hint', style: { color: 'var(--dsw-alias-label-secondary, #8b98a5)', fontSize: 12 } }, '点击「生成配对二维码」后用手机扫码。'),

    status?.publicUrl
      ? h(StatusRow, { key: 'public', label: '公网入口', value: status.publicUrl })
      : null,
  ])
}

function actionButton(background: string, color: string): React.CSSProperties {
  return {
    padding: '8px 14px',
    borderRadius: 8,
    border: '1px solid var(--dsw-alias-border-l2, #2f3a45)',
    background,
    color,
    fontSize: 13,
    cursor: 'pointer',
  }
}
