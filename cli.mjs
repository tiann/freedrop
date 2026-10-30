#!/usr/bin/env node
// freedrop — direct file transfer between CLIs and browsers.
//
// The code is a 256-bit key. Both ends derive a rendezvous room from it
// (public MQTT brokers, AES-256-GCM — brokers see ciphertext only) and
// exchange WebRTC SDP/ICE there. The file bytes travel exclusively over
// the WebRTC DataChannel: direct P2P, DTLS-encrypted, never through any
// server. TURN (--turn) is the opt-in relay for NATs P2P can't punch.
//
// Transfers are resumable and verified. The receiver stages incoming
// bytes in an opaque directory (.freedrop-stage/<rid>/<slot>.part with a
// range journal per slot); any re-negotiation — the same processes after
// a network blip, or fresh runs (`freedrop <code>` to receive again,
// `freedrop --code <code> <files>` to send again) — picks up from the
// journal and transfers only what is missing. A file appears under its
// final name only after its content matches the sender's hash, and the
// staging directory disappears when the whole transfer lands.

import {
    createReadStream, existsSync, statSync, readdirSync, readFileSync,
    writeFileSync, renameSync, rmSync, mkdirSync, rmdirSync, linkSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { createSocket } from "node:dgram";
import { lookup } from "node:dns/promises";
import { networkInterfaces } from "node:os";
import qrcode from "qrcode-terminal";
import { SignalRoom, IceInbox, b64u, DEFAULT_BROKERS } from "./signal.mjs";
import { acquireLeaseLock } from "./lock.mjs";

const PAGE = process.env.FREEDROP_PAGE ?? "https://freedrop.dev/";

// FREEDROP_STUN (comma-separated stun: URLs) replaces the list — the
// tests point it at local stand-ins that play a scripted NAT
const STUN = process.env.FREEDROP_STUN
    ? process.env.FREEDROP_STUN.split(",").map((u) => ({ urls: u.trim() })).filter((s) => s.urls)
    : [
        { urls: "stun:stun.cloudflare.com:3478" },
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun.miwifi.com:3478" }, // reachable from mainland China
    ];

const HELP = `freedrop — send files directly, CLI or browser, no server in the path

Usage:
  freedrop <file> [more files…]     send
  freedrop <code|link>              receive (the sender prints both)

Options:
  -y, --yes             receive without asking (required when stdin is
                        not a terminal)
  -o, --out <dir>       save received files here     (default current dir)
      --code <code>     send with a fixed code — resumes an interrupted
                        send: the receiver keeps its partial data
      --turn <target>   TURN relay for NATs P2P can't punch: "cloudflare"
                        (reads CF_TURN_KEY_ID + CF_TURN_API_TOKEN) or a
                        turn:/turns: URL used with --turn-auth
      --turn-auth <u:p> credentials for a --turn URL
      --broker <list>   comma-separated wss:// MQTT brokers to rendezvous on
      --no-qr           don't print the QR code (never printed when stdout
                        is not a terminal)
      --timeout <dur>   send: give up after this long with no transfer
                        under way (seconds, or 90s / 10m / 1h)
      --json            one JSON event per line on stdout; human text
                        moves to stderr
  -h, --help            show this help
  -v, --version         show version

Interrupted transfers resume: re-run the same receive command (and, if the
sender died too, re-send with --code and the same files).

Exit status: 0 done, 1 error, 2 bad arguments, 3 no broker reachable,
4 peers could not connect (retry with --turn), 5 verification failed,
6 declined, 7 timed out or no sender found, 8 connection lost (re-run to
resume), 130/143 interrupted.
Docs: https://github.com/tiann/freedrop`;

// ---- output for scripts and agents -------------------------------------------
// --json gives stdout to one JSON event per line and moves every human
// line to stderr. Exit codes are API in both modes: callers branch on
// them (retry with --turn, re-run to resume, stop retrying).

const JSON_OUT = process.argv.includes("--json");
// macOS pipes are asynchronous: block so process.exit can't drop events
if (JSON_OUT) process.stdout._handle?.setBlocking?.(true);

const EXIT = {
    failed: 1,
    usage: 2,
    broker: 3, // no rendezvous broker reachable
    connect: 4, // the peers met but WebRTC could not connect — needs TURN
    verify: 5, // a file failed verification, or changed while sending
    declined: 6,
    timeout: 7, // nobody showed up in time
    lost: 8, // connection lost mid-transfer; partial data kept
};
const EXIT_NAME = Object.fromEntries(Object.entries(EXIT).map(([k, v]) => [v, k]));

const emit = JSON_OUT ? (ev) => process.stdout.write(`${JSON.stringify(ev)}\n`) : () => {};
const say = JSON_OUT ? console.error : console.log;

const die = (msg, code = EXIT.failed, fields = {}) => {
    emit({ event: "error", error: EXIT_NAME[code], code, message: msg.trim(), ...fields });
    console.error(msg);
    process.exit(code);
};

// Ctrl-C, or the SIGTERM a caller's timeout sends: flush, explain, exit
const onSignals = (cleanup) => {
    for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
        process.on(sig, () => {
            cleanup();
            emit({ event: "error", error: "interrupted", code, message: sig });
            process.exit(code);
        });
    }
};

// ---- tiny arg parser -------------------------------------------------------

// codes are base64url, so 1 in 64 starts with "-" — the parser must
// recognize them before treating a leading dash as an option
const looksLikeCode = (s) => /^[A-Za-z0-9_-]{40,48}$/.test(s);

// people (and agents) get handed the browser link as often as the bare
// code — take the code out of its fragment, read the way app.js reads it.
// The scheme is optional: the page displays the link without one.
const codeOf = (s) => {
    if (looksLikeCode(s)) return s;
    const m = /^(?:https?:\/\/)?[^\s#/]+\/[^\s#]*#(?:k=)?(.+)$/i.exec(s ?? "");
    if (!m) return null;
    try {
        const c = decodeURIComponent(m[1]);
        return looksLikeCode(c) ? c : null;
    } catch { return null; }
};

const flags = {};
const rest = [];
{
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "-h" || a === "--help") {
            console.log(HELP);
            process.exit(0);
        } else if (a === "-v" || a === "--version") {
            const pkg = JSON.parse(
                await import("node:fs/promises").then((fs) =>
                    fs.readFile(new URL("./package.json", import.meta.url), "utf8")),
            );
            console.log(pkg.version);
            process.exit(0);
        } else if (a === "-y" || a === "--yes") flags.yes = true;
        else if (a === "--no-qr") flags.noQr = true;
        else if (a === "-o" || a === "--out") flags.out = argv[++i];
        else if (a === "--code") flags.code = argv[++i];
        else if (a === "--turn") flags.turn = argv[++i];
        else if (a === "--turn-auth") flags.turnAuth = argv[++i];
        else if (a === "--broker") flags.broker = argv[++i];
        else if (a === "--timeout") flags.timeout = argv[++i];
        else if (a === "--json") {} // read up front, before anything prints
        else if (a.startsWith("-") && !looksLikeCode(a)) {
            die(`unknown option: ${a}\nrun freedrop --help for usage`, EXIT.usage);
        } else rest.push(a);
    }
}

const BROKERS = flags.broker
    ? flags.broker.split(",").map((s) => s.trim()).filter(Boolean)
    : DEFAULT_BROKERS;

const TIMEOUT_MS = (() => {
    if (flags.timeout === undefined) return 0;
    const m = /^(\d+(?:\.\d+)?)([smh]?)$/.exec(flags.timeout ?? "");
    if (!m || !(Number(m[1]) > 0)) {
        die(`--timeout: expected seconds, or a number with s/m/h — got "${flags.timeout}"`, EXIT.usage);
    }
    return Number(m[1]) * { "": 1e3, s: 1e3, m: 6e4, h: 36e5 }[m[2]];
})();

if (typeof WebSocket === "undefined") die("freedrop needs Node 22+ (built-in WebSocket)");

// ---- WebRTC engine ----------------------------------------------------------
// node-datachannel (libdatachannel bindings): native SCTP with real
// congestion control — this is what makes transfers run at line rate.
// werift (pure JS, ~65 MB/s ceiling and textbook loss recovery) stays as
// the fallback for platforms without a prebuilt binary; FREEDROP_RTC=js
// forces it, which the interop tests use.

