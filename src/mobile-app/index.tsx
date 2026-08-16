/**
 * dsh-tunnelmux-remote mobile bundle: a standalone phone UI served at /m.
 * Talks to the host exclusively through /m/api RPC (paired-device cookie)
 * and /m/api/events.mux SSE. Built by tsdown into lib/mobile.js with react
 * inlined (no module loader on the phone).
 */
import { createRoot } from 'react-dom/client'
import React, { useEffect, useRef, useState } from 'react'

interface SessionRow {
  sessionId: string
  title?: string
  updatedAt: number
}

interface Envelope<T = unknown> {
  type: string
  rpcId: string
  result: { ok: boolean; value?: T; error?: { code: string; message: string } }
}

let rpcSerial = 0

async function rpc<T = unknown>(method: string, payload?: unknown): Promise<T> {
  const rpcId = `m-${++rpcSerial}`
  const response = await fetch(`/m/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rpcId, payload }),
  })
  if (response.status === 403) throw new Error('unpaired')
  const envelope = (await response.json()) as Envelope<T>
  if (!envelope.result?.ok) {
    throw new Error(envelope.result?.error?.message ?? `rpc ${method} failed`)
  }
  return envelope.result.value as T
}

function App() {
  const [sessions, setSessions] = useState<SessionRow[]>([])
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [unpaired, setUnpaired] = useState(false)
  const [enterToSend, setEnterToSend] = useState(true)
  const [title, setTitle] = useState('')
  const [message, setMessage] = useState('')
  const messagesEndRef = useRef<HTMLDivElement | null>(null)

  const loadPreferences = async () => {
    try {
      const value = await rpc<{ mobileEnterToSend: boolean }>('mobile.preferences')
      setEnterToSend(value.mobileEnterToSend)
    } catch {
      /* preferences are best-effort */
    }
  }

  const loadSessions = async (cursor?: string) => {
    setLoading(true)
    setError(null)
    try {
      const value = await rpc<{ items: SessionRow[]; hasMore: boolean; nextCursor?: string }>('session.list', cursor ? { cursor } : {})
      setSessions((prev) => (cursor ? [...prev, ...value.items] : value.items))
      setNextCursor(value.hasMore ? value.nextCursor : undefined)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message === 'unpaired') setUnpaired(true)
      else setError(message)
    } finally {
      setLoading(false)
    }
  }

  const createSession = async () => {
    if (!title.trim()) return
    setError(null)
    try {
      await rpc('session.create', { title: title.trim() })
      setTitle('')
      await loadSessions()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const sendMessage = async () => {
    if (!message.trim()) return
    setError(null)
    try {
      await rpc('session.prompt', { message: message.trim() })
      setMessage('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  useEffect(() => {
    void loadPreferences()
    void loadSessions()
  }, [])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [sessions])

  if (unpaired) {
    return (
      <div style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}>
        <h1>未配对</h1>
        <p>请先在电脑上打开 DSH，扫码配对后刷新本页。</p>
        <button onClick={() => window.location.reload()}>重试</button>
      </div>
    )
  }

  const styles = {
    page: { padding: 16, fontFamily: 'system-ui, sans-serif', maxWidth: 640, margin: '0 auto' },
    row: { padding: '10px 0', borderBottom: '1px solid #e5e7eb' },
    input: { width: '100%', padding: 8, marginBottom: 8, boxSizing: 'border-box' as const },
    button: { padding: '8px 16px', marginRight: 8 },
  }

  return (
    <div style={styles.page}>
      <h2 style={{ marginTop: 0 }}>移动端远程控制</h2>
      {error && <p style={{ color: '#b91c1c' }}>{error}</p>}

      <section>
        <h3>新建会话</h3>
        <input
          style={styles.input}
          placeholder="会话标题"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <button style={styles.button} onClick={() => void createSession()}>创建</button>
      </section>

      <section>
        <h3>会话列表</h3>
        {sessions.length === 0 && !loading && <p>暂无会话</p>}
        {sessions.map((session) => (
          <div key={session.sessionId} style={styles.row}>
            {session.title ?? session.sessionId}
          </div>
        ))}
        {loading && <p>加载中…</p>}
        {nextCursor !== undefined && !loading && (
          <button style={styles.button} onClick={() => void loadSessions(nextCursor)}>加载更多</button>
        )}
      </section>

      <section>
        <h3>发消息</h3>
        <textarea
          style={{ ...styles.input, minHeight: 64 }}
          placeholder={enterToSend ? '输入消息（回车发送）' : '输入消息'}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (enterToSend && e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void sendMessage()
            }
          }}
        />
        <button style={styles.button} onClick={() => void sendMessage()}>发送</button>
      </section>
      <div ref={messagesEndRef} />
    </div>
  )
}

const root = document.getElementById('root')
if (root) {
  createRoot(root).render(React.createElement(App))
}
