import { createLibp2p } from 'libp2p'
import { webRTCDirect } from '@libp2p/webrtc'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { peerIdFromString } from '@libp2p/peer-id'
import { multiaddr } from '@multiformats/multiaddr'
import { fromString, toString } from 'uint8arrays'

const CHAT_PROTO = '/chat/1.0.0'
const BULLETIN = '__bulletin__'

const $ = (id) => document.getElementById(id)
const nameInput = $('display-name')
const addrInput = $('addr')
const connectBtn = $('connect')
const disconnectBtn = $('disconnect')
const statusEl = $('status')
const statusDot = $('status-dot')
const statusText = $('status-text')
const myPeerEl = $('my-peer')
const rosterEl = $('roster')
const logEl = $('log')
const msgInput = $('msg')
const sendBtn = $('send')
const composeForm = $('compose')
const chatCardEl = $('chat-card')
const landingView = $('landing')
const appView = $('app')
const tryItBtn = $('try-it')
const titleEl = $('title')

let node = null
let stream = null
let readBuf = ''
let myPeerId = null
let myName = ''

let identityKey = null
let dmKeyPair = null
let dmPublicKeyB64 = null
let dmSignatureB64 = null
const sharedKeyCache = new Map()

const DM_SIG_DOMAIN = 'libp2p-webrtc-dm-key-v1:'
function dmSignPayload(rawDmPubKey) {
  const prefix = new TextEncoder().encode(DM_SIG_DOMAIN)
  const out = new Uint8Array(prefix.length + rawDmPubKey.length)
  out.set(prefix, 0)
  out.set(rawDmPubKey, prefix.length)
  return out
}

/** @type {Map<string, { peerId: string, dmPublicKey: string, name: string }>} */
const roster = new Map()

/**
 * @typedef {{ kind: 'out' | 'in' | 'sys', text: string, label?: string, status?: 'pending' | 'acked' | 'failed', id?: number, bubbleEl?: HTMLElement }} Msg
 * @type {Map<string, { messages: Msg[], unread: number }>}
 */
const conversations = new Map()

let selectedConvo = BULLETIN
let nextOutgoingId = 1

const ADJECTIVES = ['quiet', 'bold', 'clever', 'noble', 'wild', 'swift', 'shy', 'merry', 'bright', 'grumpy', 'keen', 'vivid', 'sleek', 'dusty', 'bouncy', 'crispy', 'gentle', 'fierce', 'tipsy', 'fancy', 'sneaky', 'cozy', 'sturdy', 'breezy', 'tiny', 'jolly', 'spry', 'mellow', 'zesty', 'plucky', 'hazy', 'nimble']
const NOUNS = ['raven', 'panda', 'fox', 'otter', 'moth', 'ox', 'lark', 'newt', 'wren', 'owl', 'quokka', 'yak', 'badger', 'crow', 'moose', 'heron', 'stoat', 'toad', 'seal', 'gecko', 'orca', 'hare', 'lynx', 'bison', 'snail', 'elk', 'squid', 'goose', 'axolotl', 'pangolin', 'walrus', 'narwhal']

function randomName() {
  const a = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]
  const n = NOUNS[Math.floor(Math.random() * NOUNS.length)]
  return `${a}-${n}`
}

nameInput.value = randomName()
const savedAddr = localStorage.getItem('server-multiaddr')
if (savedAddr) addrInput.value = savedAddr

// ------- util -------

const b64enc = (u8) => btoa(String.fromCharCode(...u8))
const b64dec = (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0))

function shortId(id) {
  if (typeof id !== 'string') return '?'
  return id.length > 10 ? `…${id.slice(-8)}` : id
}

function peerLabel(peerId) {
  if (peerId === myPeerId) return myName || 'you'
  return roster.get(peerId)?.name ?? shortId(peerId)
}

function setStatus(kind, text) {
  statusDot.className = `dot${kind ? ` ${kind}` : ''}`
  statusText.textContent = text
}