let native = false;
const RTCPeerConnection = await (async () => {
    if (process.env.FREEDROP_RTC !== "js") {
        try {
            const { RTCPeerConnection: PC } = await import("node-datachannel/polyfill");
            // NOTE: setSctpSettings looks like the obvious lever for
            // high-latency paths (usrsctp's default buffers cap one
            // association at ~buffer/RTT), but ANY buffer override makes
            // this usrsctp build tear down associations under a full-rate
            // flood — measured with 4 MB and 16 MB alike. Stripes (below)
            // give WAN paths N congestion windows instead.
            if (process.env.FREEDROP_DEBUG) {
                try {
                    const ndc = await import("node-datachannel");
                    ndc.initLogger("Warning", (lvl, msg) => console.error(`\n[rtc:${lvl}] ${msg}`));
                } catch {}
            }
            native = true;
            return PC;
        } catch {}
    }
    const { RTCPeerConnection: WeriftPC } = await import("werift");
    // dress werift's observable API up as the standard browser one, so the
    // transfer code below has a single shape to talk to. Guards throughout:
    // werift can re-emit channel/open events, and double subscriptions
    // silently duplicate an entire transfer.
    const wrapChannel = (ch) => {
        if (ch.__wrapped) return ch;
        ch.__wrapped = true;
        let opened = false;
        ch.onMessage.subscribe((data) => ch.onmessage?.({ data }));
        ch.stateChanged.subscribe((st) => {
            if (st === "open" && !opened) {
                opened = true;
                ch.onopen?.();
            }
            if (st === "closed") ch.onclose?.();
        });
        ch.bufferedAmountLow.subscribe(() => ch.onbufferedamountlow?.());
        return ch;
    };
    return class extends WeriftPC {
        constructor(config) {
            super(config);
            this.onIceCandidate.subscribe((c) => this.onicecandidate?.({ candidate: c ?? null }));
            this.onDataChannel.subscribe((ch) => this.ondatachannel?.({ channel: wrapChannel(ch) }));
            this.connectionStateChange.subscribe(() => this.onconnectionstatechange?.());
        }
        createDataChannel(label, opts) {
            return wrapChannel(super.createDataChannel(label, opts));
        }
    };
})();

// The peer announces its message-size limit in the SDP. 64 KiB messages
// measured fastest for libdatachannel (bigger frames are slower: the cost
// is per-packet, not per-message) — but werift (announces exactly 65536)
// crashes or duplicates data on messages near its cap, so any end that
// announces 64 KiB or less gets the proven 16 KB payload.
const chunkFor = (remoteSdp) => {
    if (!native) return 16 * 1024;
    const m = /a=max-message-size:(\d+)/.exec(remoteSdp);
    const remote = m ? Number(m[1]) : 65536;
    if (remote <= 65536) return 16 * 1024;
    return Math.min(remote, 64 * 1024) - 9; // 9-byte frame header
};
const HIGH_WATER = native ? 16 * 1024 * 1024 : 4 * 1024 * 1024;
const LOW_WATER = HIGH_WATER / 4;

// One SCTP association is CPU-bound (DTLS + a syscall per packet) around
// ~220 MB/s; independent associations scale to ~2.3× at four, and on lossy
// WANs N congestion windows beat one. Extra connections only pay off when
// the transfer outlasts their ICE setup, hence the size floor. The
// receiver's hello advertises how many connections it can take (1 for
// werift, whose engine can't be trusted under a striped flood).
const STRIPE_CONNS = 4;
const STRIPE_MIN = 64 * 1024 * 1024;

const HANDSHAKE_TIMEOUT = 5000;
const CONNECT_WINDOW = 15_000;
// how long the receiver keeps re-negotiating before giving up (the
// journal survives either way — a later run resumes)
const RETRY_WINDOW = 90_000;

const candJson = (c) =>
    c.toJSON ? c.toJSON() : { candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex };

// ---- TURN (same forms as tango-mirror, minus the relay) ---------------------

async function turnServers() {
    const t = flags.turn;
    if (!t) return [];
    if (t === "cloudflare") {
        const { CF_TURN_KEY_ID, CF_TURN_API_TOKEN } = process.env;
        if (!CF_TURN_KEY_ID || !CF_TURN_API_TOKEN) {
            die("--turn cloudflare needs CF_TURN_KEY_ID and CF_TURN_API_TOKEN in the environment", EXIT.usage);
        }
        const res = await fetch(
            `https://rtc.live.cloudflare.com/v1/turn/keys/${CF_TURN_KEY_ID}/credentials/generate-ice-servers`,
            {
                method: "POST",
                headers: { authorization: `Bearer ${CF_TURN_API_TOKEN}`, "content-type": "application/json" },
                body: JSON.stringify({ ttl: 86400 }),
                signal: AbortSignal.timeout(5000),
            },
        );
        if (!res.ok) throw new Error(`cloudflare TURN credentials: HTTP ${res.status}`);
        const raw = (await res.json()).iceServers ?? [];
        return (Array.isArray(raw) ? raw : [raw])
            .map((s) => ({
                ...s,
                urls: (Array.isArray(s.urls) ? s.urls : [s.urls])
                    .filter((u) => /^turns?:/i.test(u) && !/:53(\D|$)/.test(u)),
            }))
            .filter((s) => s.urls.length);
    }
    if (/^turns?:/i.test(t)) {
        const at = (flags.turnAuth ?? "").indexOf(":");
        if (at < 0) die("--turn with a turn:/turns: URL needs --turn-auth user:pass", EXIT.usage);
        return [{
            urls: t.split(",").map((u) => u.trim()),
            username: flags.turnAuth.slice(0, at),
            credential: flags.turnAuth.slice(at + 1),
        }];
    }
    die(`--turn: expected "cloudflare" or a turn:/turns: URL, got "${t}"`, EXIT.usage);
}

// test hook: FREEDROP_ICE_POLICY=relay advertises relay candidates only.
// On both ends and without --turn, the peers meet but can never connect
// (one end alone isn't enough: it still answers the other's checks).
const rtcConfig = (iceServers) =>
    process.env.FREEDROP_ICE_POLICY === "relay" ? { iceServers, iceTransportPolicy: "relay" } : { iceServers };

// ---- STUN probe -------------------------------------------------------------
// Both engines ask ONE STUN server per connection — libdatachannel picks
// one of the list at random, werift always takes the first — so a server
// this network can't reach (Google's, from mainland China) silently costs
// a connection its public candidate, and two port-restricted NATs then
// never meet. So every server gets asked once at startup, all from one
// socket: the answers say which servers to hand the engine, and how this
// NAT maps — one public port whatever the destination (hole-punchable),
// or a new one per destination (symmetric). Each end tells the other its
// verdict over the room, so a failed connection can say which end it was.

const PROBE_MS = 1500; // answer window, from the first request out
const PROBE_CAP = 3000; // slow DNS included
const NAT_TYPES = ["open", "cone", "symmetric", "blocked", "unknown"];
// a peer's verdict comes off the wire — keep only what we understand
const natOf = (n) => (NAT_TYPES.includes(n?.type) ? { type: n.type, ipv6: n.ipv6 === true } : null);

let stunServers = STUN; // narrowed to the servers that answered
let natHere = null; // { type, ipv6 }

// "stun:host:port", "stun:[v6]:port" → { host, port }
const stunTarget = (url) => {
    const m = /^stuns?:(\[[^\]]+\]|[^:]+)(?::(\d+))?$/i.exec(url);
    return m && { host: m[1].replace(/^\[|\]$/g, ""), port: Number(m[2] ?? 3478) };
};
// one spelling per IPv6 address, so answers compare with interface addresses
const ipKey = (ip) => (ip.includes(":") ? new URL(`http://[${ip}]`).hostname.slice(1, -1) : ip);

// XOR-MAPPED-ADDRESS from a Binding success response (or MAPPED-ADDRESS,
// from servers that predate RFC 5389)
function mappedAddress(buf) {
    let found = null;
    const end = Math.min(buf.length, 20 + buf.readUInt16BE(2));
    for (let at = 20; at + 4 <= end;) {
        const type = buf.readUInt16BE(at);
        const v = buf.subarray(at + 4, at + 4 + buf.readUInt16BE(at + 2));
        at += 4 + Math.ceil(v.length / 4) * 4;
        const xor = type === 0x0020;
        if ((!xor && type !== 0x0001) || v.length < 8) continue;
        // the X- form is masked with the magic cookie + transaction id
        const raw = Buffer.alloc(v.length - 4);
        for (let i = 0; i < raw.length; i++) raw[i] = v[4 + i] ^ (xor ? buf[4 + i] : 0);
        const port = v.readUInt16BE(2) ^ (xor ? 0x2112 : 0);
        if (v[1] === 1) found = { ip: [...raw.subarray(0, 4)].join("."), port };
        else if (v[1] === 2 && raw.length >= 16) {
            const groups = [];
            for (let i = 0; i < 16; i += 2) groups.push(raw.readUInt16BE(i).toString(16));
            found = { ip: ipKey(groups.join(":")), port };
        }
        if (found && xor) break;
    }
    return found;
}

