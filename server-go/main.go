package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"os/signal"
	"sync"
	"syscall"

	"github.com/libp2p/go-libp2p"
	"github.com/libp2p/go-libp2p/core/crypto"
	"github.com/libp2p/go-libp2p/core/host"
	"github.com/libp2p/go-libp2p/core/network"
	"github.com/libp2p/go-libp2p/core/peer"
	"github.com/libp2p/go-libp2p/core/protocol"
	ma "github.com/multiformats/go-multiaddr"
)

const chatProto = protocol.ID("/chat/1.0.0")

type inbound struct {
	Text string `json:"text"`
}

type outbound struct {
	Type string `json:"type"`
	From string `json:"from,omitempty"`
	Text string `json:"text,omitempty"`
}

type chatServer struct {
	host host.Host

	mu    sync.RWMutex
	peers map[peer.ID]*peerConn
}

type peerConn struct {
	stream network.Stream
	writer *bufio.Writer
	mu     sync.Mutex
}

func (p *peerConn) send(msg outbound) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	b, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	if _, err := p.writer.Write(append(b, '\n')); err != nil {
		return err
	}
	return p.writer.Flush()
}

func (s *chatServer) addPeer(id peer.ID, pc *peerConn) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if existing, ok := s.peers[id]; ok {
		_ = existing.stream.Close()
	}
	s.peers[id] = pc
}

func (s *chatServer) removePeer(id peer.ID, pc *peerConn) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if current, ok := s.peers[id]; ok && current == pc {
		delete(s.peers, id)
	}
}

func (s *chatServer) broadcast(from peer.ID, text string) {
	msg := outbound{Type: "msg", From: from.String(), Text: text}
	s.mu.RLock()
	targets := make([]*peerConn, 0, len(s.peers))
	for id, pc := range s.peers {
		if id == from {
			continue
		}
		targets = append(targets, pc)
	}
	s.mu.RUnlock()
	for _, pc := range targets {
		if err := pc.send(msg); err != nil {
			log.Printf("broadcast to %s: %v", pc.stream.Conn().RemotePeer(), err)
		}
	}
}

func (s *chatServer) handleStream(stream network.Stream) {
	remote := stream.Conn().RemotePeer()
	log.Printf("peer connected: %s", remote)

	pc := &peerConn{
		stream: stream,
		writer: bufio.NewWriter(stream),
	}
	s.addPeer(remote, pc)
	defer func() {
		s.removePeer(remote, pc)
		_ = stream.Close()
		log.Printf("peer disconnected: %s", remote)
	}()

	reader := bufio.NewReader(stream)
	for {
		line, err := reader.ReadBytes('\n')
		if len(line) > 0 {
			var msg inbound
			if jerr := json.Unmarshal(line[:len(line)-1], &msg); jerr != nil {
				log.Printf("bad json from %s: %v", remote, jerr)
				continue
			}
			if msg.Text == "" {
				continue
			}
			if err := pc.send(outbound{Type: "ack"}); err != nil {
				log.Printf("ack to %s: %v", remote, err)
			}
			s.broadcast(remote, msg.Text)
		}
		if err != nil {
			if !errors.Is(err, io.EOF) {
				log.Printf("read from %s: %v", remote, err)
			}
			return
		}
	}
}

func loadOrCreateKey(path string) (crypto.PrivKey, error) {
	if data, err := os.ReadFile(path); err == nil {
		return crypto.UnmarshalPrivateKey(data)
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	priv, _, err := crypto.GenerateEd25519Key(rand.Reader)
	if err != nil {
		return nil, err
	}
	data, err := crypto.MarshalPrivateKey(priv)
	if err != nil {
		return nil, err
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return nil, err
	}
	return priv, nil
}

func main() {
	keyPath := flag.String("key", "identity.key", "path to persisted libp2p private key")
	listen := flag.String("listen", "/ip4/0.0.0.0/udp/0/webrtc-direct", "multiaddr to listen on")
	flag.Parse()

	priv, err := loadOrCreateKey(*keyPath)
	if err != nil {
		log.Fatalf("identity: %v", err)
	}

	h, err := libp2p.New(
		libp2p.Identity(priv),
		libp2p.ListenAddrStrings(*listen),
	)
	if err != nil {
		log.Fatalf("libp2p: %v", err)
	}
	defer h.Close()

	s := &chatServer{host: h, peers: map[peer.ID]*peerConn{}}
	h.SetStreamHandler(chatProto, s.handleStream)

	p2pComp, err := ma.NewComponent("p2p", h.ID().String())
	if err != nil {
		log.Fatalf("p2p component: %v", err)
	}

	fmt.Println("listening; dial one of these multiaddrs from the browser:")
	printed := 0
	for _, addr := range h.Addrs() {
		full := addr.Encapsulate(p2pComp)
		fmt.Println("  " + full.String())
		printed++
	}
	if printed == 0 {
		log.Fatal("no listen addresses reported by host")
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	select {
	case <-sigCh:
		log.Println("shutting down")
	case <-ctx.Done():
	}
}
