---
title: freedrop vs magic-wormhole: links and resume, or short codes
description: freedrop and magic-wormhole both send files end-to-end encrypted. Compare codes, relays, browser support, folders and resume, and when each is the right pick.
---

# freedrop vs magic-wormhole

magic-wormhole is the classic: a short, single-use code like `7-crossover-clockwork`, a PAKE that makes that code safe, folders, and a transit relay when a direct connection fails. freedrop trades the short code for a link and a QR code that open in any browser, keeps the data path direct with no relay fallback, and resumes interrupted transfers. Choose by what the other side has and how the code will travel.

## At a glance

| What | freedrop | magic-wormhole |
|---|---|---|
| Where the data goes | Direct, peer to peer over WebRTC; never through a relay unless you add your own TURN server | Direct when possible, otherwise through a public transit relay |
| Servers it relies on | Public MQTT brokers, for a few KB of encrypted handshake | A mailbox server for the handshake, and the transit relay; public defaults are built into the client |
| The code | A 256-bit key of about 43 characters: link, QR code or command | A number and words, such as `7-crossover-clockwork`; single-use; SPAKE2 PAKE |
| Encryption | DTLS end to end for the data, AES-256-GCM for the handshake | NaCl secretbox, with a key derived from the PAKE |
| In a browser | freedrop.dev sends and receives, directly to a CLI or another browser | The reference client is a CLI; third-party web clients such as Winden and wormhole.page speak the protocol |
| Folders | Not yet — `tar` them first | Yes |
| Resume | Yes — re-run the command or reopen the link | Not described in its docs; both clients stay running until the transfer finishes |
| Timing | Both online together; a sender waits as long as you let it (`--timeout`) | Both clients are expected to start within about an hour of each other |
| Install | `npx freedrop` with Node.js 22+, or nothing in a browser | Python package: pip, apt, Homebrew, Snap, winget, Chocolatey; Go and Rust implementations too |

## Where your bytes go

magic-wormhole's clients first meet on a mailbox server — a small WebSocket relay that carries the PAKE handshake and a few messages. Then both try to connect directly; if that fails, they fall back to the transit relay. Either way the data is encrypted with a key that came out of the PAKE, so the relay forwards ciphertext.

freedrop's handshake travels the same kind of road — public MQTT brokers, AES-256-GCM ciphertext on a topic derived from the key — but the data has only one way to go: a direct WebRTC connection. There is no transit relay to fall back on. That means no traffic bill and no server in the path, and it also means that two ends both behind symmetric NAT need a TURN relay you provide with `--turn`.

## Short codes or long keys

A wormhole code is short enough to read over the phone and is good for one use only. The PAKE is what makes a code that short safe to use.

freedrop has no PAKE: the code is a 256-bit key generated fresh for each transfer. It can't be read aloud, so it travels as a link, a QR code or a copied command. The link puts the key after the `#`, which browsers never send to the server hosting the page.

## When magic-wormhole is the better choice

- The code has to be spoken or typed by hand.
- Both ends are behind symmetric NAT or CGNAT and you want it to just work: the transit relay takes over.
- You're sending a directory.
- You want to build transfers into a Python program, or pick from a wide range of desktop and phone apps that speak the same protocol.

## When freedrop is the better choice

- The other person only has a browser: they open the link on any device, and it talks to your terminal directly.
- The transfer is big and might get interrupted: re-run the command or reopen the link, and only the missing byte ranges travel.
- You want no relay in the data path at all.
- Files must be verified end to end: SHA-256 over every 4 MiB block before a file appears under its real name.
- A script or an AI agent runs the transfer: `--json` events and documented exit codes, see [freedrop for agents](/agents/).

## Command equivalents

| magic-wormhole | freedrop |
|---|---|
| `wormhole send report.pdf` | `npx freedrop report.pdf` |
| `wormhole receive`, then type the code | `npx freedrop <code>` — or open the link |
| `wormhole send photos/` | `tar czf photos.tgz photos && npx freedrop photos.tgz` |
| your own mailbox server | `--broker` with your own `wss://` MQTT brokers |
| your own transit relay | `--turn turn:host:3478 --turn-auth user:pass` |

How the handshake, encryption and verification work in detail: [How freedrop works](/security/). Every option: [the CLI guide](/cli/).
