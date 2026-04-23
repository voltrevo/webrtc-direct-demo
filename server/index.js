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
const RPC_PROTO = '/eth-rpc/1.0.0'
const RPC_MAX_BUF = 1 << 20 // 1 MB per stream direction
const RPC_UPSTREAM_TIMEOUT_MS = 3_000
const STATE_PATH = process.env.STATE_FILE ?? './state.json'
const CERT_DAYS = 200 * 365
const MS_PER_DAY = 86400000

// Curated free public JSON-RPC endpoints, mirrored from
// https://github.com/voltrevo/keynet/blob/main/src/meta-rpc-server.ts
const RPC_UPSTREAMS = {
  ethereum: [
    'https://ethereum-rpc.publicnode.com',
    'https://eth.drpc.org',
    'https://ethereum.publicnode.com',
    'https://endpoints.omniatech.io/v1/eth/mainnet/public',
    'https://1rpc.io/eth'
  ],
  arbitrum: [
    'https://arb1.arbitrum.io/rpc',
    'https://arbitrum.drpc.org',
    'https://arbitrum-one.public.blastapi.io',
    'https://arbitrum.meowrpc.com',
    'https://arbitrum.public.blockpi.network/v1/rpc/public'
  ],
  optimism: [
    'https://optimism.public.blockpi.network/v1/rpc/public',
    'https://api.zan.top/opt-mainnet',
    'https://optimism-public.nodies.app',
    'https://optimism-rpc.publicnode.com',
    'https://1rpc.io/op'
  ],
  base: [
    'https://1rpc.io/base',
    'https://mainnet.base.org',
    'https://developer-access-mainnet.base.org',
    'https://base-public.nodies.app',
    'https://base.public.blockpi.network/v1/rpc/public'
  ],
  polygon: [
    'https://1rpc.io/matic',
    'https://polygon.drpc.org',
    'https://polygon-public.nodies.app',
    'https://api.zan.top/polygon-mainnet',
    'https://polygon-bor-rpc.publicnode.com'
  ]
}

const CHAIN_ID_TO_NETWORK = { '1': 'ethereum', '42161': 'arbitrum', '10': 'optimism', '8453': 'base', '137': 'polygon' }
const NETWORK_ALIASES = { eth: 'ethereum', arb: 'arbitrum', op: 'optimism', poly: 'polygon', matic: 'polygon' }

function resolveNetwork(input) {
  const lower = String(input ?? '').toLowerCase()
  if (Object.prototype.hasOwnProperty.call(RPC_UPSTREAMS, lower)) return lower
  if (Object.prototype.hasOwnProperty.call(NETWORK_ALIASES, lower)) return NETWORK_ALIASES[lower]
  if (Object.prototype.hasOwnProperty.call(CHAIN_ID_TO_NETWORK, lower)) return CHAIN_ID_TO_NETWORK[lower]
  return null
}

function randomUpstream(network) {
  const list = RPC_UPSTREAMS[network]
  return list[Math.floor(Math.random() * list.length)]
}

async function proxyRpc(network, jsonrpcReq, ctx = '') {
  const url = randomUpstream(network)
  const host = new URL(url).hostname
  const method = typeof jsonrpcReq?.method === 'string' ? jsonrpcReq.method : '?'
  const tag = ctx ? `[rpc ${ctx}]` : '[rpc]'
  const started = Date.now()
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(jsonrpcReq),
      signal: AbortSignal.timeout(RPC_UPSTREAM_TIMEOUT_MS)
    })
    const elapsed = Date.now() - started
    console.log(`${tag} ${network} ${method} → ${host} ${res.status} (${elapsed}ms)`)
    if (!res.ok) {
      throw new Error(`upstream ${url} returned ${res.status}`)
    }
    return await res.json()
  } catch (err) {
    const elapsed = Date.now() - started
    console.log(`${tag} ${network} ${method} → ${host} FAIL (${elapsed}ms): ${err.message}`)
    throw err
  }
}

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

/**
 * @typedef {{
 *   stream: import('@libp2p/interface').Stream,
 *   dmPublicKey: string | null,
 *   dmSignature: string | null,
 *   name: string | null,
 *   shortId: string
 * }} PeerEntry
 */
/** @type {Map<string, PeerEntry>} */
const peers = new Map()

function sanitizeName(n) {
  if (typeof n !== 'string') return null
  const trimmed = n.trim().slice(0, 40)
  return trimmed || null
}

async function sendObj(stream, obj) {
  const bytes = fromString(JSON.stringify(obj) + '\n')
  if (!stream.send(bytes)) {
    await stream.onDrain()
  }
}

function rosterSnapshot() {
  return Array.from(peers.entries())
    .filter(([, p]) => p.dmPublicKey != null && p.dmSignature != null)
    .map(([peerId, p]) => ({
      peerId,
      dmPublicKey: p.dmPublicKey,
      dmSignature: p.dmSignature,
      name: p.name ?? p.shortId
    }))
}

