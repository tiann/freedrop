---
title: How freedrop works: encryption, rendezvous and NAT traversal
description: What the key in every freedrop link protects, what the MQTT brokers and the page host can see, how files are verified, and what happens behind strict NAT.
---

# How freedrop works

freedrop sends files over a direct WebRTC connection between two devices, encrypted end to end with DTLS. The only thing that passes through anyone else's servers is a few kilobytes of handshake, encrypted with AES-256-GCM under a 256-bit key that is made fresh for each transfer and travels only inside the link or command you share. No server stores, relays or can read your files.

## The code is the key

Every transfer starts with a fresh random 256-bit key. The code in `npx freedrop <code>`, in the link `https://freedrop.dev/r/#<code>` and in the QR code is that key, base64url-encoded. Everything else derives from it: the rendezvous room, and the encryption of every message sent through it.

## Rendezvous: meeting through public MQTT brokers

Two devices behind home routers can't simply call each other. First they have to swap addresses and connection parameters — WebRTC's SDP and ICE candidates, a few kilobytes in all. freedrop does that through public MQTT brokers: EMQX (an international and a mainland-China endpoint) and HiveMQ.

1. Both ends derive a room id from the key with a one-way hash, so the topic they meet on reveals nothing about the key.
2. Every message in the room is encrypted with AES-256-GCM under the key. A broker sees ciphertext on a random-looking topic, and nothing else.
3. Once the two ends connect directly, the files never touch the brokers. The room is used again only if the ends need to reconnect.

There is nothing to host: no freedrop server, no account, no signaling service of its own. `--broker` points both ends at other `wss://` MQTT brokers if you would rather use your own.

## The connection: WebRTC, DTLS and hole-punching

Each end asks STUN servers — Cloudflare's, Google's, and one reachable from mainland China — for its public address, and the two ends punch through their NATs to reach each other directly. The files then flow over a WebRTC data channel, DTLS-encrypted end to end. Integrity on the wire comes from DTLS and SCTP, and there is no relay in the path that could tamper with the bytes.

Transfers over 64 MB stripe across four connections when both ends support it, each encrypted the same way. Every data frame carries its offset, so a misbehaving WebRTC stack is caught rather than trusted: duplicates are dropped, and a gap is fatal.

## The key never reaches a server

In a browser link the key rides the URL fragment — the part after `#`. Browsers never send the fragment to any server, so the host of the page, freedrop.dev or wherever else the static page is served from, sees an ordinary page load and never learns the key. There is no backend behind the page to log anything to.

## Who sees what

| Party | What it sees |
|---|---|
| Public MQTT brokers | A few KB of AES-256-GCM ciphertext on a topic derived from the key by a one-way hash — and, like any internet service, your IP address |
| STUN servers | A request for your public address, coming from your IP address |
| The host of the page | An ordinary page load; the key in the fragment is never sent |
| Networks in between | DTLS-encrypted WebRTC packets |
| A TURN relay, if you add one | Packets it forwards but cannot decrypt |
| The other end | Your files, and your IP address: that is what a direct connection means |
| Anyone holding the link or code | The transfer — the link is the key |

## Integrity: every byte verified

- The sender hashes each file as it reads it: SHA-256 over 4 MiB blocks.
- The receiver writes into `<name>.part` in a staging area, then re-reads the staged bytes and compares hashes before renaming the file into place under its real name.
- A file whose source changed between attempts fails loudly (exit status 5) instead of landing silently corrupt, and a changed modification time discards stale partial data up front. A re-run transfers the file fresh.
- In a browser, the same check runs before a file is offered as a download.

## Resume

Next to the staged data, the receiver keeps a small journal of the byte ranges already on disk. On any reconnection only the missing ranges travel. That covers every way a transfer dies:

- **First connection**: no signaling progress for about 5 seconds triggers a fresh handshake, within a connection window of about 15 seconds — no page reload needed.
- **Network blip**: both ends stay running, renegotiate through the rendezvous room and continue. The receiver keeps trying for about 90 seconds, and the journal survives either way.
- **Receiver died**: re-run the same `npx freedrop <code>`, or reopen the same link — a browser's staging area survives the tab.
- **Sender died**: re-run it as `freedrop --code <code> <files>`; the waiting receiver reconnects by itself.

A browser *sender* is the exception: the files picked in a page don't survive a reload, so it can't resume across one. Browser receivers and both CLI roles all resume.

## NAT and TURN

Hole-punching covers most home and mobile networks. The one combination it cannot do is symmetric NAT or carrier-grade NAT (CGNAT) on both ends. For that, the sending side can name a TURN relay with `--turn`: Cloudflare's, with 1 TB a month free, or your own coturn. The relay forwards packets it cannot decrypt; the transfer stays end-to-end encrypted.

There is deliberately no relay fallback built in. That is why freedrop has no traffic bill to pass on, and why nobody's server ever holds your data. The cost is that a pair of ends both behind symmetric NAT needs a relay you choose and one extra flag — [the CLI page](/cli/) has the exact commands.

## What freedrop does not protect against

- **Whoever holds the link or code can receive.** Send it only to the recipient, over a channel you trust.
- **A link is one transfer.** Once it is done the sender leaves; reopening the link in the receiving browser shows the files already received, nothing new.
- **Both ends must be online at the same time.** Nothing is stored in between, by design.
- **The receiver decides.** The CLI lists the incoming files and asks before saving (`-y` skips the question); in a browser nothing is saved until the receiver presses Save. When a receiver declines, the CLI sender exits with status 6.
- **The two ends see each other's IP addresses**, as with any direct connection.