function getConvo(key) {
  let c = conversations.get(key)
  if (!c) {
    c = { messages: [], unread: 0 }
    conversations.set(key, c)
  }
  return c
}

function setConnected(connected) {
  connectBtn.disabled = connected
  disconnectBtn.disabled = !connected
  addrInput.disabled = connected
  nameInput.disabled = connected
  chatCardEl.hidden = !connected
  if (!connected) {
    selectedConvo = BULLETIN
    msgInput.disabled = true
    sendBtn.disabled = true
    msgInput.placeholder = 'connect to start chatting'
  }
}

// ------- crypto -------

async function generateDmKeyPair() {
  dmKeyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveKey']
  )
  const rawPub = new Uint8Array(await crypto.subtle.exportKey('raw', dmKeyPair.publicKey))
  dmPublicKeyB64 = b64enc(rawPub)
  const sig = await identityKey.sign(dmSignPayload(rawPub))
  dmSignatureB64 = b64enc(sig instanceof Uint8Array ? sig : new Uint8Array(sig))
}

async function importPeerPubKey(b64) {
  return crypto.subtle.importKey(
    'raw', b64dec(b64),
    { name: 'ECDH', namedCurve: 'P-256' }, false, []
  )
}

function sharedKeyFor(peerId) {
  let promise = sharedKeyCache.get(peerId)
  if (promise) return promise
  const entry = roster.get(peerId)
  if (!entry) return Promise.reject(new Error(`unknown peer ${peerId}`))
  promise = (async () => {
    const peerPub = await importPeerPubKey(entry.dmPublicKey)
    return crypto.subtle.deriveKey(
      { name: 'ECDH', public: peerPub },
      dmKeyPair.privateKey,
      { name: 'AES-GCM', length: 256 },
      false, ['encrypt', 'decrypt']
    )
  })()
  sharedKeyCache.set(peerId, promise)
  return promise
}

async function encryptFor(peerId, text) {
  const key = await sharedKeyFor(peerId)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, new TextEncoder().encode(text)
  )
  return { iv: b64enc(iv), ciphertext: b64enc(new Uint8Array(cipher)) }
}

async function decryptFrom(peerId, ivB64, ciphertextB64) {
  const key = await sharedKeyFor(peerId)
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64dec(ivB64) }, key, b64dec(ciphertextB64)
  )
  return new TextDecoder().decode(plain)
}

// ------- UI -------

function convoListEntries() {
  const entries = [{ key: BULLETIN, label: 'bulletin', sub: 'public · not encrypted', kind: 'bulletin' }]
  const others = [...roster.values()]
    .filter(p => p.peerId !== myPeerId)
    .sort((a, b) => a.name.localeCompare(b.name))
  for (const p of others) {
    entries.push({
      key: p.peerId,
      label: p.name,
      sub: shortId(p.peerId),
      kind: 'dm'
    })
  }
  return entries
}

function renderRoster() {
  rosterEl.innerHTML = ''
  if (myPeerId) {
    const me = document.createElement('div')
    me.className = 'sidebar-self'
    const name = document.createElement('div')
    name.className = 'name'
    name.textContent = myName || 'you'
    const sub = document.createElement('div')
    sub.className = 'sub'
    sub.textContent = shortId(myPeerId)
    me.appendChild(name)
    me.appendChild(sub)
    rosterEl.appendChild(me)
  }

  const entries = convoListEntries()
  for (const e of entries) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = `convo-item${e.kind === 'bulletin' ? ' bulletin' : ''}${e.key === selectedConvo ? ' active' : ''}`
    btn.dataset.key = e.key
    const text = document.createElement('div')
    text.className = 'convo-text'
    const nameEl = document.createElement('div')
    nameEl.className = 'name'
    nameEl.textContent = e.label
    text.appendChild(nameEl)
    if (e.sub) {
      const subEl = document.createElement('div')
      subEl.className = 'sub'
      subEl.textContent = e.sub
      text.appendChild(subEl)
    }
    btn.appendChild(text)
    const convo = getConvo(e.key)
    if (convo.unread > 0 && e.key !== selectedConvo) {
      const badge = document.createElement('span')
      badge.className = 'unread'
      badge.textContent = String(convo.unread)
      btn.appendChild(badge)
    }
    btn.addEventListener('click', () => selectConvo(e.key))
    rosterEl.appendChild(btn)
  }

  if (myPeerId && roster.size <= 1) {
    const hint = document.createElement('div')
    hint.className = 'sidebar-hint'
    hint.textContent = 'no other peers yet — wait for someone else to connect'
    rosterEl.appendChild(hint)
  }
}

