// language: Node.js ESM | file: index.js | target: Render Web Service
// Multi-account WhatsApp panel — sessions persist via Render persistent disk

import * as baileysNs from '@whiskeysockets/baileys'

// Baileys' CJS/ESM interop differs between versions; resolve exports defensively
const B = { ...(baileysNs.default && typeof baileysNs.default === 'object' ? baileysNs.default : {}), ...baileysNs }
const makeWASocket =
  (typeof baileysNs.default === 'function' && baileysNs.default) ||
  (typeof baileysNs.default?.default === 'function' && baileysNs.default.default) ||
  (typeof B.makeWASocket === 'function' && B.makeWASocket) ||
  (typeof B.default === 'function' && B.default)
const {
  DisconnectReason,
  fetchLatestBaileysVersion,
  initAuthCreds,
  BufferJSON,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState
} = B
if (typeof makeWASocket !== 'function') throw new Error('Could not resolve makeWASocket from baileys')
import express from 'express'
import { toDataURL } from 'qrcode'
import { randomBytes } from 'crypto'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import {
  existsSync, mkdirSync, readdirSync, statSync, rmSync,
  readFileSync, writeFileSync, renameSync
} from 'fs'
import pino from 'pino'

const __dirname = dirname(fileURLToPath(import.meta.url))
const app = express()
app.use(express.json())
app.use(express.static(join(__dirname, 'public')))

// ─── Config ───────────────────────────────────────────────────────────────────
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme'

// DATA_DIR: use env var if set, else ./data
// If that path is not writable (disk not mounted yet), fall back to ./data inside app dir
let DATA_DIR = process.env.DATA_DIR || './data'
try {
  mkdirSync(DATA_DIR, { recursive: true })
} catch (e) {
  if (e.code === 'EACCES') {
    DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), 'data')
    console.warn(`[warn] ${process.env.DATA_DIR} not writable — falling back to ${DATA_DIR}`)
    console.warn('[warn] Sessions will NOT survive redeploys. Add disk in Render dashboard to fix.')
    mkdirSync(DATA_DIR, { recursive: true })
  } else {
    throw e
  }
}

const AUTH_DIR       = join(DATA_DIR, 'auth')
const ACCOUNTS_FILE  = join(DATA_DIR, 'accounts.json')
const SESSIONS_FILE  = join(DATA_DIR, 'sessions.json')

mkdirSync(AUTH_DIR, { recursive: true })

// ─── File-based JSON store (Render persistent disk) ───────────────────────────
function readJSON(filePath, fallback) {
  try { return JSON.parse(readFileSync(filePath, 'utf8')) }
  catch { return fallback }
}

function writeJSON(filePath, data) {
  const tmp = filePath + '.tmp'
  writeFileSync(tmp, JSON.stringify(data, null, 2))
  renameSync(tmp, filePath)   // atomic write — no partial file on crash
}

// ─── Account persistence ──────────────────────────────────────────────────────
function savedPhones()      { return readJSON(ACCOUNTS_FILE, []) }
function savePhone(phone)   {
  const s = new Set(savedPhones()); s.add(phone)
  writeJSON(ACCOUNTS_FILE, [...s])
}
function unsavePhone(phone) {
  writeJSON(ACCOUNTS_FILE, savedPhones().filter(p => p !== phone))
}

// ─── Admin session persistence ────────────────────────────────────────────────
// In-memory cache + file fallback → survives redeploys
const adminSessions = new Map() // token -> expiry (runtime cache)

function sessionsFromFile() { return readJSON(SESSIONS_FILE, {}) }

function flushSessions(map) {
  // prune expired before writing
  const now = Date.now()
  const clean = {}
  for (const [t, e] of Object.entries(map)) {
    if (e > now) clean[t] = e
  }
  writeJSON(SESSIONS_FILE, clean)
  return clean
}

function adminSessionSet(token, expiry) {
  adminSessions.set(token, expiry)
  const s = sessionsFromFile()
  s[token] = expiry
  flushSessions(s)
}

function adminSessionGet(token) {
  // in-memory fast path
  const exp = adminSessions.get(token)
  if (exp) {
    if (Date.now() < exp) return exp
    adminSessions.delete(token)
    return null
  }
  // file fallback — recovers sessions after redeploy
  const s = sessionsFromFile()
  const expiry = s[token]
  if (expiry && Date.now() < expiry) {
    adminSessions.set(token, expiry)   // repopulate cache
    return expiry
  }
  return null
}

function loadSessionsFromFile() {
  const s = sessionsFromFile()
  const now = Date.now()
  for (const [token, exp] of Object.entries(s)) {
    if (exp > now) adminSessions.set(token, exp)
  }
}

// ─── Auth State ───────────────────────────────────────────────────────────────
async function buildAuthState(phone) {
  mkdirSync(join(AUTH_DIR, phone), { recursive: true })
  return useMultiFileAuthState(join(AUTH_DIR, phone))
}

// ─── Account Manager ──────────────────────────────────────────────────────────
const accounts = new Map()

function extractCodes(text) {
  return [...new Set((text.match(/\b\d{4,8}\b/g) || []))]
}

