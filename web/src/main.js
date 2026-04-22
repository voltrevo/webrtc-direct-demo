import { createLibp2p } from 'libp2p'
import { webRTCDirect } from '@libp2p/webrtc'
import { multiaddr } from '@multiformats/multiaddr'
import { fromString, toString } from 'uint8arrays'

const CHAT_PROTO = '/chat/1.0.0'

const $ = (id) => document.getElementById(id)
const addrInput = $('addr')
const connectBtn = $('connect')
const disconnectBtn = $('disconnect')
const statusEl = $('status')
const statusDot = $('status-dot')
const statusText = $('status-text')
const myPeerEl = $('my-peer')
const logEl = $('log')
const msgInput = $('msg')
const sendBtn = $('send')
const composeForm = $('compose')
const landingView = $('landing')
const appView = $('app')
const tryItBtn = $('try-it')
const titleEl = $('title')

let node = null
let stream = null
let readBuf = ''
const pendingAcks = []

const savedAddr = localStorage.getItem('server-multiaddr')
if (savedAddr) addrInput.value = savedAddr

function setStatus(kind, text) {
  statusDot.className = `dot${kind ? ` ${kind}` : ''}`
  statusText.textContent = text
}

function setConnected(connected) {
  connectBtn.disabled = connected
  disconnectBtn.disabled = !connected
  msgInput.disabled = !connected
  sendBtn.disabled = !connected
  addrInput.disabled = connected
  msgInput.placeholder = connected ? 'type a message' : 'connect to start chatting'
  if (connected) {
    msgInput.focus()
  }
}

function scrollIfPinned(fn) {
  const threshold = 40
  const atBottom =
    logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < threshold
  fn()
  if (atBottom) logEl.scrollTop = logEl.scrollHeight
}

function addSystem(text, kind = '') {
  scrollIfPinned(() => {
    const el = document.createElement('div')
    el.className = `sys${kind ? ` ${kind}` : ''}`
    el.textContent = text
    logEl.appendChild(el)
  })
}

function addMeMessage(text) {
  scrollIfPinned(() => {
    const row = document.createElement('div')
    row.className = 'msg me'

    const bubble = document.createElement('div')
    bubble.className = 'bubble pending'
    bubble.textContent = text
    row.appendChild(bubble)

    pendingAcks.push(bubble)
    logEl.appendChild(row)
  })
}

function addPeerMessage(fromId, text) {
  scrollIfPinned(() => {
    const row = document.createElement('div')
    row.className = 'msg peer'

    const label = document.createElement('div')
    label.className = 'label'
    label.textContent = shortId(fromId)
    row.appendChild(label)

    const bubble = document.createElement('div')
    bubble.className = 'bubble'
    bubble.textContent = text
    row.appendChild(bubble)

    logEl.appendChild(row)
  })
}

function markAck() {
  const bubble = pendingAcks.shift()
  if (!bubble) return
  bubble.classList.remove('pending')
}

function failPendingAcks() {
  pendingAcks.length = 0
}

function shortId(id) {
  if (typeof id !== 'string') return '?'
  return id.length > 10 ? `...${id.slice(-8)}` : id
}

function handleIncomingChunk(chunk) {
  readBuf += toString(chunk.subarray ? chunk.subarray() : chunk)
  let idx
  while ((idx = readBuf.indexOf('\n')) !== -1) {
    const line = readBuf.slice(0, idx)
    readBuf = readBuf.slice(idx + 1)
    if (!line) continue
    try {
      handleMessage(JSON.parse(line))
    } catch (err) {
      addSystem(`bad json from server: ${err.message}`, 'err')
    }
  }
}

function handleMessage(obj) {
  if (obj.type === 'ack') {
    markAck()
  } else if (obj.type === 'msg') {
    addPeerMessage(obj.from, obj.text ?? '')
  } else {
    addSystem(`unknown message: ${JSON.stringify(obj)}`)
  }
}

async function sendObj(obj) {
  if (!stream) return
  const bytes = fromString(JSON.stringify(obj) + '\n')
  if (!stream.send(bytes)) {
    await stream.onDrain()
  }
}

async function connect() {
  const value = addrInput.value.trim()
  if (!value) {
    addSystem('enter a multiaddr first', 'err')
    return
  }

  let ma
  try {
    ma = multiaddr(value)
  } catch (err) {
    addSystem(`bad multiaddr: ${err.message}`, 'err')
    return
  }

  localStorage.setItem('server-multiaddr', value)
  setStatus('working', 'starting libp2p...')

  try {
    node = await createLibp2p({
      transports: [webRTCDirect()],
      connectionGater: { denyDialMultiaddr: () => false }
    })
    await node.start()

    myPeerEl.textContent = `you: ${shortId(node.peerId.toString())}`

    setStatus('working', 'dialing...')
    stream = await node.dialProtocol(ma, CHAT_PROTO, {
      signal: AbortSignal.timeout(15000)
    })

    const remotePeer = ma.getComponents().find(c => c.name === 'p2p')?.value
    setStatus('ok', `connected · ${shortId(remotePeer ?? '')}`)
    addSystem(`connected to ${shortId(remotePeer ?? 'peer')}`)
    setConnected(true)

    readBuf = ''
    stream.addEventListener('message', (event) => handleIncomingChunk(event.data))
    stream.addEventListener('close', () => {
      addSystem('stream closed')
      cleanup()
    })
  } catch (err) {
    addSystem(`connect failed: ${err.message}`, 'err')
    setStatus('err', 'error')
    await cleanup()
  }
}

async function disconnect() {
  await cleanup()
  addSystem('disconnected')
  setStatus('', 'idle')
}

async function cleanup() {
  failPendingAcks()
  readBuf = ''
  if (stream) {
    try { await stream.close() } catch {}
    stream = null
  }
  if (node) {
    try { await node.stop() } catch {}
    node = null
  }
  myPeerEl.textContent = ''
  setConnected(false)
}

async function send() {
  const text = msgInput.value.trim()
  if (!text || !stream) return
  addMeMessage(text)
  msgInput.value = ''
  try {
    await sendObj({ text })
  } catch (err) {
    addSystem(`send failed: ${err.message}`, 'err')
  }
}

function showApp() {
  landingView.hidden = true
  appView.hidden = false
  statusEl.hidden = false
  titleEl.classList.add('clickable')
  addrInput.focus()
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
composeForm.addEventListener('submit', (e) => {
  e.preventDefault()
  send()
})
addrInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !connectBtn.disabled) connect()
})

setStatus('', 'idle')