function renderLog() {
  logEl.innerHTML = ''
  if (!stream) {
    const hint = document.createElement('div')
    hint.className = 'sys'
    hint.textContent = 'not connected'
    logEl.appendChild(hint)
    return
  }
  if (selectedConvo === BULLETIN) {
    const banner = document.createElement('div')
    banner.className = 'sys'
    banner.textContent = 'public bulletin — every message is visible to the server and all connected peers'
    logEl.appendChild(banner)
  } else if (!roster.has(selectedConvo)) {
    const banner = document.createElement('div')
    banner.className = 'sys'
    banner.textContent = `${peerLabel(selectedConvo)} has left`
    logEl.appendChild(banner)
  }
  const c = getConvo(selectedConvo)
  for (const m of c.messages) {
    appendMessageEl(m)
  }
  logEl.scrollTop = logEl.scrollHeight
}

function appendMessageEl(m) {
  if (m.kind === 'sys') {
    const el = document.createElement('div')
    el.className = 'sys'
    el.textContent = m.text
    logEl.appendChild(el)
    m.bubbleEl = el
    return
  }
  const row = document.createElement('div')
  row.className = `msg ${m.kind === 'out' ? 'me' : 'peer'}`
  if (m.kind === 'in' && m.label) {
    const label = document.createElement('div')
    label.className = 'label'
    label.textContent = m.label
    row.appendChild(label)
  }
  const bubble = document.createElement('div')
  let cls = 'bubble'
  if (m.status === 'pending') cls += ' pending'
  if (m.status === 'failed') cls += ' failed'
  bubble.className = cls
  bubble.textContent = m.text
  row.appendChild(bubble)
  logEl.appendChild(row)
  m.bubbleEl = bubble
}

function appendToOpenLog(m) {
  appendMessageEl(m)
  logEl.scrollTop = logEl.scrollHeight
}

function selectConvo(key) {
  selectedConvo = key
  const c = getConvo(key)
  c.unread = 0
  const composable = key === BULLETIN || roster.has(key)
  msgInput.disabled = !composable
  sendBtn.disabled = !composable
  msgInput.placeholder = composable
    ? key === BULLETIN ? 'post to the bulletin' : `message ${peerLabel(key)}`
    : `${peerLabel(key)} is offline`
  renderRoster()
  renderLog()
  if (!msgInput.disabled) msgInput.focus()
}

// ------- transport -------

async function sendServer(obj) {
  if (!stream) throw new Error('not connected')
  const bytes = fromString(JSON.stringify(obj) + '\n')
  if (!stream.send(bytes)) {
    await stream.onDrain()
  }
}

function handleIncomingChunk(chunk) {
  readBuf += toString(chunk.subarray ? chunk.subarray() : chunk)
  let idx
  while ((idx = readBuf.indexOf('\n')) !== -1) {
    const line = readBuf.slice(0, idx)
    readBuf = readBuf.slice(idx + 1)
    if (!line) continue
    let obj
    try { obj = JSON.parse(line) } catch { continue }
    handleServerMessage(obj).catch(err => console.error('server msg:', err))
  }
}

