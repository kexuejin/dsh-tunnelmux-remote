/**
 * Remote-control launcher: sidebar foot button + right-hand drawer overlay
 * hosting the pairing/QR status panel. The two slots are separate
 * registrations (embedding the overlay inside the button would render it
 * inside the sidebar footer's zero-size DOM).
 */
import { createElement as h, useEffect, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { RemotePanel } from './RemotePanel.tsx'

// ── tiny shared store: open state bridged between the two slot registrations ──
let panelOpen = false
const listeners = new Set<() => void>()
function setPanelOpen(v: boolean): void {
  panelOpen = v
  for (const fn of listeners) fn()
}
function subscribePanelOpen(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}
function usePanelOpen(): boolean {
  const [open, setOpen] = useState(panelOpen)
  useEffect(() => subscribePanelOpen(() => setOpen(panelOpen)), [])
  return open
}

/** Foot button rendered in the official left sidebar (wide row or rail icon). */
function RemoteFootButton({ wide }: { wide: boolean }) {
  const open = usePanelOpen()
  return h('button', {
    type: 'button',
    title: '手机远程控制',
    'aria-label': '手机远程控制',
    'aria-expanded': open,
    onClick: () => setPanelOpen(!panelOpen),
    style: {
      width: '100%',
      height: 36,
      border: 'none',
      borderRadius: 8,
      background: 'transparent',
      color: 'var(--dsw-alias-label-secondary, #8b98a5)',
      cursor: 'pointer',
      display: 'flex',
      alignItems: 'center',
      justifyContent: wide ? 'flex-start' : 'center',
      gap: 8,
      padding: wide ? '0 12px' : 0,
      fontSize: 13,
    },
  }, [
    h('span', { key: 'icon', style: { fontSize: 15, lineHeight: 1 } }, '远'),
    wide ? h('span', { key: 'label' }, '远程控制') : null,
  ])
}

/** Right-hand drawer overlay registered as its own shell.overlay entry. */
function RemoteOverlay() {
  const open = usePanelOpen()
  const onClose = () => setPanelOpen(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && open) setPanelOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])
  return h('div', {
    style: {
      position: 'absolute',
      top: 0,
      right: 0,
      bottom: 0,
      width: 'min(480px, 92vw)',
      background: 'var(--dsw-alias-bg-base, #0f1419)',
      borderLeft: '1px solid var(--dsw-alias-border-l2, #2f3a45)',
      boxShadow: '-12px 0 32px rgba(0,0,0,.35)',
      display: 'flex',
      flexDirection: 'column',
      zIndex: 21,
      visibility: open ? 'visible' : 'hidden',
      transform: open ? 'translateX(0)' : 'translateX(100%)',
      transition: 'transform .18s ease, visibility .18s',
      pointerEvents: open ? 'auto' : 'none',
    },
  }, [
    h('div', {
      key: 'bar',
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '8px 16px',
        borderBottom: '1px solid var(--dsw-alias-border-l2, #2f3a45)',
        background: 'var(--dsw-alias-bg-layer-1, #171e26)',
      },
    }, [
      h('strong', { key: 'title', style: { fontSize: 14 } }, '手机远程控制'),
      h('span', { key: 'hint', style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary, #8b98a5)' } }, '扫码配对 · TunnelMux 隧道'),
      h('span', { key: 'spacer', style: { flex: 1 } }),
      h('button', {
        key: 'close',
        type: 'button',
        onClick: onClose,
        style: {
          padding: '6px 12px',
          borderRadius: 8,
          border: '1px solid var(--dsw-alias-border-l2, #2f3a45)',
          background: 'var(--dsw-alias-bg-layer-2, #1c2530)',
          color: 'var(--dsw-alias-label-primary, #e7e9ea)',
          fontSize: 13,
          cursor: 'pointer',
        },
      }, '关闭 (Esc)'),
    ]),
    h(RemotePanel, { key: 'panel' }),
  ])
}

export function registerRemoteLauncher(ctx: Context): void {
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'tunnelmux-remote',
    order: 20,
  }, RemoteFootButton))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'tunnelmux-remote-drawer',
    order: 20,
  }, RemoteOverlay))
}
