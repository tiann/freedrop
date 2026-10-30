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
# (the link works here too)
npx freedrop uMDpiKrcHEIabTuxSCnCUOTdLoMs4DRLGP0lPmC8gVA
```

Every combination works:

| | receiver: CLI | receiver: browser |
|---|---|---|
| **sender: CLI** | `npx freedrop <code>` | open the link / scan the QR |
| **sender: browser** | `npx freedrop <code>` | open the link / scan the QR |

The web client is a static page (this repo, deployed to
[freedrop.dev](https://freedrop.dev/)) — host it anywhere, or open it
locally. Where the browser can read QR codes itself (Chrome on Android,
macOS and ChromeOS), the page has a **Scan to receive** button: point it at
the sender's QR code and the transfer opens right there, no camera-app
detour. A finished transfer offers the same button, so a phone can take one
transfer after another without going back to the start page.

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
| `-y`, `--yes` | receive | skip the confirmation prompt (required without a terminal) |
| `-o`, `--out <dir>` | receive | save files here (default: current dir) |
| `--code <code>` | send | reuse a transfer code (resume an interrupted send) |
| `--turn <target>` | both | `cloudflare` or a `turn:`/`turns:` URL |
| `--turn-auth <u:p>` | both | credentials for a `--turn` URL |
| `--broker <list>` | both | custom comma-separated `wss://` MQTT brokers |
| `--no-qr` | send | don't print the QR code (never printed without a terminal) |
| `--timeout <dur>` | send | give up after this long with no transfer under way (`600`, `90s`, `10m`, `1h`) |
| `--json` | both | one JSON event per line on stdout; human text moves to stderr |

Node 22+ (uses the built-in WebSocket).

## Scripts and agents

Without a terminal — in a script, in CI, in an AI agent's shell — the CLI
keeps its output to plain lines: no QR code, no in-place progress bar (a
progress line every 10 s instead), and a receiver without `-y` exits at
once instead of waiting on a prompt nobody can answer. A receiver takes
the browser link as readily as the bare code (with or without
`https://`), and finishes by printing one `saved: <path>` line per file —
a name that is already taken lands as `name(1).ext`.

```bash
# send to a person: hand them the link, wait for it to finish. Without
# --timeout a sender waits for a receiver indefinitely.
npx -y freedrop --json --timeout 10m report.pdf

# receive what someone picked at freedrop.dev, from the link they shared
npx -y freedrop --json -y -o downloads 'https://freedrop.dev/#…'
```

(`npx -y` skips npm's install prompt; the second `-y` is freedrop's.)

With `--json`, stdout carries nothing but these events, one per line:

| event | side | fields |
|---|---|---|
| `ready` | send | `code`, `link`, `files` (`[{name, size}]`), `total` — share the link now |
| `incoming` | receive | `files`, `total`, `resumed` (bytes already on disk) |
| `progress` | both | `bytes`, `total` — at most every 10 s, and at 100 %; a sender counts bytes sent, a receiver bytes on disk |
| `saved` | receive | `name`, `path` (absolute), `size` — once per verified file |
| `status` | both | `message` — human-readable, wording may change |
| `done` | both | `total`, `seconds` — then exit 0 |
| `error` | both | `error`, `code` (the exit status), `message` — then exit |

Exit statuses are stable in both modes:

| code | `error` | meaning | what to do |
|---|---|---|---|
| 0 | | every file verified | |
| 1 | `failed` | anything else | read the message |
| 2 | `usage` | bad arguments, or a receiver without `-y` and no terminal | fix the command |
| 3 | `broker` | no rendezvous broker reachable | check the network or `--broker` |
| 4 | `connect` | the peers met but WebRTC could not connect | retry with `--turn` on the sending side |
| 5 | `verify` | a file failed verification or changed while sending | a re-run transfers it fresh |
| 6 | `declined` | the receiver said no | |
| 7 | `timeout` | `--timeout` passed, or a receiver found no sender | check the code; is the sender still running? |
| 8 | `lost` | connection lost mid-transfer | re-run the same command — it resumes |
| 130 / 143 | `interrupted` | SIGINT / SIGTERM | re-run the same command to resume |

Interrupted and lost transfers print the exact command that resumes them.
The same guide, written for agents, is served at
[freedrop.dev/llms.txt](https://freedrop.dev/llms.txt).

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
loopback, SIGKILL-driven resume scenarios, sha256 over every byte —
plus the web page's QR encoder (`qr.mjs`), checked module for module
against the CLI's. `npm run test:browser` adds the browser paths (all
three interop directions, reload-resume, resume under a browser sender,
the screen wake lock) via Playwright
— run `npx playwright install chromium` once first. Signaling uses the
public brokers by default; point `FREEDROP_TEST_BROKER` at a local
`ws://` MQTT broker for a hermetic run — CI does exactly that with
mosquitto (see `.github/workflows/test.yml`).

## Publishing

Push a `v<version>` tag to publish to npm through
`.github/workflows/release.yml`. The workflow uses npm Trusted Publishing
(GitHub Actions OIDC), so no npm token secret is needed. The npm trusted
publisher must allow `npm publish` for owner `tiann`, repository `freedrop`,
workflow filename `release.yml`, with no environment name.

From an up-to-date `main`, with a clean working tree:

```bash
npm version patch
git push origin main --follow-tags
```

`npm version` updates both package files and creates the version commit
and tag. The workflow runs the CLI and browser test suites before
publishing, and checks that the tag matches the version in both
`package.json` and `package-lock.json`. Stable versions publish under
`latest`; prereleases (for example, `v0.7.0-beta.1`) publish under `next`.
Each version can only be published once.

## Built on

[node-datachannel](https://github.com/murat-dogan/node-datachannel) with a
[werift](https://github.com/shinyoshiaki/werift-webrtc) fallback for
WebRTC in Node. The rendezvous layer (`signal.mjs`, ~250 lines, zero deps)
is shared with [tango-mirror](https://github.com/tiann/tango-mirror),
where it signals remote Android screen mirroring the same way.

## License

MIT
