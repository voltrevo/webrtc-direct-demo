# webrtc-direct-demo

**[Try it →](https://voltrevo.github.io/webrtc-direct-demo/#demo)**

## Connection Freedom in the Browser

Browser vendors migrated the web from http to https in the mid-2010s.
That 's' adds encryption via TLS, which is great.

However, https also adds:

1. You must use a domain controlled by a domain registrar.
2. You must present a certificate signed by a certificate authority.

WebRTC Direct restores the freedom to talk to cryptographic
identities instead of just those with authority-controlled names.

## The workaround

- WebRTC is designed for p2p communication. The two ends can be
  browsers, so it can't require one side to have a domain and signed
  TLS certificate.
- However, WebRTC normally needs a signalling server to relay the SDP
  offer/answer and ICE candidates between the two ends. That server
  needs a domain and cert of its own — so the requirement just moves.
- WebRTC Direct is a client-server variant. The server listens on an
  IP and UDP port, and both sides *synthesize* the SDP from
  out-of-band info instead of exchanging it: the browser derives the
  server's answer from the multiaddr, and the server derives the
  browser's offer from the `ufrag` it sees in the incoming STUN
  request. No signalling.
- All comms stay end-to-end encrypted. The multiaddr pins two
  different keys: `/certhash/…` is the SHA-256 of the server's
  self-signed TLS cert (verified during DTLS, no CA required), and
  `/p2p/12D3Koo…` is the server's libp2p identity, proven via a Noise
  XX handshake inside the first data channel.

## What runs on top

The transport is the point; this demo bolts two example services onto
it, both speaking libp2p stream protocols.

- **Chat** (`/chat/1.0.0`) — a public bulletin plus end-to-end
  encrypted direct messages. Each client's DM key is signed by their
  libp2p identity, so the server can route messages but can't read or
  forge DMs.
- **Block explorer** (`/eth-rpc/1.0.0`) — the server proxies JSON-RPC
  calls to curated public endpoints for Ethereum, Arbitrum, Optimism,
  Base, and Polygon; the browser renders a small live explorer from
  the responses. The server sees your queries; the public RPC
  endpoints only see the server's IP.

## How the trust works

1. The server generates a fresh self-signed TLS certificate at
   startup.
2. It encodes the SHA-256 of that certificate into its multiaddr as
   `/certhash/...`, alongside its IP, UDP port, and libp2p peer ID.
3. You paste that multiaddr into the browser. The browser now knows
   the endpoint *and* the exact certificate fingerprint to expect.
4. The browser dials the IP and UDP port directly. It accepts the
   DTLS handshake only if the cert hashes to the pinned value. A
   Noise XX handshake on top then proves the libp2p peer ID.

No domain. No certificate authority. No signalling relay. If the
multiaddr reached you intact, the connection cannot be intercepted.

## Run your own server

Needs Node.js 22+. Clone this repo, then:

```sh
cd server
npm install
npm start
```

On first run the server generates a libp2p Ed25519 peer key, a
self-signed WebRTC TLS cert (200-year lifespan so `certhash` is
effectively permanent), and picks a free UDP port — all persisted to
`./state.json`. Subsequent starts reload that state, so the full
multiaddr (IP, port, certhash, peer ID) stays byte-identical across
restarts. If the saved port is already in use on a later start, the
server fails loudly rather than silently breaking the saved multiaddr.

Output looks like:

```
listening; dial one of these multiaddrs from the browser:
  /ip4/127.0.0.1/udp/41108/webrtc-direct/certhash/uEi.../p2p/12D3Koo...
  /ip4/192.168.1.50/udp/41108/webrtc-direct/certhash/uEi.../p2p/12D3Koo...
```

### Pick the right multiaddr

WebRTC Direct is just UDP underneath. The browser must be able to
reach the server's UDP port directly, so pick the address that
matches where you are:

- **Same machine** as the server — use the `127.0.0.1` line.
- **Same LAN** — use the LAN IP line (`192.168.x.x`, `10.x.x.x`).
- **Across the internet** — run the server on a public IP, or
  forward the UDP port printed in the multiaddr.

### Env vars

```
LISTEN      listen multiaddr  (override; suppresses state.json port handling)
STATE_FILE  persisted state path     (default: ./state.json)
```

## Run the web app locally

```sh
cd web
npm install
npm run dev
```

Open the printed URL, paste a multiaddr from the server, click
Connect.

## Browser extension — removing the last CA dependency

The web version of this demo is hosted on GitHub Pages. That page
still has to arrive over https, which still means a CA-signed cert
for a registered domain — the one authority-controlled link the
transport itself no longer needs.

Building the same app as a Chromium MV3 extension removes that last
dependency. The page loads from `chrome-extension://<id>/`, trusted
at install time rather than by a public CA. Neither the page nor its
connection to the server depends on a domain registrar or a
certificate authority.

```sh
cd web
npm run build:extension
```

Output lands in `web/dist-extension/`. Load it in Chrome via
**Extensions → Developer mode → Load unpacked** and point at that
folder. Clicking the toolbar icon opens the demo in a new tab. The
extension has no special host permissions and no CSP allow-list —
the WebRTC Direct dial is a raw UDP connection from the extension
page, which Chrome allows from any origin without declaration.

## Deploying the web app to GitHub Pages

1. Push this repo to GitHub.
2. In the repo, open **Settings → Pages** and set **Source** to
   **GitHub Actions**.
3. The workflow in [`.github/workflows/pages.yml`](.github/workflows/pages.yml)
   builds `web/` and publishes on every push to `main` that changes
   `web/**`.

The web app uses `base: './'` in `vite.config.js`, so it works at any
repo-subpath URL.

## Repository layout

- [`server/`](server/) — the Node + `js-libp2p` server: `/chat/1.0.0`
  handler, `/eth-rpc/1.0.0` JSON-RPC proxy, persistent state.
- [`web/`](web/) — the Vite + `js-libp2p` browser app (chat +
  explorer) published to GitHub Pages.
- [`.github/workflows/pages.yml`](.github/workflows/pages.yml) —
  builds and publishes `web/` on push.