// a Binding Request to every server, per address family, from one socket
// per family; retried until the deadline. Resolves with what came back,
// and which families a request went out for at all.
function stunAsk() {
    const MAGIC = 0x2112a442;
    return new Promise((resolve) => {
        const pending = new Map(); // transaction id → { url, family, ip, port, req }
        const got = [];
        const asked = new Set();
        const socks = {};
        let lookups = STUN.length;
        let over = false;
        let grace = null;
        const end = () => {
            if (over) return;
            over = true;
            clearTimeout(cap);
            clearTimeout(grace);
            clearInterval(resend);
            for (const s of Object.values(socks)) { try { s.close(); } catch {} }
            resolve({ got, asked });
        };
        const settle = () => { if (!lookups && !pending.size) end(); };
        const cap = setTimeout(end, PROBE_CAP);
        const send = (id, p) => socks[p.family].send(p.req, p.port, p.ip, (e) => {
            if (e && pending.delete(id)) settle(); // no route for this family
        });
        const resend = setInterval(() => { for (const [id, p] of pending) send(id, p); }, 300);
        const onAnswer = (buf) => {
            if (buf.length < 20 || buf.readUInt16BE(0) !== 0x0101 || buf.readUInt32BE(4) !== MAGIC) return;
            const id = buf.toString("hex", 8, 20);
            const p = pending.get(id);
            const mapped = p && mappedAddress(buf);
            if (!mapped) return;
            pending.delete(id);
            got.push({ url: p.url, family: p.family, ...mapped });
            settle();
        };
        for (const family of [4, 6]) {
            const s = createSocket(`udp${family}`);
            s.on("message", onAnswer);
            s.on("error", () => {}); // e.g. no IPv6 at all: that family just never answers
            socks[family] = s;
        }
        for (const { urls } of STUN) {
            const t = stunTarget(urls);
            (t ? lookup(t.host, { all: true }) : Promise.resolve([])).then((addrs) => {
                for (const family of [4, 6]) {
                    const a = addrs.find((x) => x.family === family);
                    if (over || !a) continue;
                    const id = randomBytes(12);
                    const req = Buffer.alloc(20); // Binding Request, no attributes
                    req.writeUInt16BE(0x0001, 0);
                    req.writeUInt32BE(MAGIC, 4);
                    id.copy(req, 8);
                    const p = { url: urls, family, ip: a.address, port: t.port, req };
                    pending.set(id.toString("hex"), p);
                    asked.add(family);
                    grace ??= setTimeout(end, PROBE_MS);
                    send(id.toString("hex"), p);
                }
            }, () => {}).finally(() => { lookups--; settle(); });
        }
    });
}

async function probeNat() {
    const { got, asked } = await stunAsk();
    const answered = new Set(got.map((g) => g.url));
    if (answered.size) stunServers = STUN.filter(({ urls }) => answered.has(urls));
    const local = new Set(Object.values(networkInterfaces()).flat().map((i) => ipKey(i.address)));
    const v4 = got.filter((g) => g.family === 4);
    natHere = {
        // no answer to a request that went out: UDP blocked. No request
        // at all (DNS down) proves nothing.
        type: !v4.length ? (asked.has(4) ? "blocked" : "unknown")
            : v4.some((g) => local.has(g.ip)) ? "open"
            : v4.length < 2 ? "unknown"
            : new Set(v4.map((g) => `${g.ip}:${g.port}`)).size > 1 ? "symmetric" : "cone",
        ipv6: got.some((g) => g.family === 6),
    };
    dbg?.(`stun: ${got.map((g) => `${g.url} → ${g.ip}:${g.port}`).join(", ") || "no answer"}` +
        ` — nat ${natHere.type}${natHere.ipv6 ? ", IPv6" : ""}`);
}

// the candidate pair a connection settled on, for FREEDROP_DEBUG: shows
// whether a transfer went over IPv6, a LAN, or a relay
function pathOf(pc) {
    try {
        const p = native ? pc.selectedCandidatePair() : pc.iceTransports[0].connection.nominated;
        const ends = native ? [p.local, p.remote] : [p.localCandidate, p.remoteCandidate];
        return ends.map((c) => {
            const ip = c.address ?? c.host;
            return `${c.type} ${ip.includes(":") ? `[${ip}]` : ip}:${c.port}`;
        }).join(" → ");
    } catch { return "unknown"; }
}

// ---- wire framing -----------------------------------------------------------
// Every DataChannel message is binary. Tag 1 = UTF-8 JSON control message;
// tag 0 = file bytes, followed by an 8-byte offset into the transfer's
// global byte range (files concatenated in manifest order). The offset
// lets chunks land positionally from any stripe, lets the receiver drop
// duplicates (werift's receive path replays messages under load), and is
// what makes resume a matter of bookkeeping: "what I have" is a set of
// offset ranges, and only the complement travels.
//
// Control frames: manifest {files:[{name,size,mtime}]} → accept {have} →
// (data) → hash {i,sha} per file → eof → more {have} if gaps remain →
// done. `have` is a list of [start,end) ranges in global offsets.

const jframe = (obj) => Buffer.concat([Buffer.from([1]), Buffer.from(JSON.stringify(obj))]);

function chunkFrame(offset, payload) {
    const head = Buffer.alloc(9);
    head[0] = 0;
    head.writeBigUInt64BE(BigInt(offset), 1);
    return Buffer.concat([head, payload]);
}

function parseFrame(data) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf[0] === 1) return { msg: JSON.parse(buf.subarray(1).toString()) };
    return { offset: Number(buf.readBigUInt64BE(1)), chunk: buf.subarray(9) };
}

// ---- offset ranges ----------------------------------------------------------
// Sorted, disjoint [start,end) intervals. Chunks arrive nearly in order
// per channel, so a transfer's coverage is a handful of intervals — the
// journal stays tiny no matter the file size.

function addRange(rs, s, e) {
    let i = 0;
    while (i < rs.length && rs[i][1] < s) i++;
    let removed = 0;
    let j = i;
    while (j < rs.length && rs[j][0] <= e) {
        removed += rs[j][1] - rs[j][0];
        s = Math.min(s, rs[j][0]);
        e = Math.max(e, rs[j][1]);
        j++;
    }
    rs.splice(i, j - i, [s, e]);
    return e - s - removed; // bytes newly covered
}

const coveredBytes = (rs) => rs.reduce((n, [s, e]) => n + (e - s), 0);

function complement(rs, total) {
    const out = [];
    let p = 0;
    for (const [s, e] of rs) {
        if (s > p) out.push([p, s]);
        p = Math.max(p, e);
    }
    if (p < total) out.push([p, total]);
    return out;
}

// ranges from the wire or a journal are untrusted — clamp and re-merge
function cleanRanges(raw, max) {
    const rs = [];
    for (const r of Array.isArray(raw) ? raw : []) {
        const s = Number(r?.[0]);
        const e = Number(r?.[1]);
        if (Number.isSafeInteger(s) && Number.isSafeInteger(e) && s >= 0 && s < e && e <= max) {
            addRange(rs, s, e);
        }
    }
    return rs;
}

// ---- content hash -----------------------------------------------------------
// fdhash(file) = sha256(sha256(block₀) ‖ sha256(block₁) ‖ …), 4 MiB
// blocks. Chosen over a plain sha256 stream because browsers have no
// incremental digest — both ends can compute this shape, either end can
// stream it. The sender hashes while reading, the receiver re-reads the
// staged file once at the end; a mismatch (bit rot, or the sender's file
// changed between resume runs) is fatal before the file is renamed into
// place.

const HASH_BLOCK = 4 * 1024 * 1024;

