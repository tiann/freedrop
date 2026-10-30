---
title: freedrop vs WeTransfer: direct transfer or upload link
description: WeTransfer uploads files to its servers for later download; freedrop sends them straight to the other device. Compare limits, accounts and privacy.
---

# freedrop vs WeTransfer

WeTransfer uploads your files to its servers and gives the recipient a link that keeps working for days, whether or not you're still online. freedrop uploads nothing: the files go straight from your device to theirs while both of you are online, with no size cap and no account. Use WeTransfer to send and walk away; use freedrop for large or private files when the other person is there now.

## At a glance

Limits as stated on WeTransfer's own pages, October 2026.

| What | freedrop | WeTransfer free plan |
|---|---|---|
| Where the data goes | Straight to the recipient's device | Uploaded to WeTransfer's servers in the EU or the US, downloaded from there |
| Account | None, on either side | The sender needs a free account; recipients don't |
| Size | No limit — the receiver's free space | Up to 3 GB per transfer |
| How many | No limit | Up to 10 transfers (or 3 GB in total) in any rolling 30 days |
| How long it's available | While the sender keeps the page or command open | Up to 3 days |
| Recipient offline | Not possible — both ends are online together | Yes, that's the point |
| Encryption | End to end: DTLS between the devices; in a link the key is never sent to a server | TLS 1.2 or 1.3 in transit, AES-256 at rest on WeTransfer's servers |
| Cost | Free, open source (MIT) | Free plan; paid Starter and Ultimate plans |

## Upload and download, or one direct hop

With WeTransfer a transfer happens twice: you upload to its servers, then the recipient downloads from them. The files wait there until the link expires, so the recipient can take their time and you can close your laptop.

freedrop makes one hop. Your device and theirs find each other through an encrypted handshake on public MQTT brokers, and then the files flow over a direct WebRTC connection. Nothing is uploaded first and nothing is kept anywhere — which is also why both of you have to be online until the last byte arrives. If the connection drops, re-running the command or reopening the link resumes where it stopped.

## Privacy

WeTransfer encrypts files in transit (TLS) and stores them encrypted (AES-256) on its servers — protection against outsiders, but the files do live with the service until they expire.

freedrop never has your files. The brokers see a few kilobytes of ciphertext; the files travel DTLS-encrypted between the two devices; and the key in a link sits after the `#`, which browsers never send to any server, the one hosting freedrop.dev included. Anyone who holds the link can receive, so send it only to the recipient. The full picture: [who sees what](/security/).

## Limits

WeTransfer's free plan caps the size of each transfer at 3 GB and allows up to 10 transfers (or 3 GB in total) in any rolling 30-day window; free links stay up for up to 3 days. Its paid Ultimate plan removes the size limit and lets transfers stay as long as you like.

freedrop has no plans and no caps. The only limit is free space on the receiving side — in a browser, also the storage the browser lets the page use.

## When WeTransfer is the better choice

- The recipient isn't online now, or won't be for hours.
- You want to send and switch off.
- The recipient wants to preview files in the browser before downloading.

## When freedrop is the better choice

- The files are bigger than 3 GB, or you send more than a handful of transfers a month.
- Nobody should have to sign up.
- The files are private and shouldn't sit on anyone's server, even encrypted.
- One end is a terminal: a server over SSH, a CI job or an AI agent's sandbox — `npx freedrop report.pdf` prints a link and a QR code. See [the CLI guide](/cli/) and [freedrop for agents](/agents/).
- The connection is shaky: interrupted transfers resume, and every file is checked with SHA-256 before it appears.

Questions about freedrop itself: [the FAQ](/#faq).
