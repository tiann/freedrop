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
`https://weishu.me/freedrop/`) — host it anywhere, or open it locally.

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
copy, link, or QR); croc resumes interrupted transfers and sends
directories. On the roadmap: PAKE short codes, directory support, resume,
mDNS local discovery for offline LANs.

## Limitations

- Both ends must be online at the same time (nothing is stored anywhere —
  that's the point).
- Directories: `tar` them for now.
- An offline LAN can't rendezvous (the brokers are on the internet), even
  though the transfer itself would stay local.

## Speed

The CLI uses [node-datachannel](https://github.com/murat-dogan/node-datachannel)
(native libdatachannel bindings — prebuilt for Linux/macOS/Windows on
x64 and arm64): **~200 MB/s** measured CLI-to-CLI on loopback, and real
congestion control for lossy wide-area paths. On platforms without a
prebuilt binary it falls back to [werift](https://github.com/shinyoshiaki/werift-webrtc)
(pure JS, ~40–70 MB/s); `FREEDROP_RTC=js` forces the fallback. Browsers
use their own native stacks. The two ends negotiate frame size per
connection, and every data frame carries its in-file offset, so a
misbehaving stack can be caught (duplicates dropped, gaps fatal) instead
of corrupting the file.

## Built on

[node-datachannel](https://github.com/murat-dogan/node-datachannel) with a
[werift](https://github.com/shinyoshiaki/werift-webrtc) fallback for
WebRTC in Node. The rendezvous layer (`signal.mjs`, ~250 lines, zero deps)
is shared with [tango-mirror](https://github.com/tiann/tango-mirror),
where it signals remote Android screen mirroring the same way.

## License

MIT