async function handleServerMessage(obj) {
  if (obj.type === 'roster' && Array.isArray(obj.peers)) {
    const next = new Map()
    for (const p of obj.peers) {
      if (
        typeof p?.peerId !== 'string' ||
        typeof p?.dmPublicKey !== 'string' ||
        typeof p?.dmSignature !== 'string'
      ) continue
      if (p.peerId === myPeerId) {
        // trust our own entry; no need to verify against our own key
        next.set(p.peerId, { peerId: p.peerId, dmPublicKey: p.dmPublicKey, name: typeof p.name === 'string' && p.name ? p.name : shortId(p.peerId) })
        continue
      }
      let ok = false
      try {
        const peerIdObj = peerIdFromString(p.peerId)
        const pubKey = peerIdObj.publicKey
        if (!pubKey) throw new Error('peer id has no embedded public key')
        const rawDmPub = b64dec(p.dmPublicKey)
        const sig = b64dec(p.dmSignature)
        ok = await pubKey.verify(dmSignPayload(rawDmPub), sig)
      } catch (err) {
        console.warn(`rejecting peer ${p.peerId}: ${err.message}`)
        continue
      }
      if (!ok) {
        console.warn(`rejecting peer ${p.peerId}: DM key signature did not match libp2p identity`)
        continue
      }
      const prev = roster.get(p.peerId)
      if (prev && prev.dmPublicKey !== p.dmPublicKey) sharedKeyCache.delete(p.peerId)
      next.set(p.peerId, { peerId: p.peerId, dmPublicKey: p.dmPublicKey, name: typeof p.name === 'string' && p.name ? p.name : shortId(p.peerId) })
    }
    roster.clear()
    for (const [k, v] of next) roster.set(k, v)
    if (selectedConvo !== BULLETIN) {
      const online = roster.has(selectedConvo)
      msgInput.disabled = !online
      sendBtn.disabled = !online
      msgInput.placeholder = online
        ? `message ${peerLabel(selectedConvo)}`
        : `${peerLabel(selectedConvo)} is offline`
    }
    renderRoster()
    renderLog()
  } else if (obj.type === 'bulletin' && typeof obj.from === 'string' && typeof obj.text === 'string') {
    const c = getConvo(BULLETIN)
    const msg = { kind: 'in', text: obj.text, label: peerLabel(obj.from) }
    c.messages.push(msg)
    if (selectedConvo === BULLETIN) appendToOpenLog(msg)
    else { c.unread += 1; renderRoster() }
  } else if (obj.type === 'dm' && typeof obj.from === 'string') {
    try {
      const text = await decryptFrom(obj.from, obj.iv, obj.ciphertext)
      const c = getConvo(obj.from)
      const msg = { kind: 'in', text, label: peerLabel(obj.from) }
      c.messages.push(msg)
      if (selectedConvo === obj.from) appendToOpenLog(msg)
      else { c.unread += 1; renderRoster() }
    } catch (err) {
      const c = getConvo(obj.from)
      const msg = { kind: 'sys', text: `[decrypt failed from ${peerLabel(obj.from)}: ${err.message}]` }
      c.messages.push(msg)
      if (selectedConvo === obj.from) appendToOpenLog(msg)
      else { c.unread += 1; renderRoster() }
    }
  } else if (obj.type === 'ack' && typeof obj.id === 'number') {
    markDeliveryStatus(obj.id, 'acked')
  } else if (obj.type === 'dm-fail' && typeof obj.id === 'number') {
    markDeliveryStatus(obj.id, 'failed')
  }
}

function markDeliveryStatus(id, status) {
  for (const c of conversations.values()) {
    const msg = c.messages.find(m => m.id === id)
    if (!msg) continue
    msg.status = status
    if (msg.bubbleEl) {
      msg.bubbleEl.classList.remove('pending')
      if (status === 'failed') msg.bubbleEl.classList.add('failed')
    }
    return
  }
}

// ------- lifecycle -------

