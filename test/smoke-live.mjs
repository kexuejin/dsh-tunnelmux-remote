import { createTunnelMuxHttpClient } from '../lib/index.js'

const client = createTunnelMuxHttpClient('http://127.0.0.1:4765')
const health = await client.request('/v1/health')
const healthBody = await health.json()
console.log('health:', health.status, JSON.stringify(healthBody))

const status = await client.request('/v1/tunnel/status')
const statusBody = await status.json()
const tunnel = statusBody.tunnel ?? statusBody
console.log('status keys:', Object.keys(tunnel).sort().join(','))
console.log('state:', tunnel.state, '| provider:', tunnel.provider, '| target:', tunnel.target_url)
console.log('has public_base_url field:', 'public_base_url' in tunnel, '=', tunnel.public_base_url)
console.log('has last_error field:', 'last_error' in tunnel, '=', tunnel.last_error)
console.log('auto_restart:', tunnel.auto_restart)
