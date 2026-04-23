# server-go

A `go-libp2p` implementation of the chat protocol used by the
webrtc-direct-demo browser client. Dialing from the browser works.

## Known blocker: certhash is not stable across restarts

`go-libp2p`'s webrtc-direct transport generates its DTLS keypair and
self-signed TLS certificate *inside* `New()` (see
[`p2p/transport/webrtc/transport.go`](https://github.com/libp2p/go-libp2p/blob/master/p2p/transport/webrtc/transport.go)):

```go
pk, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
cert, err := webrtc.GenerateCertificate(pk)
config := webrtc.Configuration{
    Certificates: []webrtc.Certificate{*cert},
}
```

The resulting `webrtcConfig` is stored on an **unexported** field of
`WebRTCTransport`, and the only exported `Option` is
`WithListenerMaxInFlightConnections`. There is no `WithCertificate`
or any other hook to supply a pre-existing cert.

As a result, every restart produces a new cert → new `/certhash/…` →
new multiaddr. The peer ID (from the persisted Ed25519 key) does stay
stable, but the certhash does not, so users have to grab a fresh
multiaddr from stdout each time.

The `@libp2p/webrtc` TypeScript transport *does* expose a persistence
hook (via a datastore + keychain, and also via `init.certificate`), so
the JS server in [`../server/`](../server/) is what the web app
actually points at by default. This Go implementation is kept as a
cross-implementation reference and for dial-side compatibility
testing.

To close this gap upstream, one would add an option like
`WithCertificate(cert webrtc.Certificate) Option` that short-circuits
the generate-inside-`New()` block. Small patch; it hasn't been
contributed.

## Run

Needs Go 1.24+.

```sh
go run . -listen /ip4/0.0.0.0/udp/41234/webrtc-direct
```

Flags:

```
-key     path to persisted libp2p private key (default: identity.key)
-listen  listen multiaddr  (default: /ip4/0.0.0.0/udp/0/webrtc-direct)
```

The server prints its multiaddrs on startup. The peer ID stays stable
(backed by `identity.key`); the `/certhash/…` will change on every
run — see above.