async function connect() {
  const value = addrInput.value.trim()
  if (!value) return
  let ma
  try { ma = multiaddr(value) } catch (err) {
    setStatus('err', `bad multiaddr: ${err.message}`)
    return
  }
  myName = nameInput.value.trim() || randomName()
  nameInput.value = myName
  localStorage.setItem('server-multiaddr', value)
  setStatus('working', 'starting libp2p...')

  try {
    identityKey = await generateKeyPair('Ed25519')
    await generateDmKeyPair()
    node = await createLibp2p({
      privateKey: identityKey,
      transports: [webRTCDirect()],
      connectionGater: { denyDialMultiaddr: () => false }
    })
    await node.start()
    myPeerId = node.peerId.toString()
    myPeerEl.textContent = `you: ${shortId(myPeerId)}`

    setStatus('working', 'dialing...')
    stream = await node.dialProtocol(ma, CHAT_PROTO, {
      signal: AbortSignal.timeout(15000)
    })

    readBuf = ''
    stream.addEventListener('message', (event) => handleIncomingChunk(event.data))
    stream.addEventListener('close', () => {
      setStatus('', 'disconnected')
      cleanup()
    })

    const remotePeer = ma.getComponents().find(c => c.name === 'p2p')?.value
    setStatus('ok', `connected · ${shortId(remotePeer ?? '')}`)
    setConnected(true)
    selectedConvo = BULLETIN
    renderRoster()
    renderLog()
    selectConvo(BULLETIN)

    await sendServer({
      type: 'hello',
      dmPublicKey: dmPublicKeyB64,
      dmSignature: dmSignatureB64,
      name: myName
    })
  } catch (err) {
    setStatus('err', `connect failed: ${err.message}`)
    await cleanup()
  }
}

async function disconnect() {
  await cleanup()
  setStatus('', 'idle')
}

async function cleanup() {
  if (stream) { try { await stream.close() } catch {} stream = null }
  if (node) { try { await node.stop() } catch {} node = null }
  roster.clear()
  conversations.clear()
  sharedKeyCache.clear()
  identityKey = null
  dmKeyPair = null
  dmPublicKeyB64 = null
  dmSignatureB64 = null
  myPeerId = null
  myName = ''
  myPeerEl.textContent = ''
  setConnected(false)
  renderRoster()
  renderLog()
}

async function sendMsg() {
  const text = msgInput.value.trim()
  if (!text || !stream) return
  msgInput.value = ''

  if (selectedConvo === BULLETIN) {
    const id = nextOutgoingId++
    const c = getConvo(BULLETIN)
    const msg = { kind: 'out', text, status: 'pending', id }
    c.messages.push(msg)
    appendToOpenLog(msg)
    try {
      await sendServer({ type: 'bulletin', text, id })
    } catch (err) {
      msg.status = 'failed'
      if (msg.bubbleEl) { msg.bubbleEl.classList.remove('pending'); msg.bubbleEl.classList.add('failed') }
    }
    return
  }

  if (!roster.has(selectedConvo)) return
  const id = nextOutgoingId++
  const c = getConvo(selectedConvo)
  const msg = { kind: 'out', text, status: 'pending', id }
  c.messages.push(msg)
  appendToOpenLog(msg)
  try {
    const { iv, ciphertext } = await encryptFor(selectedConvo, text)
    await sendServer({ type: 'dm', to: selectedConvo, iv, ciphertext, id })
  } catch (err) {
    msg.status = 'failed'
    if (msg.bubbleEl) { msg.bubbleEl.classList.remove('pending'); msg.bubbleEl.classList.add('failed') }
  }
}

// ------- routing -------

function showApp() {
  landingView.hidden = true
  appView.hidden = false
  statusEl.hidden = false
  titleEl.classList.add('clickable')
  addrInput.focus()
  renderRoster()
  renderLog()
}

async function showLanding() {
  await cleanup()
  appView.hidden = true
  landingView.hidden = false
  statusEl.hidden = true
  titleEl.classList.remove('clickable')
  setStatus('', 'idle')
}

tryItBtn.addEventListener('click', showApp)
titleEl.addEventListener('click', () => {
  if (titleEl.classList.contains('clickable')) showLanding()
})
connectBtn.addEventListener('click', connect)
disconnectBtn.addEventListener('click', disconnect)
composeForm.addEventListener('submit', (e) => { e.preventDefault(); sendMsg() })
addrInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !connectBtn.disabled) connect()
})
nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !connectBtn.disabled) connect()
})

setStatus('', 'idle')
renderRoster()
renderLog()
