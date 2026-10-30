---
title: freedrop vs croc: direct WebRTC or relay-backed transfers
description: freedrop and croc both send files end-to-end encrypted. Compare where the bytes go, codes, folders, resume and browser support, and when to pick each.
---

# freedrop vs croc

Pick croc when you need folders, a short code you can read out loud, or a transfer that has to get through even when both ends sit behind strict NAT — its relays make sure it does. Pick freedrop when you want no relay anywhere in the data path, including when one side is a browser, and a transfer that resumes from the same command or link.

## At a glance

| What | freedrop | croc |
|---|---|---|
| Where the data goes | Direct, peer to peer over WebRTC; never through a relay unless you add your own TURN server | Direct when NAT traversal succeeds between two current CLIs; otherwise — and always with a browser peer — through a relay |
| Servers it relies on | Public MQTT brokers, for a few KB of encrypted handshake | Public relays on getcroc.com hostnames, plus public DERP servers while it sets up the direct path |
| The code | A 256-bit key of about 43 characters: copy it, open the link or scan the QR code | A short word-based phrase protected by a PAKE; custom codes of 6+ characters allowed |
| In a browser | freedrop.dev sends and receives, directly to a CLI or another browser | getcroc.com sends and receives, compatible with the CLI, through the relay |
| Folders | Not yet — `tar` them first | Yes, several files and folders in one go |
| Resume | Yes — re-run the command or reopen the link | Yes |
| Verification | SHA-256 over every 4 MiB block, before a file appears under its name | Hashes files; the algorithm is set with `--hash` |
| Recipient offline | Not possible — both ends are online together | Opt-in stored mode keeps an encrypted copy for a limited time |
| Install | `npx freedrop` with Node.js 22+, or nothing in a browser | One binary: install script, Homebrew, Scoop, apt and more — or nothing in a browser |

## Where your bytes go

freedrop has exactly one data path: a WebRTC connection straight from one device to the other, DTLS-encrypted end to end. The public MQTT brokers carry only the introduction — a few kilobytes of AES-256-GCM ciphertext — and then drop out. There is deliberately no relay fallback, which is why freedrop has no traffic bill and why no server ever holds your data.

croc (v11) tries harder to connect and accepts a relay to do it. Between two current CLIs it starts over DERP and promotes the connection to a direct UDP path when NAT traversal succeeds. When that fails, or when the other side is a browser or an older client, the data goes through croc's relays. croc encrypts end to end with a key from its PAKE handshake, so the relay forwards data it shouldn't be able to read — but it is in the path.

The trade-off is real: croc gets through where freedrop can't on its own. When both ends are behind symmetric NAT or carrier-grade NAT, freedrop needs a TURN relay you name with `--turn` (Cloudflare's free tier, or your own coturn).

## Codes and links

croc's code is a short phrase of words, made safe by a PAKE: easy to read out over the phone or type on another machine. `croc send --qr` prints a QR code that opens `https://getcroc.com/?code=…` — the code rides in the query string, which browsers send to the server they load the page from.

freedrop's code is the key itself: 256 random bits, too long to read aloud. You copy it, send the link or scan the QR code. In a link the key sits after the `#`, and browsers never send that part to any server — including freedrop.dev, which serves the page.

## When croc is the better choice

- Both machines are behind symmetric NAT or CGNAT and you don't want to set up a TURN server.
- You're sending a folder, or many files with `--exclude` rules.
- The code has to travel by voice, or be typed by hand.
- The recipient can't be online at the same time: croc's opt-in stored mode keeps an encrypted copy for a limited time (by default one day and one download).
- You want to send a line of text with `croc send --text`.

## When freedrop is the better choice

- You want no relay in the data path, ever — including browser to terminal and browser to browser.
- The receiver is on a phone or someone else's computer: they open a link in any browser, and an interrupted transfer resumes when they reopen it.
- Files must arrive exactly as sent: each is checked with SHA-256 before it appears under its real name, and a source that changed mid-transfer fails loudly.
- A script or an AI agent runs the transfer: `--json` events and documented exit codes, see [freedrop for agents](/agents/).
- You already have Node.js: `npx freedrop` is the whole install.

## Command equivalents

| croc | freedrop |
|---|---|
| `croc send report.pdf` | `npx freedrop report.pdf` |
| `croc send photos/` | `tar czf photos.tgz photos && npx freedrop photos.tgz` |
| `croc <code>` (Windows), `CROC_SECRET=<code> croc` (Linux, macOS) | `npx freedrop <code>` — or the link |
| `croc send --qr report.pdf` | `npx freedrop report.pdf` — prints a QR code in a terminal |
| `croc --relay host:9009 send report.pdf` | `npx freedrop --turn turn:host:3478 --turn-auth user:pass report.pdf` |
| `croc relay` | any TURN server, such as coturn |
| `croc send --text "hi"` | no equivalent — put it in a file |

How the handshake, encryption and verification work in detail: [How freedrop works](/security/). Every option: [the CLI guide](/cli/).
