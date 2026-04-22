# webrtc-direct-demo

A tiny chat room that uses **libp2p's WebRTC Direct transport** so the browser
can dial a server over raw UDP — no signalling server, no STUN/TURN, no
pre-trusted TLS certificate. The server's self-signed cert is pinned by a
`certhash` component inside its multiaddr.

- `server/` — Bun + `js-libp2p` host exposing a `/chat/1.0.0` stream handler.
  Broadcasts each message to every other connected peer, and acks the sender.
- `server-go/` — the same protocol implemented with `go-libp2p`. Kept around
  for cross-implementation debugging; either server works with the browser
  client. Note: go-libp2p's webrtc transport regenerates its TLS cert on
  every start, so the `/certhash/...` component changes per run.
- `web/` — Vite + `js-libp2p` static app. You paste the server's multiaddr,
  click Connect, and chat.
- `.github/workflows/pages.yml` — builds `web/` and publishes to GitHub Pages.

## Run the server

Needs Node.js 22+. `bun install` is fine for installing deps (faster), but run
the server itself under Node — Bun's event loop currently doesn't drive the
native `node-datachannel` UDP socket, so the listener stays silent.

```sh
cd server
npm install          # or: bun install
npm start            # runs: node index.js
```

On first run the server generates:

- a libp2p Ed25519 peer key
- a self-signed WebRTC TLS cert (200-year lifespan so `certhash` is
  effectively permanent)
- a free UDP port

and writes all three into a single file, `./state.json`. Subsequent
starts load from that file, so the full multiaddr — IP, port, certhash,
peer ID — stays byte-identical across restarts. If the saved port is
already in use on a later start, the server fails loudly rather than
silently picking a new one (which would break the saved multiaddr).

Override with the `LISTEN` env var if you want to pick a specific port
yourself or listen on multiple addresses.

Output looks like:

```
listening; dial one of these multiaddrs from the browser:
  /ip4/127.0.0.1/udp/41108/webrtc-direct/certhash/uEi.../p2p/12D3Koo...
  /ip4/192.168.1.50/udp/41108/webrtc-direct/certhash/uEi.../p2p/12D3Koo...
```

Pick the one the browser can reach:

- **Same machine as the server** → the `127.0.0.1` line.
- **Another device on the LAN** → the LAN IP line.
- **Over the internet** → run on a public IP (or port-forward the UDP port).

### Env vars

```
LISTEN        listen multiaddr  (override; suppresses state.json port handling)
STATE_FILE    persisted state path     (default: ./state.json)
```

### Go server (alternative)

Needs Go 1.24+. Same protocol, useful for cross-impl debugging:

```sh
cd server-go
go run . -listen /ip4/0.0.0.0/udp/41234/webrtc-direct
```

Flags: `-key identity.key`, `-listen /ip4/0.0.0.0/udp/0/webrtc-direct`.

## Run the web app locally

```sh
cd web
npm install
npm run dev
```

Open the printed URL, paste a multiaddr from the server, click Connect.

## Deploying the web app to GitHub Pages

1. Push this repo to GitHub.
2. In the repo, open **Settings → Pages** and set **Source** to
   **GitHub Actions**.
3. The workflow in `.github/workflows/pages.yml` builds `web/` and publishes
   on every push to `main` that changes `web/**`. Trigger the first run by
   pushing, or via **Actions → Deploy web app to GitHub Pages → Run
   workflow**.

The web app uses `base: './'` in `vite.config.js`, so it works at any
repo-subpath URL.

## Why this avoids a signalling server

Classic browser WebRTC needs an out-of-band channel to exchange SDP
offer/answer and ICE candidates. **WebRTC Direct** sidesteps that:

- The server generates a self-signed TLS cert and hashes it into the listen
  multiaddr (`/certhash/uEi...`).
- The browser has the multiaddr (you paste it), so it already knows the
  server's address, port, and exact cert fingerprint.
- The browser sends a DTLS `ClientHello` straight at that UDP endpoint; no
  SDP round-trip needed because both sides agree on the handshake parameters
  up front. Noise XX inside the first data channel authenticates the libp2p
  peer ID.

So the only "signalling" here is you copying one line of text out of the
server's stdout.
