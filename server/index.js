import { createLibp2p } from 'libp2p'
import { webRTCDirect } from '@libp2p/webrtc'
import { keychain } from '@libp2p/keychain'
import {
  generateKeyPair,
  privateKeyFromProtobuf,
  privateKeyToProtobuf
} from '@libp2p/crypto/keys'
import { LevelDatastore } from 'datastore-level'
import { fromString, toString } from 'uint8arrays'
import { readFile, writeFile } from 'node:fs/promises'

const CHAT_PROTO = '/chat/1.0.0'
const DATASTORE_PATH = process.env.DATASTORE ?? './datastore'
const IDENTITY_PATH = process.env.IDENTITY ?? './identity.key'
const PORT_PATH = process.env.PORT_FILE ?? './port'

async function loadOrCreateIdentity(path) {
  try {
    const data = await readFile(path)
    return privateKeyFromProtobuf(new Uint8Array(data))
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
  const key = await generateKeyPair('Ed25519')
  await writeFile(path, privateKeyToProtobuf(key), { mode: 0o600 })
  return key
}

async function loadSavedPort(path) {
  try {
    const raw = (await readFile(path, 'utf8')).trim()
    const n = Number(raw)
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      throw new Error(`bad port in ${path}: ${JSON.stringify(raw)}`)
    }
    return n
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

function extractUdpPort(ma) {
  const comp = ma.getComponents().find(c => c.name === 'udp')
  return comp?.value ? Number(comp.value) : null
}

const privateKey = await loadOrCreateIdentity(IDENTITY_PATH)
const datastore = new LevelDatastore(DATASTORE_PATH)
await datastore.open()

const explicitListen = process.env.LISTEN
const savedPort = explicitListen ? null : await loadSavedPort(PORT_PATH)
const listenAddr =
  explicitListen ??
  `/ip4/0.0.0.0/udp/${savedPort ?? 0}/webrtc-direct`

const node = await createLibp2p({
  privateKey,
  datastore,
  addresses: { listen: [listenAddr] },
  transports: [webRTCDirect({ rtcConfiguration: { iceServers: [] } })],
  services: {
    keychain: keychain()
  }
})

if (!explicitListen && savedPort == null) {
  const boundPort = extractUdpPort(node.getMultiaddrs()[0])
  if (boundPort != null) {
    await writeFile(PORT_PATH, `${boundPort}\n`)
    console.log(`saved UDP port ${boundPort} to ${PORT_PATH}; future starts will reuse it`)
  }
}

/** @type {Map<string, import('@libp2p/interface').Stream>} */
const peers = new Map()

async function sendObj(stream, obj) {
  const bytes = fromString(JSON.stringify(obj) + '\n')
  if (!stream.send(bytes)) {
    await stream.onDrain()
  }
}

function addPeer(id, stream) {
  const existing = peers.get(id)
  if (existing) {
    try { existing.close() } catch {}
  }
  peers.set(id, stream)
}

function removePeer(id, stream) {
  if (peers.get(id) === stream) peers.delete(id)
}

async function broadcast(from, text) {
  const targets = []
  for (const [id, s] of peers) {
    if (id === from) continue
    targets.push([id, s])
  }
  await Promise.allSettled(
    targets.map(async ([id, s]) => {
      try {
        await sendObj(s, { type: 'msg', from, text })
      } catch (err) {
        console.error(`broadcast to ${id}: ${err.message}`)
      }
    })
  )
}

await node.handle(CHAT_PROTO, async (stream, connection) => {
  const remote = connection.remotePeer.toString()
  console.log(`[+] peer connected: ${remote}`)
  addPeer(remote, stream)

  let buf = ''

  stream.addEventListener('message', async (event) => {
    const chunk = event.data
    buf += toString(chunk.subarray ? chunk.subarray() : chunk)
    let idx
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx)
      buf = buf.slice(idx + 1)
      if (!line) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch (err) {
        console.error(`bad json from ${remote}: ${err.message}`)
        continue
      }
      if (typeof msg.text !== 'string' || !msg.text) continue
      try {
        await sendObj(stream, { type: 'ack' })
      } catch (err) {
        console.error(`ack to ${remote}: ${err.message}`)
      }
      broadcast(remote, msg.text).catch((err) => console.error(`broadcast: ${err.message}`))
    }
  })

  stream.addEventListener('close', () => {
    console.log(`[-] peer disconnected: ${remote}`)
    removePeer(remote, stream)
  })
})

console.log('listening; dial one of these multiaddrs from the browser:')
for (const addr of node.getMultiaddrs()) {
  console.log(`  ${addr.toString()}`)
}

async function shutdown(signal) {
  console.log(`\nreceived ${signal}, shutting down`)
  try { await node.stop() } catch {}
  try { await datastore.close() } catch {}
  process.exit(0)
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
