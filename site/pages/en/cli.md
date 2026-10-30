---
title: Send files from the terminal with npx freedrop
description: Send a file from a terminal or an SSH session to a phone, a browser or another machine with one command: direct, end-to-end encrypted, resumable, no account.
---

# Send files from the terminal

`npx freedrop <file>` sends a file from any terminal — your laptop, a server over SSH, a CI machine — straight to another device. The other side receives it with `npx freedrop <code>` in its own terminal, or by opening a link in any browser. The bytes travel peer-to-peer over an end-to-end encrypted WebRTC connection; no server stores or relays them, and there is no account and no size limit.

## Send

```bash
npx freedrop report.pdf photos.tgz
```

In a terminal, the sender prints three ways into the same transfer, all carrying the same fresh 256-bit key:

- the command to run on the other machine: `npx freedrop <code>`
- a link that opens in any browser: `https://freedrop.dev/r/#<code>`
- a QR code of that link, for a phone's camera

Then it waits for the receiver — indefinitely, unless you pass `--timeout` — and exits once the receiver has verified every byte. Several files go out as one transfer. Arguments must be regular files: `tar` a directory first.

## Receive

```bash
npx freedrop uMDpiKrcHEIabTuxSCnCUOTdLoMs4DRLGP0lPmC8gVA
```

Put the code after `npx freedrop` — or the whole link, with or without `https://`. The receiver lists the incoming files and asks before saving anything; `-y` skips the question, and `-o <dir>` saves somewhere other than the current directory.

Incoming bytes are staged in a hidden `.freedrop-stage/` directory, next to a small journal of what has already arrived. Each file appears under its real name only after its SHA-256 check passes, and the staging directory disappears when the transfer completes. Nothing is overwritten: a name that is already taken lands as `name(1).ext`. The receiver prints one `saved: <path>` line per file.

## From a server to your phone

You are logged into a remote machine and want one of its files on your phone:

```bash
ssh build-box
npx freedrop build/app-release.apk
```

Scan the QR code in your terminal with the phone's camera, or with **Scan to receive** on [freedrop.dev](/). The transfer opens in the phone's browser; save it and the file is on the phone. Nothing to install there, and no `scp` to a laptop first.

## From your phone, or any browser, to a server

Open [freedrop.dev](/) on the phone and pick the files. The page shows a link, a QR code and an `npx freedrop <code>` line; get either one to the machine that should receive — share the link to yourself, for example — and run:

```bash
npx freedrop 'https://freedrop.dev/r/#uMDpiKrcHEIabTuxSCnCUOTdLoMs4DRLGP0lPmC8gVA'
```

Keep the page open until the transfer finishes: a browser sender cannot resume after its page reloads.

## Between two computers

```bash
# on the first machine
npx freedrop dataset.tar
# on the second: the line the first one printed
npx freedrop uMDpiKrcHEIabTuxSCnCUOTdLoMs4DRLGP0lPmC8gVA
```

Different networks and NATs are fine — home, office, a cloud VM. No SSH keys, no port forwarding, no shared folder. Speed is whatever the network path between the two machines allows: about 430 MB/s CLI to CLI on loopback, transfers over 64 MB striped across four connections, and small files pipelined back to back.

## When a transfer is interrupted

Nothing restarts from zero. The receiver's journal records which byte ranges are already on disk, and on any reconnection only the missing ranges travel.

- **Network blip**: both ends stay running and reconnect on their own; the receiver keeps trying for about 90 seconds.
- **Receiver stopped**: re-run the same receive command, with the same `-o` directory.
- **Sender stopped**: re-run it with the same code and the same files, as below. The waiting receiver reconnects by itself.

```bash
npx freedrop --code uMDpiKrcHEIabTuxSCnCUOTdLoMs4DRLGP0lPmC8gVA dataset.tar
```

An interrupted or lost transfer prints the exact command that resumes it. If a source file changed in between, verification fails loudly instead of producing a corrupt file, and a re-run sends that file fresh.

## Behind strict NAT

Hole-punching covers most home and mobile networks. The one case it cannot handle is symmetric NAT or carrier-grade NAT on both ends; the transfer then fails with exit status 4. Give the sending side a TURN relay — the transfer stays end-to-end encrypted, and the relay forwards packets it cannot read:

```bash
# Cloudflare TURN, 1 TB/month free (dashboard → Realtime → TURN)
CF_TURN_KEY_ID=… CF_TURN_API_TOKEN=… npx freedrop --turn cloudflare big.iso

# or your own coturn, or any static-credential provider
npx freedrop --turn turn:turn.example.com:3478 --turn-auth user:pass big.iso
```

There is deliberately no built-in relay fallback: that is why freedrop has no traffic bill, and why nobody's server ever holds your data. [How freedrop works](/security/) explains the trade-off.

## Options

| Flag | Side | What it does |
|---|---|---|
| `-y`, `--yes` | receive | skip the confirmation prompt (required without a terminal) |
| `-o`, `--out <dir>` | receive | save files here (default: the current directory) |
| `--code <code>` | send | reuse a transfer code, to resume an interrupted send |
| `--turn <target>` | both | `cloudflare`, or a `turn:` / `turns:` URL |
| `--turn-auth <u:p>` | both | credentials for a `--turn` URL |
| `--broker <list>` | both | custom comma-separated `wss://` MQTT brokers |
| `--no-qr` | send | don't print the QR code (it is never printed without a terminal) |
| `--timeout <dur>` | send | give up after this long with no transfer under way (`600`, `90s`, `10m`, `1h`) |
| `--json` | both | one JSON event per line on stdout; human text moves to stderr |

`-h` prints the help, `-v` the version.

## In scripts and CI

Without a terminal — in a script, a CI job, an AI agent's shell — freedrop keeps its output to plain lines: no QR code, no redrawn progress bar (a progress line every 10 seconds instead), and a receiver without `-y` exits at once rather than waiting on a prompt nobody can answer. Add `--json` for one machine-readable event per line, and `--timeout` so a sender doesn't wait forever:

```bash
npx -y freedrop --json --timeout 10m report.pdf
npx -y freedrop --json -y -o downloads 'https://freedrop.dev/r/#…'
```

`npx -y` skips npm's install prompt; the second `-y` is freedrop's. Exit statuses are stable and say what to do next — the full event and exit-code reference is on [freedrop for AI agents](/agents/).

## Installing it, or not

`npx freedrop` runs it without installing anything. To keep it around:

```bash
npm i -g freedrop
freedrop report.pdf
```

freedrop needs Node.js 22 or newer, for its built-in WebSocket. The CLI uses native WebRTC through node-datachannel, prebuilt for Linux, macOS and Windows on x64 and arm64; anywhere else it falls back to werift, a pure-JavaScript engine (about 40–70 MB/s). `FREEDROP_RTC=js` forces the fallback.
