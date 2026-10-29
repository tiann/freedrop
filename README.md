# freedrop

Send files from anything to anything — CLI or browser — with **no server in
the data path**. Bytes travel peer-to-peer over WebRTC, end-to-end
encrypted. Rendezvous happens through encrypted messages on public MQTT
brokers, so there is nothing to host, no account to make, and no relay
paying for your traffic.

```bash
# send
npx freedrop video.mp4

# receive — the sender prints this command, a link, and a QR code
npx freedrop uMDpiKrcHEIabTuxSCnCUOTdLoMs4DRLGP0lPmC8gVA
```

Every combination works:

| | receiver: CLI | receiver: browser |
|---|---|---|
| **sender: CLI** | `npx freedrop <code>` | open the link / scan the QR |
| **sender: browser** | `npx freedrop <code>` | open the link |

The web client is a static page (this repo, deployed to
[freedrop.dev](https://freedrop.dev/)) — host it anywhere, or open it
locally.

## How it works

The code after `npx freedrop` is a 256-bit key, generated fresh per
transfer:

1. Both ends derive a room id from the key (one-way hash) and meet on
   public MQTT brokers (EMQX intl + CN, HiveMQ). Every message is
   AES-256-GCM encrypted with the key; brokers see ciphertext on a
   random-looking topic, nothing else.
2. Through that room they exchange WebRTC SDP/ICE — a few KB.
3. The files flow over a WebRTC DataChannel: direct P2P after NAT
   hole-punching, DTLS-encrypted end to end. No relay, no server, no
   size limit; speed is whatever the path between you two allows.

In the browser link (`…/#<code>`) the key rides the URL fragment, which
browsers never send to any server — the page host doesn't see it either.
Integrity comes from the transport (DTLS + SCTP): there is no relay in the
path that could tamper with or corrupt the bytes.

## NAT coverage

Hole-punching (with STUN — the defaults include a mainland-China-reachable
server) covers most home and mobile networks. The one combination it can't
do is symmetric NAT / CGNAT **on both ends**. For that, give the transfer a
TURN relay — still end-to-end encrypted, the relay just forwards packets it
cannot read:

```bash
# Cloudflare TURN, 1 TB/month free (see their dashboard → Realtime → TURN)
CF_TURN_KEY_ID=… CF_TURN_API_TOKEN=… freedrop --turn cloudflare big.iso

# or your own coturn / any static-credential provider
freedrop --turn turn:turn.example.com:3478 --turn-auth user:pass big.iso
```

There is deliberately no relay fallback: that is why freedrop has no
traffic bill, and why nobody's server ever holds your data.

## Options

| Flag | | |
|---|---|---|
| `-y`, `--yes` | receive | skip the confirmation prompt |
| `-o`, `--out <dir>` | receive | save files here (default: current dir) |
| `--code <code>` | send | reuse a transfer code (resume an interrupted send) |
| `--turn <target>` | both | `cloudflare` or a `turn:`/`turns:` URL |
| `--turn-auth <u:p>` | both | credentials for a `--turn` URL |
| `--broker <list>` | both | custom comma-separated `wss://` MQTT brokers |
| `--no-qr` | send | don't print the QR code |

Node 22+ (uses the built-in WebSocket).

## vs. croc, wormhole, and friends

| | data path | needs own infra | CLI⇆browser |
|---|---|---|---|
| **freedrop** | P2P (WebRTC) | no — public brokers | ✅ |
| croc | through a relay | relay (author-funded) | ✗ CLI only |
| magic-wormhole | direct or relay | project servers | ✗ CLI only |
| webwormhole | P2P (WebRTC) | signaling server | ✅ |
| FilePizza / PairDrop | P2P (WebRTC) | trackers / own signaling | ✗ browser only |

What the incumbents still do better (v1 honesty): croc and wormhole have a
relay, so they succeed on double-symmetric NAT without any setup; their
short PAKE codes can be read over the phone (freedrop's code is long —
copy, link, or QR); croc sends directories. On the roadmap: PAKE short
codes, directory support, mDNS local discovery for offline LANs.

## Resume & integrity

Interrupted transfers pick up where they stopped. The receiver stages
incoming bytes in a hidden `.freedrop-stage/` directory next to a tiny
journal of the byte ranges already on disk; on any reconnection only
the missing ranges travel. Files appear under their final names only
after verification, and the staging directory disappears when the
transfer completes. That covers every way a transfer dies:

- **First connection** — no signaling progress for ~5 s triggers a fresh
  handshake, with a ~15 s connection window and no page reload.
- **Network blip** — both ends stay running, re-negotiate through the
  rendezvous room, and continue automatically (the receiver retries for
  ~90 s before giving up; the journal survives either way).
- **Receiver died** — re-run the same `freedrop <code>` (or reopen the
  same browser link: the staging area in the browser survives the tab).
- **Sender died** — re-run it as `freedrop --code <code> <files>`; the
  waiting receiver reconnects by itself.

Every file is verified end to end before it lands: the sender hashes
while reading (SHA-256 over 4 MiB blocks), the receiver re-reads the
staged bytes and compares before renaming `<name>.part` into place — so
a resumed transfer whose source file changed in between fails loudly
instead of producing a silently corrupt file. (A changed modification
time already discards stale partials up front.)

## Limitations

- Both ends must be online at the same time (nothing is stored anywhere —
  that's the point).
- Directories: `tar` them for now.
- An offline LAN can't rendezvous (the brokers are on the internet), even
  though the transfer itself would stay local.
- A browser *sender* can't resume across a page reload (the picked files
  don't survive it) — browser receivers and both CLI roles all resume.

## Speed

The CLI uses [node-datachannel](https://github.com/murat-dogan/node-datachannel)
(native libdatachannel bindings — prebuilt for Linux/macOS/Windows on
x64 and arm64): **~430 MB/s** measured CLI-to-CLI on loopback, and real
congestion control for lossy wide-area paths. One WebRTC connection is
CPU-bound around ~220 MB/s (DTLS plus a syscall per packet), so transfers
over 64 MB stripe across four connections when both ends support it —
which also means four congestion windows instead of one on lossy paths.
Small files pipeline back to back with no per-file round trip. On
platforms without a prebuilt binary it falls back to
[werift](https://github.com/shinyoshiaki/werift-webrtc)
(pure JS, ~40–70 MB/s); `FREEDROP_RTC=js` forces the fallback. Browsers
use their own native stacks. The two ends negotiate frame size per
connection, and every data frame carries its offset, so a misbehaving
stack can be caught (duplicates dropped, gaps fatal) instead of
corrupting the file.

## Tests

`npm test` runs the CLI↔CLI end-to-end suite: real WebRTC over
loopback, SIGKILL-driven resume scenarios, sha256 over every byte.
`npm run test:browser` adds the browser paths (all three interop
directions, reload-resume, resume under a browser sender) via Playwright
— run `npx playwright install chromium` once first. Signaling uses the
public brokers by default; point `FREEDROP_TEST_BROKER` at a local
`ws://` MQTT broker for a hermetic run — CI does exactly that with
mosquitto (see `.github/workflows/test.yml`).

## Built on

[node-datachannel](https://github.com/murat-dogan/node-datachannel) with a
[werift](https://github.com/shinyoshiaki/werift-webrtc) fallback for
WebRTC in Node. The rendezvous layer (`signal.mjs`, ~250 lines, zero deps)
is shared with [tango-mirror](https://github.com/tiann/tango-mirror),
where it signals remote Android screen mirroring the same way.

## License

MIT
