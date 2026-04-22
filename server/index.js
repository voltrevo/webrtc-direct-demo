import { createLibp2p } from 'libp2p'
import { webRTCDirect } from '@libp2p/webrtc'
import {
  generateKeyPair,
  privateKeyFromProtobuf,
  privateKeyToProtobuf
} from '@libp2p/crypto/keys'
import {
  BasicConstraintsExtension,
  X509CertificateGenerator,
  cryptoProvider
} from '@peculiar/x509'
import { Crypto } from '@peculiar/webcrypto'
import { base64url } from 'multiformats/bases/base64'
import { sha256 } from 'multiformats/hashes/sha2'
import { fromString, toString } from 'uint8arrays'
import { readFile, writeFile } from 'node:fs/promises'

const crypto = new Crypto()
cryptoProvider.set(crypto)

const CHAT_PROTO = '/chat/1.0.0'
const STATE_PATH = process.env.STATE_FILE ?? './state.json'
const CERT_DAYS = 200 * 365
const MS_PER_DAY = 86400000

async function generateTlsCertificate(days) {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  )
  const notBefore = new Date()
  notBefore.setMilliseconds(0)
  const notAfter = new Date(notBefore.getTime() + days * MS_PER_DAY)
  notAfter.setMilliseconds(0)
  const cert = await X509CertificateGenerator.createSelfSigned({
    serialNumber: (BigInt(Math.random().toString().replace('.', '')) * 100000n).toString(16),
    name: 'CN=webrtc-direct-demo, O=demo',
    notBefore,
    notAfter,
    keys: keyPair,
    extensions: [new BasicConstraintsExtension(false, undefined, true)]
  })
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey))
  const b64 = Buffer.from(pkcs8).toString('base64').match(/.{1,64}/g).join('\n')
  const privateKeyPem = `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----`
  const certhash = base64url.encode((await sha256.digest(new Uint8Array(cert.rawData))).bytes)
  return {
    privateKey: privateKeyPem,
    pem: cert.toString('pem'),
    certhash
  }
}

async function loadState(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

async function saveState(path, state) {
  await writeFile(path, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
}

function extractUdpPort(ma) {
  const comp = ma.getComponents().find(c => c.name === 'udp')
  return comp?.value ? Number(comp.value) : null
}

const explicitListen = process.env.LISTEN
const existing = explicitListen ? null : await loadState(STATE_PATH)

let privateKey
let certificate
if (existing) {
  privateKey = privateKeyFromProtobuf(fromString(existing.privateKey, 'base64'))
  certificate = existing.tls
} else {
  privateKey = await generateKeyPair('Ed25519')
  certificate = await generateTlsCertificate(CERT_DAYS)
}

const listenPort = existing?.port ?? 0
const listenAddr = explicitListen ?? `/ip4/0.0.0.0/udp/${listenPort}/webrtc-direct`

const node = await createLibp2p({
  privateKey,
  addresses: { listen: [listenAddr] },
  transports: [webRTCDirect({ certificate, rtcConfiguration: { iceServers: [] } })]
})

if (!explicitListen && existing == null) {
  const boundPort = extractUdpPort(node.getMultiaddrs()[0])
  await saveState(STATE_PATH, {
    privateKey: toString(privateKeyToProtobuf(privateKey), 'base64'),
    port: boundPort,
    tls: certificate
  })
  console.log(`saved state to ${STATE_PATH}; future starts will reuse this identity, port, and cert`)
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
  process.exit(0)
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