function broadcast(event, data) {
  for (const res of sseClients.values()) {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`) } catch {}
  }
}

async function connectAccount(phone) {
  if (accounts.has(phone)) return

  const entry = { sock: null, connected: false, qr: null, msgs: [] }
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
          accounts.delete(phone)
          unsavePhone(phone)
          broadcast('removed', { phone })
        } else {
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
        if (msg.key.fromMe) continue
        const text =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          msg.message?.imageMessage?.caption ||
          ''
        if (!text) continue

        const from     = (msg.key.remoteJid || '').replace(/@.+/, '')
        const codes    = extractCodes(text)
        const msgEntry = { id: msg.key.id, ts: Date.now(), from, text, codes }

        entry.msgs.unshift(msgEntry)
        if (entry.msgs.length > 60) entry.msgs.pop()
        broadcast('message', { phone, msg: msgEntry })
      }
    })
  }

  await doConnect()
  savePhone(phone)
}

async function removeAccount(phone) {
  const entry = accounts.get(phone)
  if (entry?.sock) {
    try { await entry.sock.logout() } catch {}
    try { entry.sock.end() }         catch {}
  }
  accounts.delete(phone)
  unsavePhone(phone)
  try { rmSync(join(AUTH_DIR, phone), { recursive: true, force: true }) } catch {}
}

async function loadSavedAccounts() {
  const phones = savedPhones()
  for (const phone of phones) {
    console.log(`Restoring: ${phone}`)
    await connectAccount(phone).catch(e => console.error('Restore failed:', phone, e.message))
  }
}

// ─── Admin middleware ─────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  const token = req.headers['x-token'] || req.query.token
  if (!token) return res.status(401).json({ error: 'Auth required' })
  const exp = adminSessionGet(token)
  if (!exp) return res.status(401).json({ error: 'Auth required' })
  next()
}

// ─── SSE Clients ──────────────────────────────────────────────────────────────
const sseClients = new Map()

// ─── Routes ───────────────────────────────────────────────────────────────────

app.post('/api/login', (req, res) => {
  if ((req.body.password || '') !== ADMIN_PASSWORD)
    return res.status(401).json({ error: 'Wrong password' })
  const token  = randomBytes(32).toString('hex')
  const expiry = Date.now() + 86_400_000
  adminSessionSet(token, expiry)
  res.json({ token })
})

app.get('/api/accounts', requireAdmin, (_, res) => {
  const list = []
  for (const [phone, entry] of accounts)
    list.push({ phone, connected: entry.connected, hasQR: !!entry.qr })
  res.json(list)
})

app.post('/api/accounts', requireAdmin, async (req, res) => {
  const phone = (req.body.phone || '').replace(/\D/g, '')
  if (phone.length < 7)   return res.status(400).json({ error: 'Valid number required' })
  if (accounts.has(phone)) return res.status(409).json({ error: 'Already exists' })
  await connectAccount(phone)
  res.json({ ok: true, phone })
})

app.delete('/api/accounts/:phone', requireAdmin, async (req, res) => {
  const { phone } = req.params
  if (!accounts.has(phone)) return res.status(404).json({ error: 'Not found' })
  await removeAccount(phone)
  res.json({ ok: true })
})

app.get('/api/accounts/:phone/qr', requireAdmin, (req, res) => {
  const entry = accounts.get(req.params.phone)
  if (!entry) return res.status(404).json({ error: 'Not found' })
  res.json({ qr: entry.qr, connected: entry.connected })
})

app.get('/api/accounts/:phone/messages', requireAdmin, (req, res) => {
  const entry = accounts.get(req.params.phone)
  if (!entry) return res.status(404).json({ error: 'Not found' })
  res.json(entry.msgs)
})

app.post('/api/accounts/:phone/send', requireAdmin, async (req, res) => {
  const entry = accounts.get(req.params.phone)
  if (!entry)           return res.status(404).json({ error: 'Not found' })
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

app.get('/api/events', requireAdmin, (req, res) => {
  res.writeHead(200, {
    'Content-Type':      'text/event-stream',
    'Cache-Control':     'no-cache',
    'Connection':        'keep-alive',
    'X-Accel-Buffering': 'no'
  })

  const snapshot = []
  for (const [phone, entry] of accounts)
    snapshot.push({ phone, connected: entry.connected, hasQR: !!entry.qr })
  res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`)

  const hb = setInterval(() => { try { res.write(':hb\n\n') } catch {} }, 25_000)
  const id  = randomBytes(8).toString('hex')
  sseClients.set(id, res)
  req.on('close', () => { sseClients.delete(id); clearInterval(hb) })
})

app.get('/ping', (_, res) => res.send('ok'))
const BASE_URL = process.env.RENDER_EXTERNAL_URL
if (BASE_URL) {
  setInterval(() => fetch(`${BASE_URL}/ping`).catch(() => {}), 4 * 60_000)
}

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000
app.listen(PORT, async () => {
  console.log(`WA Multi-Panel on :${PORT} | Data: ${DATA_DIR} | Storage: Render disk`)
  loadSessionsFromFile()
  await loadSavedAccounts()
})
