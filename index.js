// language: Node.js ESM | file: index.js | target: Render Web Service
// Multi-account WhatsApp panel — sessions persist via Upstash Redis

import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  initAuthCreds,
  BufferJSON,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState
} from '@whiskeysockets/baileys'
import express from 'express'
import { toDataURL } from 'qrcode'
import { randomBytes } from 'crypto'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { existsSync, mkdirSync, readdirSync, statSync, rmSync } from 'fs'
import pino from 'pino'

const __dirname = dirname(fileURLToPath(import.meta.url))
const app = express()
app.use(express.json())
app.use(express.static(join(__dirname, 'public')))

// ─── Config ───────────────────────────────────────────────────────────────────
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme'
const REDIS_URL      = (process.env.UPSTASH_REDIS_REST_URL   || '').trim()
const REDIS_TOKEN    = (process.env.UPSTASH_REDIS_REST_TOKEN || '').trim()
const USE_REDIS      = !!(REDIS_URL && REDIS_TOKEN)

// ─── Redis helpers (Upstash REST API) ─────────────────────────────────────────
async function redisCmd(command, ...args) {
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([command, ...args])
  })
  const d = await r.json()
  return d.result
}

async function redisPipe(commands) {
  if (!commands.length) return []
  const r = await fetch(`${REDIS_URL}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands)
  })
  return r.json()
}

// ─── Auth State Adapter ───────────────────────────────────────────────────────
// Redis: persists across redeploys  |  Local files: resets on redeploy
async function buildAuthState(phone) {
  if (USE_REDIS) return buildRedisAuthState(phone)
  mkdirSync(`./auth/${phone}`, { recursive: true })
  return useMultiFileAuthState(`./auth/${phone}`)
}

async function buildRedisAuthState(phone) {
  const prefix = `wa:auth:${phone}`

  async function rGet(key) {
    const v = await redisCmd('GET', `${prefix}:${key}`)
    return v ? JSON.parse(v, BufferJSON.reviver) : null
  }

  async function rSet(key, value) {
    await redisCmd('SET', `${prefix}:${key}`, JSON.stringify(value, BufferJSON.replacer))
  }

  const creds = (await rGet('creds')) || initAuthCreds()

  const state = {
    creds,
    keys: makeCacheableSignalKeyStore({
      get: async (type, ids) => {
        if (!ids.length) return {}
        const cmds   = ids.map(id => ['GET', `${prefix}:k:${type}:${id}`])
        const results = await redisPipe(cmds)
        const out = {}
        ids.forEach((id, i) => {
          if (results[i]?.result)
            out[id] = JSON.parse(results[i].result, BufferJSON.reviver)
        })
        return out
      },
      set: async (data) => {
        const cmds = []
        for (const [type, map] of Object.entries(data)) {
          for (const [id, val] of Object.entries(map)) {
            const k = `${prefix}:k:${type}:${id}`
            cmds.push(val != null
              ? ['SET', k, JSON.stringify(val, BufferJSON.replacer)]
              : ['DEL', k])
          }
        }
        if (cmds.length) await redisPipe(cmds)
      }
    }, pino({ level: 'silent' }))
  }

  const saveCreds = () => rSet('creds', creds)
  return { state, saveCreds }
}

// ─── Account Manager ──────────────────────────────────────────────────────────
// accounts: Map<phone, AccountEntry>
// AccountEntry: { sock, connected, qr, msgs: [MsgEntry], stop }
const accounts = new Map()

// MsgEntry: { id, ts, from, text, codes }

function extractCodes(text) {
  return [...new Set((text.match(/\b\d{4,8}\b/g) || []))]
}

function broadcast(event, data) {
  for (const res of sseClients.values()) {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`) } catch {}
  }
}

async function connectAccount(phone) {
  if (accounts.has(phone)) return // already running

  const entry = { sock: null, connected: false, qr: null, msgs: [], reconnecting: false }
  accounts.set(phone, entry)

  async function doConnect() {
    const { state, saveCreds } = await buildAuthState(phone)
    const { version }          = await fetchLatestBaileysVersion()

    const sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      browser: [`Panel-${phone}`, 'Chrome', '3.0'],
      connectTimeoutMs: 30_000,
      keepAliveIntervalMs: 10_000
    })

    entry.sock = sock

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        entry.qr = await toDataURL(qr)
        broadcast('status', { phone, connected: false, hasQR: true })
      }

      if (connection === 'close') {
        entry.connected = false
        entry.qr = null
        const code = lastDisconnect?.error?.output?.statusCode
        broadcast('status', { phone, connected: false, hasQR: false })

        if (code === DisconnectReason.loggedOut) {
          // Kicked out — clean up
          accounts.delete(phone)
          if (USE_REDIS) await redisCmd('SREM', 'wa:accounts', phone).catch(() => {})
          broadcast('removed', { phone })
        } else {
          // Network drop / timeout — reconnect
          setTimeout(doConnect, 3500)
        }
      }

      if (connection === 'open') {
        entry.connected = true
        entry.qr = null
        broadcast('status', { phone, connected: true, hasQR: false })
      }
    })

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return
      for (const msg of messages) {
        if (msg.key.fromMe) continue // skip messages we sent
        const text =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          msg.message?.imageMessage?.caption ||
          ''
        if (!text) continue

        const from  = (msg.key.remoteJid || '').replace(/@.+/, '')
        const codes = extractCodes(text)
        const msgEntry = { id: msg.key.id, ts: Date.now(), from, text, codes }

        entry.msgs.unshift(msgEntry)
        if (entry.msgs.length > 60) entry.msgs.pop()

        broadcast('message', { phone, msg: msgEntry })
      }
    })
  }

  await doConnect()

  // Register in persistence layer
  if (USE_REDIS) {
    await redisCmd('SADD', 'wa:accounts', phone).catch(() => {})
  } else {
    mkdirSync('./auth', { recursive: true })
  }
}