class BlockHasher {
    #digests = [];
    #cur = null;
    #fill = 0;
    update(buf) {
        let off = 0;
        while (off < buf.length) {
            if (!this.#cur) {
                this.#cur = createHash("sha256");
                this.#fill = 0;
            }
            const take = Math.min(HASH_BLOCK - this.#fill, buf.length - off);
            this.#cur.update(buf.subarray(off, off + take));
            this.#fill += take;
            off += take;
            if (this.#fill === HASH_BLOCK) {
                this.#digests.push(this.#cur.digest());
                this.#cur = null;
            }
        }
    }
    digest() {
        if (this.#cur) {
            this.#digests.push(this.#cur.digest());
            this.#cur = null;
        }
        return createHash("sha256").update(Buffer.concat(this.#digests)).digest("hex");
    }
}

// ---- progress + formatting --------------------------------------------------

const fmtSize = (n) =>
    n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(2)} GB`
    : n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB`
    : n >= 1024 ? `${(n / 1024).toFixed(0)} KB`
    : `${n} B`;

// without a terminal (scripts, agents, logs) there is no line to redraw:
// every status becomes a line of its own, so repeats are dropped and
// progress is drawn rarely instead of ten times a second
const TTY = !!process.stderr.isTTY;
let lastLine = "";
const draw = (line) => {
    if (TTY) return process.stderr.write(`\r\x1b[K${line}`);
    const text = line.trimEnd();
    if (!text || text === lastLine) return;
    lastLine = text;
    process.stderr.write(`${text}\n`);
};
let lastStatus = "";
const status = (line) => {
    draw(line);
    const text = line.trim();
    if (text && text !== lastStatus) emit({ event: "status", message: (lastStatus = text) });
};

// redrawing per chunk costs real throughput at these rates — throttle.
// `skipped` counts bytes an earlier attempt already delivered: the line
// shows this attempt, the event the whole transfer.
let lastDraw = 0;
let lastEvent = 0;
let lastDone = -1;
function progressLine(verb, done, total, t0, skipped = 0) {
    if (done === lastDone) return;
    lastDone = done;
    const now = Date.now();
    if (now - lastEvent >= 10_000 || done === total) {
        lastEvent = now;
        emit({ event: "progress", bytes: skipped + done, total: skipped + total });
    }
    if (now - lastDraw < (TTY ? 100 : 10_000) && done !== total) return;
    lastDraw = now;
    const secs = (now - t0) / 1000;
    const rate = secs > 0.2 ? `  ${fmtSize(done / secs)}/s` : "";
    const pct = total ? ` ${Math.floor((done / total) * 100)}%` : "";
    draw(`${verb}${pct}  ${fmtSize(done)} / ${fmtSize(total)}${rate}`);
}

// P2P failure before any data is the one error fresh users hit — explain
// it, from both ends' probe verdicts when the peer sent one
const NAT_SAYS = {
    open: "public IP, no NAT",
    cone: "NAT keeps one public port per socket — hole-punchable",
    symmetric: "symmetric NAT — a new public port for every destination",
    blocked: "no STUN server answered — UDP blocked?",
    unknown: "NAT type unknown — only one STUN server answered",
};
function natHint(peer) {
    const here = natHere;
    const says = (n) => (n ? NAT_SAYS[n.type] + (n.ipv6 ? "; has IPv6" : "") : "unknown");
    const sym = (n) => n?.type === "symmetric";
    const easy = (n) => n?.type === "open" || n?.type === "cone";
    const why =
        here?.type === "blocked" ? "No STUN server answered from this network, so it likely blocks UDP; a TURN relay over TLS (turns:, port 443) can still get out."
        : peer?.type === "blocked" ? "No STUN server answered from the other end's network, so it likely blocks UDP."
        : sym(here) && sym(peer) ? "Both ends are behind symmetric NAT: there is no hole to punch."
        : sym(here) ? "This end is behind symmetric NAT, and the other end's NAT is too strict to meet it."
        : sym(peer) ? "The other end is behind symmetric NAT, and this end's NAT is too strict to meet it."
        : easy(here) && easy(peer) ? "Neither NAT should stop P2P, so a firewall is probably dropping UDP."
        : "Symmetric NAT or CGNAT on both ends?";
    const v6 = here?.ipv6 && peer?.ipv6 ? " Both ends have IPv6, and that path failed too." : "";
    return "\nWebRTC could not connect.\n" +
        `  this end:  ${says(here)}\n` +
        `  other end: ${says(peer)}\n` +
        `${why}${v6}\n` +
        "Retry with a TURN relay on the SENDING side: --turn cloudflare\n" +
        "(free 1 TB/month — see the README)";
}
const dieNat = (peer) => die(natHint(peer), EXIT.connect, { nat: { here: natHere, peer: peer ?? null } });

const dbg = process.env.FREEDROP_DEBUG ? (...a) => console.error("\n[dbg]", ...a) : null;

// test hook: cap the send rate (bytes/second) so interruption tests get
// a deterministic mid-transfer window on any machine
const BPS = Number(process.env.FREEDROP_BPS ?? 0);

const shellQuote = (s) => (/^[\w./+=:,-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`);

const ABORT = Symbol("attempt aborted");

// ---- send -------------------------------------------------------------------
// The sender is a loop of attempts: each receiver hello gets a fresh set
// of connections, a manifest, and — after accept {have} — a single
// sequential read of every file that hashes everything and transmits
// only the missing ranges. A dead receiver is not fatal; the room stays
// open and the next hello (same process re-run with `freedrop <code>`,
// or the same one reconnecting) starts a new attempt that resumes.

async function send(paths) {
    const files = paths.map((p) => {
        const st = statSync(p);
        return { path: p, name: basename(p), size: st.size, mtime: Math.round(st.mtimeMs) };
    });
    const total = files.reduce((n, f) => n + f.size, 0);
    const bases = [];
    {
        let b = 0;
        for (const f of files) {
            bases.push(b);
            b += f.size;
        }
    }
    let key;
    if (flags.code) {
        const fixed = codeOf(flags.code);
        if (!fixed) die("--code: not a freedrop code", EXIT.usage);
        key = Buffer.from(b64u.decode(fixed));
    } else key = randomBytes(32);
    const code = b64u.encode(new Uint8Array(key));
    const probing = probeNat(); // in parallel with the broker connection
    const turn = await turnServers().catch((e) => die(`--turn: ${e.message}`));

    const room = await SignalRoom.create({ key, role: "host", brokers: BROKERS })
        .catch((e) => die(`cannot reach any rendezvous broker: ${e.message}`, EXIT.broker));
    await probing;

    say(`freedrop: ${files.length} file(s), ${fmtSize(total)}`);
    for (const f of files) say(`  ${f.name}  (${fmtSize(f.size)})`);
    say(`\nreceive with:   npx freedrop ${code}`);
    const link = `${PAGE}#${code}`;
    say(`or in browser:  ${link}\n`);
    if (!flags.noQr && !JSON_OUT && process.stdout.isTTY) {
        qrcode.generate(link, { small: true }, (art) => console.log(art));
    }
    say("waiting for receiver…  (Ctrl-C to cancel)");
    emit({ event: "ready", code, link, files: files.map(({ name, size }) => ({ name, size })), total });

    let at = null; // current attempt
    let acceptedEver = false;
    let done = false;
    let natFailed = false; // a receiver came, but WebRTC could not reach it
    const t0 = { v: 0 };
    const resumeCmd = `freedrop --code ${code} ${paths.map(shellQuote).join(" ")}`;

    onSignals(() => {
        if (acceptedEver && !done) {
            console.error(`\ninterrupted — the receiver keeps its partial data.\nresume with:\n  ${resumeCmd}`);
        }
        try { room.close(); } catch {}
    });

    // --timeout: a sender in the background must not wait forever for a
    // receiver that never comes, or never comes back. Only time without
    // a transfer under way counts — a live transfer is never cut short.
    if (TIMEOUT_MS) {
        let idleSince = Date.now();
        const timer = setInterval(() => {
            if (at && !at.dead && at.streaming) {
                idleSince = 0;
            } else if (!idleSince) {
                idleSince = Date.now();
            } else if (Date.now() - idleSince >= TIMEOUT_MS) {
                status("");
                if (natFailed && !acceptedEver) dieNat(at?.peerNat);
                die(acceptedEver
                    ? `\nthe receiver did not come back in time — it keeps its partial data.\nresume with:\n  ${resumeCmd}`
                    : "\nno receiver in time", EXIT.timeout);
            }
        }, 1000);
        timer.unref?.();
    }

    const teardown = (a) => {
        if (!a) return;
        a.dead = true;
        a.drainResolve?.();
        a.drainResolve = null;
        for (const c of a.conns) { try { c?.pc.close(); } catch {} }
    };

    const sendCtl = (a, obj) => {
        try { a.conns[0].dc.send(jframe(obj)); } catch {}
    };

    const openPool = (a) => {
        const open_ = [];
        for (const c of a.conns) {
            if (!c) continue;
            if (c.dc?.readyState === "open") open_.push(c);
            else if (c.used) { // a stripe that carried data died — its bytes may be gone
                teardown(a);
                throw ABORT;
            }
        }
        if (!open_.length) {
            teardown(a);
            throw ABORT;
        }
        return open_;
    };

    // least-buffered open stripe; parks when every stripe is above the
    // mark. The park has a timeout: werift does not always report a dead
    // peer, so we re-check the pool instead of trusting the drain event.
    const pickChannel = async (a) => {
        for (;;) {
            if (a.dead) throw ABORT;
            const open_ = openPool(a);
            let best = open_[0];
            for (const c of open_) if (c.dc.bufferedAmount < best.dc.bufferedAmount) best = c;
            if (best.dc.bufferedAmount <= HIGH_WATER) return best;
            await new Promise((r) => {
                a.drainResolve = r;
                const t = setTimeout(r, 5000);
                t.unref?.();
            });
        }
    };

    const sendChunk = (a, c, offset, payload) => {
        try {
            c.used = true;
            c.dc.send(chunkFrame(offset, payload));
        } catch {
            teardown(a);
            throw ABORT;
        }
    };

    // one sequential pass over every file: hash every block (resume needs
    // fresh hashes — the file may have changed since the last run), send
    // only chunks that intersect the missing ranges. Reading skipped
    // ranges costs disk speed, which the network never notices.
    const streamAll = async (a, have) => {
        const missing = complement(cleanRanges(have, total), total);
        const need = missing.reduce((n, [s, e]) => n + (e - s), 0);
        if (need < total) status(`resuming — ${fmtSize(total - need)} already delivered\n`);
        t0.v = Date.now();
        let sent = 0;
        let mi = 0;
        let lastPing = Date.now();
        for (let fi = 0; fi < files.length; fi++) {
            const f = files[fi];
            const hasher = new BlockHasher();
            let local = 0;
            if (f.size > 0) {
                for await (const block of createReadStream(f.path, { highWaterMark: 4 * 1024 * 1024 })) {
                    if (a.dead) throw ABORT;
                    hasher.update(block);
                    // a resumed transfer scans its covered prefix without
                    // sending a single frame — minutes of silence on a big
                    // file, which the receiver would mistake for a dead
                    // peer and reconnect (restarting this very scan)
                    if (Date.now() - lastPing > 5000) {
                        lastPing = Date.now();
                        sendCtl(a, { t: "ping" });
                    }
                    const gs = bases[fi] + local;
                    const ge = gs + block.length;
                    while (mi < missing.length && missing[mi][1] <= gs) mi++;
                    for (let j = mi; j < missing.length && missing[j][0] < ge; j++) {
                        const s = Math.max(gs, missing[j][0]);
                        const e = Math.min(ge, missing[j][1]);
                        for (let p = s; p < e; p += a.chunkSize) {
                            const q = Math.min(e, p + a.chunkSize);
                            const c = await pickChannel(a);
                            sendChunk(a, c, p, block.subarray(p - gs, q - gs));
                            sent += q - p;
                            progressLine("sending", sent, need, t0.v, total - need);
                            if (BPS) {
                                const ahead = (sent / BPS) * 1000 - (Date.now() - t0.v);
                                if (ahead > 50) await new Promise((r) => setTimeout(r, ahead));
                            }
                        }
                    }
                    local += block.length;
                }
            }
            if (local !== f.size) die(`\n${f.name}: size changed while sending — re-run to restart`, EXIT.verify);
            sendCtl(a, { t: "hash", i: fi, sha: hasher.digest() });
        }
        sendCtl(a, { t: "eof" });
        status("waiting for the receiver to verify…");
    };

    const fileIndexAt = (off) => {
        let lo = 0;
        let hi = files.length - 1;
        while (lo < hi) { // last file whose base ≤ off (skips empty files)
            const mid = (lo + hi + 1) >> 1;
            if (bases[mid] <= off) lo = mid;
            else hi = mid - 1;
        }
        return lo;
    };

    // gap fill after eof: an engine dropped messages. Rare and small —
    // positioned reads, no re-hash (this attempt already sent hashes).
    const streamMore = async (a, have) => {
        const missing = complement(cleanRanges(have, total), total);
        for (const [s, e] of missing) {
            let p = s;
            while (p < e) {
                const fi = fileIndexAt(p);
                const f = files[fi];
                const end = Math.min(e, bases[fi] + f.size);
                const fh = await open(f.path, "r");
                try {
                    for (let q = p; q < end; q += a.chunkSize) {
                        if (a.dead) throw ABORT;
                        const r = Math.min(end, q + a.chunkSize);
                        const buf = Buffer.alloc(r - q);
                        await fh.read(buf, 0, r - q, q - bases[fi]);
                        const c = await pickChannel(a);
                        sendChunk(a, c, q, buf);
                    }
                } finally {
                    await fh.close();
                }
                p = end;
            }
        }
        sendCtl(a, { t: "eof" });
    };

    const addStripe = (a, k) => {
        const pc = new RTCPeerConnection(rtcConfig([...stunServers, ...turn]));
        const c = { pc, dc: null, used: false };
        a.conns[k] = c;
        pc.onconnectionstatechange = () => {
            dbg?.(`send stripe ${k} pc: ${pc.connectionState}`);
            if (pc.connectionState === "failed" && c.used && !a.dead) {
                teardown(a); // the streaming loop notices on its next chunk
            }
        };
        const ch = pc.createDataChannel(`freedrop-${k}`, { ordered: true });
        ch.binaryType = "arraybuffer";
        ch.bufferedAmountLowThreshold = LOW_WATER;
        ch.onbufferedamountlow = () => { a.drainResolve?.(); a.drainResolve = null; };
        ch.onopen = () => { dbg?.(`send stripe ${k} dc open`); c.dc = ch; };
        ch.onclose = () => dbg?.(`send stripe ${k} dc closed`);
        ch.onerror = (e) => dbg?.(`send stripe ${k} dc error: ${e?.error ?? e}`);
        pc.onicecandidate = (e) => {
            if (e.candidate) room.send({ sid: a.sid, t: "ice", conn: k, candidate: candJson(e.candidate) });
        };
        (async () => {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            room.send({ sid: a.sid, t: "offer", conn: k, sdp: pc.localDescription.sdp, ice: turn });
        })().catch(() => {}); // a stripe that never opens is not fatal
    };

    const beginAttempt = (sid, connsWanted, peerNat) => {
        // stripes need native engines on both ends; werift ends say 1
        const maxConns = native ? Math.min(connsWanted ?? 1, STRIPE_CONNS) : 1;
        const a = {
            sid, conns: [], ice: new IceInbox(), dead: false, streaming: false,
            drainResolve: null, chunkSize: 16 * 1024 - 9, peerNat,
        };
        at = a;
        status("receiver found, connecting…");
        dbg?.(`receiver nat: ${JSON.stringify(peerNat)}`);
        const pc = new RTCPeerConnection(rtcConfig([...stunServers, ...turn]));
        const c0 = { pc, dc: null, used: true };
        a.conns[0] = c0;
        pc.onconnectionstatechange = () => {
            dbg?.(`send conn 0 pc: ${pc.connectionState}`);
            if (pc.connectionState === "connected") dbg?.(`send conn 0 path: ${pathOf(pc)}`);
            if (pc.connectionState === "failed" && !a.dead) {
                teardown(a);
                if (at === a && acceptedEver) {
                    status("receiver lost — waiting for a reconnect…  (Ctrl-C to stop)");
                } else if (at === a) {
                    natFailed = true;
                    status("");
                    const hint = natHint(a.peerNat);
                    console.error(`${hint}\nstill waiting — a receiver retry may get through…`);
                    emit({ event: "status", message: hint.trim() });
                }
            }
        };
        const dc = pc.createDataChannel("freedrop", { ordered: true });
        dc.binaryType = "arraybuffer";
        dc.bufferedAmountLowThreshold = LOW_WATER;
        dc.onbufferedamountlow = () => { a.drainResolve?.(); a.drainResolve = null; };
        dc.onclose = () => {
            dbg?.("send conn 0 dc closed");
            if (!a.dead && !done) {
                teardown(a);
                if (at === a && acceptedEver) status("receiver lost — waiting for a reconnect…  (Ctrl-C to stop)");
            }
        };
        dc.onmessage = (ev) => {
            const { msg: m } = parseFrame(ev.data);
            if (!m) return;
            if (m.t === "accept") {
                if (a.streaming) return; // duplicate accept must not restart
                a.streaming = true;
                acceptedEver = true;
                streamAll(a, m.have).catch((e) => {
                    if (e === ABORT) {
                        if (at === a) status("receiver lost — waiting for a reconnect…  (Ctrl-C to stop)");
                    } else die(`\nsend failed: ${e.message}`);
                });
            } else if (m.t === "more") {
                streamMore(a, m.have).catch((e) => {
                    if (e === ABORT) {
                        if (at === a) status("receiver lost — waiting for a reconnect…  (Ctrl-C to stop)");
                    } else die(`\nsend failed: ${e.message}`);
                });
            } else if (m.t === "done") {
                done = true;
                const secs = ((Date.now() - t0.v) / 1000).toFixed(1);
                status("");
                say(`✓ sent ${fmtSize(total)} in ${secs}s — verified by the receiver`);
                emit({ event: "done", total, seconds: Number(secs) });
                teardown(a);
                room.close();
                setTimeout(() => process.exit(0), 300);
            } else if (m.t === "reject") {
                die("\nreceiver declined the transfer", EXIT.declined);
            }
        };
        dc.onopen = () => {
            c0.dc = dc;
            dc.send(jframe({
                t: "manifest",
                files: files.map(({ name, size, mtime }) => ({ name, size, mtime })),
            }));
        };
        pc.onicecandidate = (e) => {
            if (e.candidate) room.send({ sid: a.sid, t: "ice", candidate: candJson(e.candidate) });
        };
        (async () => {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            // TURN rides along so the receiving side gets a relay path too
            room.send({ sid: a.sid, t: "offer", sdp: pc.localDescription.sdp, ice: turn, nat: natHere });
        })().catch((e) => { if (at === a && !a.dead) die(`webrtc: ${e.message}`); });
        if (total >= STRIPE_MIN) {
            for (let k = 1; k < maxConns; k++) addStripe(a, k);
        }
    };

    room.onmessage = (msg) => {
        if (msg.t === "hello") {
            // same sid again is the receiver's periodic re-hello — ignore
            // unless that attempt is already dead. A new sid supersedes:
            // whoever holds the code is the receiver, and a reconnecting
            // receiver arrives with a fresh sid.
            if (at && !at.dead && msg.sid === at.sid) return;
            teardown(at);
            beginAttempt(msg.sid, msg.conns, natOf(msg.nat));
        } else if (!at || msg.sid !== at.sid) {
            // stale attempt traffic
        } else if (msg.t === "answer") {
            const k = msg.conn ?? 0;
            if (k === 0) {
                at.chunkSize = chunkFor(msg.sdp);
                at.peerNat = natOf(msg.nat) ?? at.peerNat;
            }
            const pc = at.conns[k]?.pc;
            if (pc) at.ice.setRemoteDescription(k, pc, { type: "answer", sdp: msg.sdp }).catch(() => {});
        } else if (msg.t === "ice") {
            at.ice.add(msg.conn ?? 0, msg.candidate);
        } else if (msg.t === "nat") {
            // a page's probe can finish after its hello and answer went out
            at.peerNat = natOf(msg.nat) ?? at.peerNat;
            dbg?.(`receiver nat: ${JSON.stringify(at.peerNat)}`);
        }
    };
}

// ---- receive ----------------------------------------------------------------
// Positional writes keyed by global offset land in an opaque staging
// directory — .freedrop-stage/<rid>/<slot>.part plus a per-slot range
// journal, flushed atomically twice a second. Identity is structural:
// the rid names the transfer (a hash of the code), the slot is the
// file's manifest index, so resume never matches filenames and staging
// never shares the user-visible namespace (no ".part" suffix can ever
// alias a legitimate file). When a slot is fully covered AND its hash
// frame has arrived, the stage is re-read, verified, and only then
// renamed to a final name chosen at that moment; the whole staging
// directory disappears once the transfer completes. Connection loss at
// any point tears down the attempt and re-hellos — the same journals
// drive the accept {have} of the next attempt, in this process or a
// later one.

async function receive(code) {
    // a prompt nobody can answer would wait forever — refuse up front,
    // before the sender sees a receiver that will never accept
    if (!flags.yes && !process.stdin.isTTY) {
        die("stdin is not a terminal, so nothing can answer the save prompt.\n" +
            "pass -y to receive without asking.", EXIT.usage);
    }
    const startedAt = Date.now();
    const key = b64u.decode(code);
    const outDir = flags.out ?? ".";
    // the staging directory is named by a hash of the code — never the
    // code itself (it sits on disk) — so unrelated transfers into the
    // same directory get disjoint staging by construction
    const rid = createHash("sha256").update(`freedrop-stage:${code}`).digest("hex").slice(0, 20);
    const stageRoot = join(outDir, ".freedrop-stage");
    const stageDir = join(stageRoot, rid);
    const probing = probeNat(); // in parallel with the broker connection
    const turnExtra = await turnServers().catch((e) => die(`--turn: ${e.message}`));
    const waitMs = Math.min(10_000, Math.max(1, CONNECT_WINDOW - (Date.now() - startedAt)));
    const room = await SignalRoom.create({ key, role: "viewer", brokers: BROKERS, waitMs })
        .catch((e) => die(`cannot reach any rendezvous broker: ${e.message}`, EXIT.broker));

    // ---- transfer state (survives attempts) ----
    let manifest = null;
    let files = null; // ledger: { i, name, size, mtime, base, path, resumed, fh, opening, ranges, covered, dirty, sha, finalizing, done }
    let total = 0;
    let coveredTotal = 0;
    let completed = 0;
    let t0 = 0;
    let acceptedEver = false;
    let finished = false;
    let pendingWrites = 0;
    let moreRounds = 0;
    let coveredAtEof = -1;
    let stagedOnce = false;
    const taken = new Set(); // final paths claimed by this run's landings

    // ---- attempt state ----
    let at = null; // { sid, pcs: [{ pc, ch, rx, last }], dc, gotOffer }
    let senderFound = false;
    let peerNat = null; // the sender's probe verdict, from its offer
    let disconnectedAt = 0;
    let lastData = Date.now();

    const partPath = (f) => join(stageDir, `${f.i}.part`);
    const statePath = (f) => join(stageDir, `${f.i}.json`);

    const flushStates = () => {
        for (const f of files ?? []) {
            if (!f.dirty || f.done) continue;
            try { // atomic: a torn journal must parse as garbage, not lie
                const tmp = statePath(f) + ".tmp";
                writeFileSync(tmp, JSON.stringify({
                    v: 3, name: f.name, size: f.size, mtime: f.mtime, ranges: f.ranges,
                }));
                renameSync(tmp, statePath(f));
                f.dirty = false; // only a landed journal counts as flushed
            } catch {}
        }
    };

    // the partial data lives in outDir — a re-run without the same -o
    // would start over somewhere else
    const resumeHint = () =>
        `\n${fmtSize(coveredTotal)} of ${fmtSize(total)} is saved.\n` +
        `resume by re-running:  freedrop${flags.yes ? " -y" : ""}` +
        `${flags.out ? ` -o ${shellQuote(flags.out)}` : ""} ${code}`;

    onSignals(() => {
        try { flushStates(); } catch {}
        if (acceptedEver && !finished) console.error(resumeHint());
    });

    const giveUp = () => {
        flushStates();
        status("");
        die("connection lost and could not be re-established." + (acceptedEver ? resumeHint() : ""), EXIT.lost);
    };

    // the journal for one manifest slot, if it is valid for this
    // manifest entry. Metadata (name/size/mtime) is a VALIDITY check —
    // identity is the slot itself, so nothing here ever matches
    // filenames or other transfers' staging. Invalid slots are
    // reclaimed on sight. Landing is a two-state transaction: claiming
    // is written before the atomic link/rename, landed afterwards. A
    // crash at either boundary can therefore be distinguished from an
    // unrelated same-name file without trusting the old working directory.
    const loadSlot = (i, mf) => {
        const sp = join(stageDir, `${i}.json`);
        const pp = join(stageDir, `${i}.part`);
        let st = null;
        try { st = JSON.parse(readFileSync(sp, "utf8")); } catch {}
        if (st && st.v === 3 && st.name === mf.name && st.size === mf.size && st.mtime === mf.mtime) {
            // New markers persist only a basename; legacy v3 markers are
            // migrated by taking their basename too. Both resolve against
            // THIS run's outDir, never the process cwd that wrote the marker.
            const rawFinal = typeof st.finalName === "string" ? st.finalName
                : typeof st.path === "string" ? basename(st.path) : null;
            const finalName = rawFinal && basename(rawFinal) === rawFinal ? rawFinal : null;
            const fp = finalName ? join(outDir, finalName) : null;
            const partExists = existsSync(pp);
            let finalExists = false;
            try { finalExists = !!fp && statSync(fp).size === mf.size; } catch {}

            if (finalExists && st.done) {
                // A committed marker is authoritative. For a legacy marker
                // that may have been written before an EEXIST result, require
                // either no stage (rename landed) or the same inode (link landed).
                if (st.landed || !partExists) return { done: true, path: fp };
                try {
                    const a = statSync(pp);
                    const b = statSync(fp);
                    if (a.dev === b.dev && a.ino === b.ino) return { done: true, path: fp };
                } catch {}
            }
            if (finalExists && st.claiming) {
                // rename success removes the stage; link success leaves the
                // same inode at both paths until the committed marker lands.
                if (!partExists) return { done: true, path: fp };
                try {
                    const a = statSync(pp);
                    const b = statSync(fp);
                    if (a.dev === b.dev && a.ino === b.ino) return { done: true, path: fp };
                } catch {}
            }
            if (partExists) {
                return { ranges: st.done || st.claiming ? [[0, mf.size]] : cleanRanges(st.ranges, mf.size) };
            }
        }
        // invalid or stale — reclaimed at accept time, never before the
        // user consents (a declined offer must not cost staged data)
        return null;
    };

    const acquireStageLock = () => {
        const lockPath = join(stageDir, "lock");
        const busy = "\nanother freedrop is already receiving this transfer into this directory.\nrun one receiver at a time.";
        try { acquireLeaseLock(lockPath, { waitMs: 3000, pollMs: 100 }); }
        catch (e) {
            if (e.code === "ELOCKED") die(busy);
            die(`\ncannot acquire the staging lock: ${e.message}`);
        }
    };

    const writeLandingState = (f, state) => {
        const tmp = statePath(f) + ".tmp";
        writeFileSync(tmp, JSON.stringify({
            v: 3, name: f.name, size: f.size, mtime: f.mtime, ...state,
        }));
        renameSync(tmp, statePath(f));
    };

    // Land a verified stage under a final name. Hard links provide an
    // atomic no-replace claim where supported. Filesystems without them
    // serialize all freedrop landings under stageRoot, re-check the name,
    // then rename the already-verified stage atomically — no clean-name
    // destination is ever visible half-copied.
    const land = (f) => {
        const safe = basename(f.name);
        for (let n = 0; ; n++) {
            const dot = safe.lastIndexOf(".");
            const finalName = n === 0 ? safe
                : dot > 0 ? `${safe.slice(0, dot)}(${n})${safe.slice(dot)}` : `${safe}(${n})`;
            const cand = join(outDir, finalName);
            if (taken.has(cand)) continue;

            // PRECONDITION marker. A crash before the claim resumes from the
            // full stage; a crash after link/rename is recognized by inode or
            // by the stage path having disappeared.
            writeLandingState(f, { claiming: true, finalName });
            let linked = false;
            try {
                linkSync(partPath(f), cand);
                linked = true;
            } catch (e) {
                if (e.code === "EEXIST") continue;
                let release = null;
                try {
                    release = acquireLeaseLock(join(stageRoot, ".land-lock"), {
                        waitMs: 10_000, pollMs: 25,
                    });
                    if (existsSync(cand)) continue;
                    try { renameSync(partPath(f), cand); }
                    catch (moveErr) {
                        if (moveErr.code === "EXDEV") {
                            throw new Error(
                                "the staging directory and output directory are on different filesystems",
                            );
                        }
                        throw moveErr;
                    }
                    // Commit while the cross-transfer name lock is still held.
                    writeLandingState(f, { done: true, landed: true, finalName });
                } finally {
                    release?.();
                }
            }
            if (linked) {
                writeLandingState(f, { done: true, landed: true, finalName });
                rmSync(partPath(f), { force: true });
            }
            taken.add(cand);
            return cand;
        }
    };

    // the manifest only ever arrives over the DataChannel, so any reply
    // here is guaranteed an open channel (of the current attempt)
    const sendCtl = (obj) => {
        try { at.dc.send(jframe(obj)); } catch {}
    };

    const globalHave = () => {
        const have = [];
        for (const f of files) for (const [s, e] of f.ranges) have.push([f.base + s, f.base + e]);
        return have;
    };

    const finishAll = () => {
        if (finished) return;
        finished = true;
        try { // the stage is spent; the root stays only if other transfers use it
            rmSync(stageDir, { recursive: true, force: true });
            rmdirSync(stageRoot);
        } catch {}
        const notified = at?.dc?.readyState === "open";
        sendCtl({ t: "done" });
        const secs = ((Date.now() - t0) / 1000).toFixed(1);
        status("");
        say(`✓ received ${fmtSize(total)} in ${secs}s — verified`);
        // landing may have picked "name(1).ext" — say where each file went
        for (const f of files) say(`saved: ${f.path}`);
        if (!notified) say("(the sender could not be told — if it is still running, Ctrl-C it)");
        emit({ event: "done", total, seconds: Number(secs) });
        setTimeout(() => {
            teardownAttempt();
            room.close();
            process.exit(0);
        }, 300);
    };

    const fileAt = (offset) => {
        let lo = 0;
        let hi = files.length - 1;
        while (lo < hi) { // last file whose base ≤ offset (skips empty files)
            const mid = (lo + hi + 1) >> 1;
            if (files[mid].base <= offset) lo = mid;
            else hi = mid - 1;
        }
        return files[lo];
    };

    // fully covered + hash arrived → verify, then land it. Verification
    // re-reads the staged .part — or the final file for a done-marker
    // claim, which never skips this step: a source swapped since the
    // last run (same name/size/mtime, new bytes) must fail here, not
    // "succeed" with old ones. A mismatch discards the stage or the
    // marker so the next run starts clean instead of looping forever.
    const maybeFinalize = (f) => {
        if (f.done || f.finalizing || !f.sha || f.covered !== f.size) return;
        f.finalizing = true;
        (async () => {
            await f.opening;
            await f.fh?.close();
            const hasher = new BlockHasher();
            if (f.size > 0) {
                for await (const b of createReadStream(f.inPlace ? f.path : partPath(f))) hasher.update(b);
            }
            if (hasher.digest() !== f.sha) {
                rmSync(statePath(f), { force: true });
                if (f.inPlace) { // keep the old file — it is finished user data
                    die(
                        `\n${basename(f.name)}: the copy received earlier no longer matches ` +
                        "the sender's file (same name/size/mtime, different content).\n" +
                        "re-run to transfer the new version — it will land beside the old one.",
                        EXIT.verify,
                    );
                }
                rmSync(partPath(f), { force: true });
                die(
                    `\n${basename(f.name)}: verification failed — the sender's file changed, ` +
                    "or data was corrupted.\npartial data discarded; re-run to transfer it fresh.",
                    EXIT.verify,
                );
            }
            if (!f.inPlace) f.path = land(f);
            f.done = true;
            emit({ event: "saved", name: basename(f.name), path: resolve(f.path), size: f.size });
            if (++completed === files.length) finishAll();
        })().catch((e) => die(`\n${basename(f.name)}: ${e.message}`));
    };

    const onChunk = (offset, chunk) => {
        const f = fileAt(offset);
        const local = offset - f.base;
        if (local + chunk.length > f.size) die("\ndata outside any file — aborting");
        // late duplicates after verification began, or strays aimed at a
        // done-marker claim (its final file is not writable staging)
        if (f.done || f.finalizing || f.inPlace) return;
        if (!f.opening) {
            // resumed stages reopen in place ("w" would truncate them)
            f.opening = open(partPath(f), f.resumed ? "r+" : "w").then(async (fh) => {
                f.fh = fh;
                await fh.truncate(f.size);
            });
        }
        pendingWrites++;
        f.opening.then(() => f.fh.write(chunk, 0, chunk.length, local)).then(() => {
            pendingWrites--;
            const added = addRange(f.ranges, local, local + chunk.length);
            f.covered += added;
            coveredTotal += added;
            f.dirty = true;
            maybeFinalize(f);
            progressLine("receiving", coveredTotal, total, t0);
        }).catch((e) => die(`\n${basename(f.name)}: ${e.message}`));
    };

    const acceptNow = () => {
        acceptedEver = true;
        if (!t0) t0 = Date.now();
        if (!stagedOnce) {
            stagedOnce = true;
            mkdirSync(stageDir, { recursive: true });
            // two receivers with the same code in one directory would
            // silently corrupt each other's slots — refuse loudly. The
            // directory lease is born atomically; stale-owner deletion is
            // serialized, and creators are excluded throughout recovery.
            acquireStageLock();
            // reclaim stale staging now that the user has accepted:
            // fresh slots' leftovers, and slots beyond this manifest
            try {
                for (const n of readdirSync(stageDir)) {
                    if (n === "lock") continue;
                    const m = /^(\d+)\./.exec(n);
                    const f = m ? files[Number(m[1])] : null;
                    if (!f || (!f.resumed && !f.inPlace && !f.opening)) {
                        rmSync(join(stageDir, n), { force: true });
                    }
                }
            } catch {}
        }
        // empty files get no chunks — stage them right away
        for (const f of files) {
            if (f.size > 0 || f.inPlace || f.opening) continue;
            f.opening = open(partPath(f), "w").then((fh) => { f.fh = fh; });
            maybeFinalize(f);
        }
        sendCtl({ t: "accept", have: globalHave() });
    };

    const onManifest = (m) => {
        if (manifest) {
            // a reconnect re-sends the manifest — it must be the same transfer
            const same = m.files.length === manifest.length && m.files.every((mf, i) =>
                mf.name === manifest[i].name && mf.size === manifest[i].size && mf.mtime === manifest[i].mtime);
            if (!same) die("\nthe sender is now offering a different transfer — aborting");
            if (acceptedEver) acceptNow(); // fresh attempt: re-accept with current coverage
            return;
        }
        manifest = m.files;
        total = manifest.reduce((n, f) => n + f.size, 0);
        let base = 0;
        coveredTotal = 0;
        completed = 0;
        files = manifest.map((mf, i) => {
            const prior = loadSlot(i, mf);
            const inPlace = !!prior?.done; // complete on disk — but it must
            // still prove itself against THIS run's hash: the source may
            // have been swapped since (same name/size/mtime, new bytes)
            const ranges = prior?.ranges ?? (inPlace ? [[0, mf.size]] : []);
            const entry = {
                i, name: mf.name, size: mf.size, mtime: mf.mtime, base,
                path: inPlace ? prior.path : null, // chosen at landing time
                resumed: !!prior && !inPlace, inPlace, fh: null, opening: null, ranges,
                covered: inPlace ? mf.size : coveredBytes(ranges), dirty: false, sha: null,
                finalizing: false, done: false,
            };
            coveredTotal += entry.covered;
            base += mf.size;
            return entry;
        });
        say(`incoming: ${manifest.length} file(s), ${fmtSize(total)}`);
        for (const f of manifest) say(`  ${basename(f.name)}  (${fmtSize(f.size)})`);
        emit({
            event: "incoming",
            files: manifest.map((f) => ({ name: basename(f.name), size: f.size })),
            total, resumed: coveredTotal,
        });
        if (coveredTotal > 0) {
            say(`resuming — ${fmtSize(coveredTotal)} already on disk`);
            return acceptNow(); // the user accepted this transfer once already
        }
        if (flags.yes) return acceptNow();
        const rl = createInterface({ input: process.stdin, output: process.stderr });
        rl.question(`save to ${outDir === "." ? "current directory" : outDir}? [Y/n] `, (a) => {
            rl.close();
            if (/^n/i.test(a.trim())) {
                sendCtl({ t: "reject" });
                die("declined — nothing saved", EXIT.declined);
            }
            acceptNow();
        });
    };

    // eof races the stripes: it rides connection 0 while other stripes
    // may still hold megabytes in flight, so "gaps" at eof are usually
    // just data still in the pipe. Judge only once the pipe has drained,
    // and count only DRY rounds toward the give-up — a round that
    // delivered bytes is progress, not loss.
    const onEof = async () => {
        for (;;) {
            const seen = coveredTotal;
            await new Promise((r) => setTimeout(r, 1500));
            if (coveredTotal === seen && pendingWrites === 0) break;
        }
        if (finished || coveredTotal === total) return;
        if (coveredTotal > coveredAtEof) moreRounds = 0;
        coveredAtEof = coveredTotal;
        if (++moreRounds > 5) die("\ntransfer cannot complete — data lost on every fill round", EXIT.lost);
        dbg?.(`eof with gaps — requesting fill round ${moreRounds}`);
        // gap chunks arrive at lower offsets than the stripes have seen;
        // lift the per-channel replay guard for the new round
        for (const c of at.pcs) if (c) c.last = -1;
        sendCtl({ t: "more", have: globalHave() });
    };

    const onFrame = (c, ev) => {
        const { msg, chunk, offset } = parseFrame(ev.data);
        lastData = Date.now();
        // a manifest only proves the attempt negotiated, not that the
        // transfer progresses — if it cleared the clock, an endless
        // reconnect loop could never reach the give-up window
        if (chunk || msg.t !== "manifest") disconnectedAt = 0;
        if (chunk) {
            if (offset <= c.last) return; // engine replayed a message
            c.last = offset;
            return onChunk(offset, chunk);
        }
        if (msg.t === "manifest") {
            at.gotManifest = true;
            onManifest(msg);
        } else if (msg.t === "hash") {
            const f = files?.[msg.i];
            if (f && !f.done && typeof msg.sha === "string") {
                f.sha = msg.sha;
                maybeFinalize(f);
            }
        } else if (msg.t === "eof") onEof();
    };

    const teardownAttempt = () => {
        if (!at) return;
        const a = at;
        at = null;
        for (const c of a.pcs) { try { c?.pc.close(); } catch {} }
    };

    const startAttempt = () => {
        teardownAttempt();
        at = {
            sid: randomBytes(8).toString("hex"),
            pcs: [], ice: new IceInbox(), dc: null, gotOffer: false, gotManifest: false, lastSignalAt: Date.now(),
        };
        room.send({ sid: at.sid, t: "hello", conns: native ? STRIPE_CONNS : 1, nat: natHere });
    };

    const retry = (why) => {
        if (finished) return;
        dbg?.(`retry: ${why}`);
        const now = Date.now();
        if (!manifest) {
            if (now - startedAt >= CONNECT_WINDOW) {
                if (senderFound) dieNat(peerNat);
                die("no sender found — is `freedrop <files>` still running on the other side?", EXIT.timeout);
            }
            status("connection lost — reconnecting…");
            startAttempt();
            return;
        }
        if (!disconnectedAt) disconnectedAt = now;
        if (now - disconnectedAt > RETRY_WINDOW) return giveUp();
        flushStates();
        status("connection lost — reconnecting…");
        lastData = now; // fresh grace period for the new attempt
        startAttempt();
    };

    room.onmessage = async (msg) => {
        if (!at || msg.sid !== at.sid) return;
        if ((msg.conn ?? 0) === 0 && (msg.t === "offer" || msg.t === "ice")) at.lastSignalAt = Date.now();
        if (msg.t === "offer") {
            const k = msg.conn ?? 0;
            if (at.pcs[k]) return; // replayed offer
            const a = at;
            a.gotOffer = true;
            if (k === 0) {
                senderFound = true;
                peerNat = natOf(msg.nat) ?? peerNat;
                dbg?.(`sender nat: ${JSON.stringify(peerNat)}`);
                status(manifest ? "reconnected…" : "sender found, connecting…");
            }
            const pc = new RTCPeerConnection(rtcConfig([...stunServers, ...(msg.ice ?? []), ...turnExtra]));
            const c = { pc, ch: null, rx: false, last: -1 };
            a.pcs[k] = c;
            pc.onconnectionstatechange = () => {
                dbg?.(`recv conn ${k} pc: ${pc.connectionState}`);
                if (pc.connectionState === "connected") dbg?.(`recv conn ${k} path: ${pathOf(pc)}`);
                if (at !== a || pc.connectionState !== "failed") return;
                if (k === 0 || c.rx) retry(`conn ${k} failed`);
            };
            pc.ondatachannel = (e) => {
                if (at !== a || c.ch) return;
                dbg?.(`recv conn ${k} dc arrived`);
                c.ch = e.channel;
                c.ch.binaryType = "arraybuffer";
                c.ch.onclose = () => {
                    dbg?.(`recv conn ${k} dc closed`);
                    if (at === a && k === 0) retry("control channel closed");
                };
                c.ch.onmessage = (ev) => {
                    if (at !== a) return;
                    c.rx = true;
                    onFrame(c, ev);
                };
                if (k === 0) a.dc = c.ch;
            };
            pc.onicecandidate = (e) => {
                if (at !== a || !e.candidate) return;
                if (k === 0) a.lastSignalAt = Date.now();
                room.send({ sid: a.sid, t: "ice", conn: k, candidate: candJson(e.candidate) });
            };
            (async () => {
                await a.ice.setRemoteDescription(k, pc, { type: "offer", sdp: msg.sdp });
                if (at !== a) return;
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                if (at === a) room.send({ sid: a.sid, t: "answer", conn: k, sdp: pc.localDescription.sdp, nat: natHere });
            })().catch((e) => { if (at === a) retry(`webrtc: ${e.message}`); });
        } else if (msg.t === "ice") {
            at.ice.add(msg.conn ?? 0, msg.candidate);
        } else if (msg.t === "nat") {
            // a page's probe can finish after its offer went out
            peerNat = natOf(msg.nat) ?? peerNat;
            dbg?.(`sender nat: ${JSON.stringify(peerNat)}`);
        }
    };

    // journal flush — small, atomic, twice a second while data flows
    const flushTimer = setInterval(flushStates, 500);
    flushTimer.unref?.();

    // hello re-send until an offer lands: covers a sender that starts (or
    // restarts) after us, and a first hello lost in broker weather
    const helloTimer = setInterval(() => {
        if (at && !at.gotOffer && !finished) {
            room.send({ sid: at.sid, t: "hello", conns: native ? STRIPE_CONNS : 1, nat: natHere });
        }
    }, 5000);
    helloTimer.unref?.();

    // liveness: data stalls mean a dead peer far more often than a slow
    // one — tear down and re-negotiate; the journal makes it cheap. Once
    // everything is covered and every hash is in, the rest is local work
    // and no timer should touch it.
    const healthTimer = setInterval(() => {
        if (finished || !at) return;
        const now = Date.now();
        if (!at.gotManifest) {
            if ((!manifest && now - startedAt >= CONNECT_WINDOW) || now - at.lastSignalAt >= HANDSHAKE_TIMEOUT) retry("handshake timeout");
            return;
        }
        if (!acceptedEver) return; // waiting at the prompt is not a stall
        const allShaKnown = files.every((f) => f.done || f.sha);
        if (coveredTotal === total && allShaKnown) return; // verifying locally
        const grace = coveredTotal === total ? 30_000 : 20_000;
        if (now - lastData > grace) retry("no data");
    }, 1000);
    healthTimer.unref?.();

    await probing;
    startAttempt();
}

// ---- dispatch ---------------------------------------------------------------

if (rest.length === 0) {
    console.log(HELP);
    process.exit(0);
}
if (rest.every((f) => existsSync(f) && statSync(f).isFile())) {
    await send(rest);
} else if (rest.length === 1 && codeOf(rest[0])) {
    await receive(codeOf(rest[0]));
} else {
    for (const f of rest) {
        if (!existsSync(f) && !codeOf(f)) {
            die(`"${f}" is neither an existing file nor a receive code`, EXIT.usage);
        }
        if (existsSync(f) && !statSync(f).isFile()) {
            die(`"${f}" is not a regular file (directories: tar it for now)`, EXIT.usage);
        }
    }
    die("mixed arguments — pass files to send, or one code to receive", EXIT.usage);
}