function logRoster() {
  const ready = [...peers.values()].filter(p => p.dmPublicKey != null)
  const labels = ready.map(p => `${p.name ?? p.shortId}(${p.shortId})`).join(', ')
  console.log(`[roster] ${ready.length} peer(s): ${labels || '(none)'}`)
}

async function broadcastRoster() {
  const msg = { type: 'roster', peers: rosterSnapshot() }
  const ready = [...peers.values()].filter(p => p.dmPublicKey != null)
  await Promise.allSettled(
    ready.map(p => sendObj(p.stream, msg).catch(() => {}))
  )
}

async function forward(targetPeerId, msg) {
  const target = peers.get(targetPeerId)
  if (!target?.dmPublicKey) return false
  try {
    await sendObj(target.stream, msg)
    return true
  } catch {
    return false
  }
}

await node.handle(CHAT_PROTO, async (stream, connection) => {
  const remote = connection.remotePeer.toString()
  const shortId = remote.slice(-8)
  console.log(`[+] peer connected: ${remote}`)
  const entry = { stream, dmPublicKey: null, dmSignature: null, name: null, shortId }
  peers.set(remote, entry)

  let buf = ''
  stream.addEventListener('message', async (event) => {
    buf += toString(event.data.subarray ? event.data.subarray() : event.data)
    let idx
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx)
      buf = buf.slice(idx + 1)
      if (!line) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }

      if (
        msg.type === 'hello' &&
        typeof msg.dmPublicKey === 'string' &&
        typeof msg.dmSignature === 'string' &&
        entry.dmPublicKey == null
      ) {
        entry.dmPublicKey = msg.dmPublicKey
        entry.dmSignature = msg.dmSignature
        entry.name = sanitizeName(msg.name)
        logRoster()
        broadcastRoster().catch(err => console.error(`roster: ${err.message}`))
      } else if (
        msg.type === 'dm' &&
        typeof msg.to === 'string' &&
        typeof msg.iv === 'string' &&
        typeof msg.ciphertext === 'string'
      ) {
        const delivered = await forward(msg.to, {
          type: 'dm',
          from: remote,
          iv: msg.iv,
          ciphertext: msg.ciphertext
        })
        const reply = delivered
          ? { type: 'ack', id: msg.id }
          : { type: 'dm-fail', id: msg.id, reason: 'peer unreachable' }
        await sendObj(stream, reply).catch(() => {})
      } else if (
        msg.type === 'bulletin' &&
        typeof msg.text === 'string' &&
        msg.text.length > 0
      ) {
        const out = { type: 'bulletin', from: remote, text: msg.text.slice(0, 4000) }
        const targets = [...peers.entries()]
          .filter(([id, p]) => id !== remote && p.dmPublicKey != null)
        await Promise.allSettled(
          targets.map(([, p]) => sendObj(p.stream, out).catch(() => {}))
        )
        await sendObj(stream, { type: 'ack', id: msg.id }).catch(() => {})
      }
    }
  })

  stream.addEventListener('close', () => {
    console.log(`[-] peer disconnected: ${remote}`)
    peers.delete(remote)
    logRoster()
    broadcastRoster().catch(err => console.error(`roster: ${err.message}`))
  })
})

await node.handle(RPC_PROTO, async (stream, connection) => {
  const remote = connection.remotePeer.toString()
  const shortId = remote.slice(-8)
  console.log(`[rpc+] ${shortId}`)

  let buf = ''
  let closed = false

  async function handleLine(line) {
    let env
    try { env = JSON.parse(line) } catch {
      return sendObj(stream, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }).catch(() => {})
    }
    const id = env?.req?.id ?? null
    try {
      const network = resolveNetwork(env.network)
      if (!network) throw new Error(`unknown network: ${env.network}`)
      if (typeof env.req !== 'object' || env.req === null) throw new Error('missing req object')
      const response = await proxyRpc(network, env.req, shortId)
      // response already has jsonrpc/id/result|error from upstream
      await sendObj(stream, response)
    } catch (err) {
      await sendObj(stream, {
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: 'proxy error', data: err.message }
      }).catch(() => {})
    }
  }

  stream.addEventListener('message', (event) => {
    if (closed) return
    buf += toString(event.data.subarray ? event.data.subarray() : event.data)
    if (buf.length > RPC_MAX_BUF) {
      console.warn(`[rpc] ${shortId}: inbound buffer overflow, closing stream`)
      closed = true
      stream.close().catch(() => {})
      return
    }
    let idx
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx)
      buf = buf.slice(idx + 1)
      if (!line) continue
      handleLine(line).catch((err) => console.error(`[rpc] ${shortId} handleLine: ${err.message}`))
    }
  })

  stream.addEventListener('close', () => {
    closed = true
    console.log(`[rpc-] ${shortId}`)
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