async function removeAccount(phone) {
  const entry = accounts.get(phone)
  if (entry?.sock) {
    try { await entry.sock.logout() } catch {}
    try { entry.sock.end() } catch {}
  }
  accounts.delete(phone)

  if (USE_REDIS) {
    await redisCmd('SREM', 'wa:accounts', phone).catch(() => {})
    await redisCmd('DEL', `wa:auth:${phone}:creds`).catch(() => {})
  } else {
    try { rmSync(`./auth/${phone}`, { recursive: true, force: true }) } catch {}
  }
}

async function loadSavedAccounts() {
  let phones = []

  if (USE_REDIS) {
    phones = (await redisCmd('SMEMBERS', 'wa:accounts').catch(() => [])) || []
  } else {
    if (existsSync('./auth')) {
      phones = readdirSync('./auth').filter(d => statSync(`./auth/${d}`).isDirectory())
    }
  }

  for (const phone of phones) {
    console.log(`Restoring account: ${phone}`)
    await connectAccount(phone).catch(e => console.error('Restore failed:', phone, e.message))
  }
}

// ─── Admin Sessions ───────────────────────────────────────────────────────────
const adminSessions = new Map() // token -> expiry

function requireAdmin(req, res, next) {
  const token = req.headers['x-token'] || req.query.token
  const exp   = adminSessions.get(token)
  if (!exp || Date.now() > exp) return res.status(401).json({ error: 'Auth required' })
  next()
}

// ─── SSE Clients ──────────────────────────────────────────────────────────────
const sseClients = new Map() // clientId -> res

// ─── Routes ───────────────────────────────────────────────────────────────────

// Admin login
app.post('/api/login', (req, res) => {
  if ((req.body.password || '') !== ADMIN_PASSWORD)
    return res.status(401).json({ error: 'Wrong password' })
  const token = randomBytes(32).toString('hex')
  adminSessions.set(token, Date.now() + 86_400_000)
  res.json({ token })
})

// List accounts
app.get('/api/accounts', requireAdmin, (_, res) => {
  const list = []
  for (const [phone, entry] of accounts) {
    list.push({ phone, connected: entry.connected, hasQR: !!entry.qr })
  }
  res.json(list)
})

// Add account
app.post('/api/accounts', requireAdmin, async (req, res) => {
  const phone = (req.body.phone || '').replace(/\D/g, '')
  if (phone.length < 7) return res.status(400).json({ error: 'Valid number required' })
  if (accounts.has(phone)) return res.status(409).json({ error: 'Already exists' })
  await connectAccount(phone)
  res.json({ ok: true, phone })
})

// Remove account
app.delete('/api/accounts/:phone', requireAdmin, async (req, res) => {
  const { phone } = req.params
  if (!accounts.has(phone)) return res.status(404).json({ error: 'Not found' })
  await removeAccount(phone)
  res.json({ ok: true })
})

// Get QR for account
app.get('/api/accounts/:phone/qr', requireAdmin, (req, res) => {
  const entry = accounts.get(req.params.phone)
  if (!entry) return res.status(404).json({ error: 'Not found' })
  res.json({ qr: entry.qr, connected: entry.connected })
})

// Get messages (OTP log)
app.get('/api/accounts/:phone/messages', requireAdmin, (req, res) => {
  const entry = accounts.get(req.params.phone)
  if (!entry) return res.status(404).json({ error: 'Not found' })
  res.json(entry.msgs)
})

// Send message
app.post('/api/accounts/:phone/send', requireAdmin, async (req, res) => {
  const entry = accounts.get(req.params.phone)
  if (!entry) return res.status(404).json({ error: 'Not found' })
  if (!entry.connected) return res.status(503).json({ error: 'Not connected' })

  const to   = (req.body.to   || '').replace(/\D/g, '')
  const text = (req.body.text || '').trim()
  if (!to || !text) return res.status(400).json({ error: 'to and text required' })

  try {
    await entry.sock.sendMessage(`${to}@s.whatsapp.net`, { text })
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// SSE — real-time events stream
// Token via query param because EventSource can't set headers
app.get('/api/events', requireAdmin, (req, res) => {
  res.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
    'X-Accel-Buffering': 'no'
  })

  // Push current state immediately
  const snapshot = []
  for (const [phone, entry] of accounts) {
    snapshot.push({ phone, connected: entry.connected, hasQR: !!entry.qr })
  }
  res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`)

  // Heartbeat every 25s to prevent proxy timeout
  const hb = setInterval(() => { try { res.write(':hb\n\n') } catch {} }, 25_000)

  const id = randomBytes(8).toString('hex')
  sseClients.set(id, res)
  req.on('close', () => { sseClients.delete(id); clearInterval(hb) })
})

// Keep-alive ping (Render free tier)
app.get('/ping', (_, res) => res.send('ok'))
const BASE_URL = process.env.RENDER_EXTERNAL_URL
if (BASE_URL) {
  setInterval(() => fetch(`${BASE_URL}/ping`).catch(() => {}), 4 * 60_000)
}

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000
app.listen(PORT, async () => {
  console.log(`WA Multi-Panel on :${PORT} | Persistence: ${USE_REDIS ? 'Redis ✓' : 'Local Files (redeploy = re-scan)'}`)
  await loadSavedAccounts()
})
