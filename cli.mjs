#!/usr/bin/env node
// freedrop — direct file transfer between CLIs and browsers.
//
// The code is a 256-bit key. Both ends derive a rendezvous room from it
// (public MQTT brokers, AES-256-GCM — brokers see ciphertext only) and
// exchange WebRTC SDP/ICE there. The file bytes travel exclusively over
// the WebRTC DataChannel: direct P2P, DTLS-encrypted, never through any
// server. TURN (--turn) is the opt-in relay for NATs P2P can't punch.

import { createReadStream, existsSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { basename, join } from "node:path";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import qrcode from "qrcode-terminal";
import { SignalRoom, b64u, DEFAULT_BROKERS } from "./signal.mjs";

const PAGE = process.env.FREEDROP_PAGE ?? "https://freedrop.dev/";

const STUN = [
    { urls: "stun:stun.cloudflare.com:3478" },
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun.miwifi.com:3478" }, // reachable from mainland China
];

const HELP = `freedrop — send files directly, CLI or browser, no server in the path

Usage:
  freedrop <file> [more files…]     send
  freedrop <code>                   receive (code comes from the sender)

Options:
  -y, --yes             receive without asking
  -o, --out <dir>       save received files here     (default current dir)
      --turn <target>   TURN relay for NATs P2P can't punch: "cloudflare"
                        (reads CF_TURN_KEY_ID + CF_TURN_API_TOKEN) or a
                        turn:/turns: URL used with --turn-auth
      --turn-auth <u:p> credentials for a --turn URL
      --broker <list>   comma-separated wss:// MQTT brokers to rendezvous on
      --no-qr           don't print the QR code
  -h, --help            show this help
  -v, --version         show version

The receiver can also be any browser: the sender prints a link.
Docs: https://github.com/tiann/freedrop`;

// ---- tiny arg parser -------------------------------------------------------

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
        else if (a === "--turn") flags.turn = argv[++i];
        else if (a === "--turn-auth") flags.turnAuth = argv[++i];
        else if (a === "--broker") flags.broker = argv[++i];
        else if (a.startsWith("-")) {
            console.error(`unknown option: ${a}\nrun freedrop --help for usage`);
            process.exit(1);
        } else rest.push(a);
    }
}

const BROKERS = flags.broker
    ? flags.broker.split(",").map((s) => s.trim()).filter(Boolean)
    : DEFAULT_BROKERS;

if (typeof WebSocket === "undefined") {
    console.error("freedrop needs Node 22+ (built-in WebSocket)");
    process.exit(1);
}

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

const candJson = (c) =>
    c.toJSON ? c.toJSON() : { candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex };

// ---- TURN (same forms as tango-mirror, minus the relay) ---------------------

async function turnServers() {
    const t = flags.turn;
    if (!t) return [];
    if (t === "cloudflare") {
        const { CF_TURN_KEY_ID, CF_TURN_API_TOKEN } = process.env;
        if (!CF_TURN_KEY_ID || !CF_TURN_API_TOKEN) {
            console.error("--turn cloudflare needs CF_TURN_KEY_ID and CF_TURN_API_TOKEN in the environment");
            process.exit(1);
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
        if (at < 0) {
            console.error("--turn with a turn:/turns: URL needs --turn-auth user:pass");
            process.exit(1);
        }
        return [{
            urls: t.split(",").map((u) => u.trim()),
            username: flags.turnAuth.slice(0, at),
            credential: flags.turnAuth.slice(at + 1),
        }];
    }
    console.error(`--turn: expected "cloudflare" or a turn:/turns: URL, got "${t}"`);
    process.exit(1);
}

// ---- wire framing -----------------------------------------------------------
// Every DataChannel message is binary. Tag 1 = UTF-8 JSON control message;
// tag 0 = file bytes, followed by an 8-byte offset into the transfer's
// global byte range (files concatenated in manifest order). The offset
// lets chunks land positionally from any stripe, lets the receiver drop
// duplicates — werift's receive path replays messages under load, and a
// channel's offsets only ever grow — and is the foundation for resume.

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

// ---- progress + formatting --------------------------------------------------

const fmtSize = (n) =>
    n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(2)} GB`
    : n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB`
    : n >= 1024 ? `${(n / 1024).toFixed(0)} KB`
    : `${n} B`;

const status = (line) => process.stderr.write(`\r\x1b[K${line}`);

// redrawing per chunk costs real throughput at these rates — throttle
let lastDraw = 0;
function progressLine(verb, done, total, t0) {
    const now = Date.now();
    if (now - lastDraw < 100 && done !== total) return;
    lastDraw = now;
    const secs = (now - t0) / 1000;
    const rate = secs > 0.2 ? `  ${fmtSize(done / secs)}/s` : "";
    const pct = total ? ` ${Math.floor((done / total) * 100)}%` : "";
    status(`${verb}${pct}  ${fmtSize(done)} / ${fmtSize(total)}${rate}`);
}

// P2P failure is the one error users will actually hit — explain it
function watchConnection(pc, onFatal) {
    pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed") {
            onFatal(
                "\nWebRTC could not connect (symmetric NAT or CGNAT on both ends?).\n" +
                "Retry with a TURN relay on the SENDING side: --turn cloudflare\n" +
                "(free 1 TB/month — see the README)",
            );
        }
    };
}

const die = (msg) => {
    console.error(msg);
    process.exit(1);
};

const dbg = process.env.FREEDROP_DEBUG ? (...a) => console.error("\n[dbg]", ...a) : null;

// ---- send -------------------------------------------------------------------

async function send(paths) {
    const files = paths.map((p) => ({ path: p, name: basename(p), size: statSync(p).size }));
    const total = files.reduce((n, f) => n + f.size, 0);
    const key = randomBytes(32);
    const code = b64u.encode(new Uint8Array(key));
    const turn = await turnServers();

    const room = await SignalRoom.create({ key, role: "host", brokers: BROKERS })
        .catch((e) => die(`cannot reach any rendezvous broker: ${e.message}`));

    console.log(`freedrop: ${files.length} file(s), ${fmtSize(total)}`);
    for (const f of files) console.log(`  ${f.name}  (${fmtSize(f.size)})`);
    console.log(`\nreceive with:   npx freedrop ${code}`);
    const link = `${PAGE}#${code}`;
    console.log(`or in browser:  ${link}\n`);
    if (!flags.noQr) qrcode.generate(link, { small: true }, (art) => console.log(art));
    console.log("waiting for receiver…  (Ctrl-C to cancel)");

    let sid = null;
    let dc = null; // control channel (connection 0)
    let chunkSize = 16 * 1024 - 1;
    let drainResolve = null;
    const t0 = { v: 0 };
    // conns[k]: one WebRTC connection per stripe; conns[0] also carries
    // control. A stripe joins the pool when its channel opens; one that
    // dies unused is just ignored, one that dies after carrying data
    // aborts the transfer — its bytes may be gone.
    const conns = [];

    const cleanupAndExit = (code_) => {
        for (const c of conns) { try { c?.pc.close(); } catch {} }
        room.close();
        process.exit(code_);
    };

    const openPool = () => {
        const open = [];
        for (const c of conns) {
            if (!c) continue;
            if (c.dc?.readyState === "open") open.push(c);
            else if (c.used) die("\nconnection lost mid-transfer");
        }
        if (!open.length) die("\nconnection lost mid-transfer");
        return open;
    };

    // least-buffered open stripe; parks when every stripe is above the mark
    const pickChannel = async () => {
        for (;;) {
            const open = openPool();
            let best = open[0];
            for (const c of open) if (c.dc.bufferedAmount < best.dc.bufferedAmount) best = c;
            if (best.dc.bufferedAmount <= HIGH_WATER) return best;
            await new Promise((r) => { drainResolve = r; });
        }
    };

    // files stream back to back as one byte range — offsets are global
    // (manifest order), chunks fan out over every open stripe, and nothing
    // waits per file: completion is the receiver's side of the ledger.
    const startStreaming = async () => {
        t0.v = Date.now();
        let sent = 0;
        let base = 0;
        for (const f of files) {
            let local = 0;
            for await (const block of createReadStream(f.path, { highWaterMark: 4 * 1024 * 1024 })) {
                for (let p = 0; p < block.length; p += chunkSize) {
                    const payload = block.subarray(p, p + chunkSize);
                    const c = await pickChannel();
                    c.used = true;
                    c.dc.send(chunkFrame(base + local, payload));
                    local += payload.length;
                    sent += payload.length;
                    progressLine("sending", sent, total, t0.v);
                }
            }
            base += f.size;
        }
    };

    const addStripe = (k) => {
        const pc = new RTCPeerConnection({ iceServers: [...STUN, ...turn] });
        const c = { pc, dc: null, used: false };
        conns[k] = c;
        pc.onconnectionstatechange = () => {
            dbg?.(`send stripe ${k} pc: ${pc.connectionState}`);
            if (pc.connectionState === "failed" && c.used) die("\nstripe connection lost mid-transfer");
        };
        const ch = pc.createDataChannel(`freedrop-${k}`, { ordered: true });
        ch.binaryType = "arraybuffer";
        ch.bufferedAmountLowThreshold = LOW_WATER;
        ch.onbufferedamountlow = () => { drainResolve?.(); drainResolve = null; };
        ch.onopen = () => { dbg?.(`send stripe ${k} dc open`); c.dc = ch; };
        ch.onclose = () => dbg?.(`send stripe ${k} dc closed`);
        ch.onerror = (e) => dbg?.(`send stripe ${k} dc error: ${e?.error ?? e}`);
        pc.onicecandidate = (e) => {
            if (e.candidate) room.send({ sid, t: "ice", conn: k, candidate: candJson(e.candidate) });
        };
        (async () => {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            room.send({ sid, t: "offer", conn: k, sdp: pc.localDescription.sdp, ice: turn });
        })().catch(() => {}); // a stripe that never opens is not fatal
    };

    room.onmessage = (msg) => {
        if (msg.t === "hello" && !sid) {
            sid = msg.sid;
            // stripes need native engines on both ends; werift ends say 1
            const maxConns = native ? Math.min(msg.conns ?? 1, STRIPE_CONNS) : 1;
            status("receiver found, connecting…");
            const pc = new RTCPeerConnection({ iceServers: [...STUN, ...turn] });
            const c0 = { pc, dc: null, used: true };
            conns[0] = c0;
            watchConnection(pc, die);
            dc = pc.createDataChannel("freedrop", { ordered: true });
            dc.binaryType = "arraybuffer";
            dc.bufferedAmountLowThreshold = LOW_WATER;
            dc.onbufferedamountlow = () => { drainResolve?.(); drainResolve = null; };
            let streaming = false;
            dc.onmessage = (ev) => {
                const { msg: m } = parseFrame(ev.data);
                if (!m) return;
                if (m.t === "accept") {
                    if (streaming) return; // duplicate accept must not restart
                    streaming = true;
                    startStreaming().catch((e) => die(`\nsend failed: ${e.message}`));
                }
                else if (m.t === "done") {
                    const secs = ((Date.now() - t0.v) / 1000).toFixed(1);
                    status("");
                    console.log(`✓ sent ${fmtSize(total)} in ${secs}s`);
                    setTimeout(() => cleanupAndExit(0), 300);
                } else if (m.t === "reject") {
                    die("\nreceiver declined the transfer");
                }
            };
            dc.onopen = () => {
                c0.dc = dc;
                dc.send(jframe({ t: "manifest", files: files.map(({ name, size }) => ({ name, size })) }));
            };
            pc.onicecandidate = (e) => {
                if (e.candidate) room.send({ sid, t: "ice", candidate: candJson(e.candidate) });
            };
            (async () => {
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                // TURN rides along so the receiving side gets a relay path too
                room.send({ sid, t: "offer", sdp: pc.localDescription.sdp, ice: turn });
            })().catch((e) => die(`webrtc: ${e.message}`));
            if (total >= STRIPE_MIN) {
                for (let k = 1; k < maxConns; k++) addStripe(k);
            }
        } else if (msg.sid !== sid) {
            // single-receiver semantics: whoever said hello first wins
        } else if (msg.t === "answer") {
            const k = msg.conn ?? 0;
            if (k === 0) chunkSize = chunkFor(msg.sdp);
            conns[k]?.pc.setRemoteDescription({ type: "answer", sdp: msg.sdp }).catch(() => {});
        } else if (msg.t === "ice") {
            conns[msg.conn ?? 0]?.pc.addIceCandidate(msg.candidate).catch(() => {});
        }
    };
}

// ---- receive ----------------------------------------------------------------

async function receive(code) {
    const key = b64u.decode(code);
    const outDir = flags.out ?? ".";
    const turnExtra = await turnServers();
    const room = await SignalRoom.create({ key, role: "viewer", brokers: BROKERS })
        .catch((e) => die(`cannot reach any rendezvous broker: ${e.message}`));

    const sid = randomBytes(8).toString("hex");
    const pcs = []; // conn-index → { pc, ch, rx, last }
    let dc = null; // control channel (connection 0)
    let manifest = null;
    let files = null; // ledger: { i, size, base, path, fh, opening, written, closing }
    let completed = 0;
    let totalReceived = 0;
    let total = 0;
    let t0 = 0;
    const taken = new Set(); // paths reserved before their files exist

    const offerTimer = setTimeout(
        () => die("no sender found — is `freedrop <files>` still running on the other side?"),
        20_000,
    );

    // avoid clobbering: aaa.txt -> aaa(1).txt
    const freshPath = (name) => {
        const safe = basename(name);
        let p = join(outDir, safe);
        for (let n = 1; existsSync(p) || taken.has(p); n++) {
            const dot = safe.lastIndexOf(".");
            p = join(outDir, dot > 0 ? `${safe.slice(0, dot)}(${n})${safe.slice(dot)}` : `${safe}(${n})`);
        }
        taken.add(p);
        return p;
    };

    // the manifest only ever arrives over the DataChannel, so any reply
    // here is guaranteed an open channel
    const sendCtl = (obj) => dc.send(jframe(obj));

    const finish = () => {
        sendCtl({ t: "done" });
        const secs = ((Date.now() - t0) / 1000).toFixed(1);
        status("");
        console.log(`✓ received ${fmtSize(totalReceived)} in ${secs}s`);
        setTimeout(() => {
            for (const c of pcs) { try { c?.pc.close(); } catch {} }
            room.close();
            process.exit(0);
        }, 300);
    };

    // ---- positional writes keyed by global offset --------------------------
    // Chunks may arrive on any stripe in any relative order; each lands at
    // its offset in a preallocated file. A file is done when every byte of
    // it has been written — there are no per-file control frames.

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

    const maybeClose = (f) => {
        if (f.written !== f.size || f.closing) return;
        f.closing = true;
        f.opening.then(() => f.fh.close()).then(() => {
            if (++completed === files.length) finish();
        }).catch((e) => die(`\n${basename(f.path)}: ${e.message}`));
    };

    const onChunk = (offset, chunk) => {
        const f = fileAt(offset);
        const local = offset - f.base;
        if (local + chunk.length > f.size) die("\ndata outside any file — aborting");
        if (!f.opening) {
            f.opening = open(f.path, "w").then(async (fh) => {
                f.fh = fh;
                await fh.truncate(f.size);
            });
        }
        f.opening.then(() => f.fh.write(chunk, 0, chunk.length, local)).then(() => {
            f.written += chunk.length;
            maybeClose(f);
        }).catch((e) => die(`\n${basename(f.path)}: ${e.message}`));
        totalReceived += chunk.length;
        progressLine("receiving", totalReceived, total, t0);
    };

    const onFrame = (c, ev) => {
        const { msg, chunk, offset } = parseFrame(ev.data);
        if (chunk) {
            if (offset <= c.last) return; // engine replayed a message
            c.last = offset;
            return onChunk(offset, chunk);
        }
        if (msg.t === "manifest") {
            if (manifest) return; // engines may replay events — accept once
            manifest = msg.files;
            total = manifest.reduce((n, f) => n + f.size, 0);
            let base = 0;
            files = manifest.map((f, i) => {
                const entry = {
                    i, size: f.size, base, path: freshPath(f.name),
                    fh: null, opening: null, written: 0, closing: false,
                };
                base += f.size;
                return entry;
            });
            console.log(`incoming: ${manifest.length} file(s), ${fmtSize(total)}`);
            for (const f of manifest) console.log(`  ${basename(f.name)}  (${fmtSize(f.size)})`);
            const go = () => {
                t0 = Date.now();
                sendCtl({ t: "accept" });
                // empty files get no chunks — create them right away
                for (const f of files) {
                    if (f.size > 0) continue;
                    f.opening = open(f.path, "w").then((fh) => { f.fh = fh; });
                    maybeClose(f);
                }
            };
            if (flags.yes) return go();
            const rl = createInterface({ input: process.stdin, output: process.stderr });
            rl.question(`save to ${outDir === "." ? "current directory" : outDir}? [Y/n] `, (a) => {
                rl.close();
                if (/^n/i.test(a.trim())) {
                    sendCtl({ t: "reject" });
                    process.exit(1);
                }
                go();
            });
        }
    };

    room.onmessage = async (msg) => {
        if (msg.sid !== sid) return;
        if (msg.t === "offer") {
            const k = msg.conn ?? 0;
            if (pcs[k]) return; // replayed offer
            if (k === 0) {
                clearTimeout(offerTimer);
                status("sender found, connecting…");
            }
            const pc = new RTCPeerConnection({ iceServers: [...STUN, ...(msg.ice ?? []), ...turnExtra] });
            const c = { pc, ch: null, rx: false, last: -1 };
            pcs[k] = c;
            if (k === 0) watchConnection(pc, die);
            else pc.onconnectionstatechange = () => {
                dbg?.(`recv stripe ${k} pc: ${pc.connectionState}`);
                // a stripe that already delivered data dying means lost bytes
                if (pc.connectionState === "failed" && c.rx) die("\nstripe connection lost mid-transfer");
            };
            pc.ondatachannel = (e) => {
                if (c.ch) return;
                dbg?.(`recv conn ${k} dc arrived`);
                c.ch = e.channel;
                c.ch.binaryType = "arraybuffer";
                c.ch.onclose = () => dbg?.(`recv conn ${k} dc closed`);
                c.ch.onmessage = (ev) => {
                    c.rx = true;
                    onFrame(c, ev);
                };
                if (k === 0) dc = c.ch;
            };
            pc.onicecandidate = (e) => {
                if (e.candidate) room.send({ sid, t: "ice", conn: k, candidate: candJson(e.candidate) });
            };
            (async () => {
                await pc.setRemoteDescription({ type: "offer", sdp: msg.sdp });
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                room.send({ sid, t: "answer", conn: k, sdp: pc.localDescription.sdp });
            })().catch((e) => die(`webrtc: ${e.message}`));
        } else if (msg.t === "ice") {
            pcs[msg.conn ?? 0]?.pc.addIceCandidate(msg.candidate).catch(() => {});
        }
    };

    room.send({ sid, t: "hello", conns: native ? STRIPE_CONNS : 1 });
}

// ---- dispatch ---------------------------------------------------------------

const looksLikeCode = (s) => /^[A-Za-z0-9_-]{40,48}$/.test(s);

if (rest.length === 0) {
    console.log(HELP);
    process.exit(0);
}
if (rest.every((f) => existsSync(f) && statSync(f).isFile())) {
    await send(rest);
} else if (rest.length === 1 && looksLikeCode(rest[0])) {
    await receive(rest[0]);
} else {
    for (const f of rest) {
        if (!existsSync(f) && !looksLikeCode(f)) {
            die(`"${f}" is neither an existing file nor a receive code`);
        }
        if (existsSync(f) && !statSync(f).isFile()) {
            die(`"${f}" is not a regular file (directories: tar it for now)`);
        }
    }
    die("mixed arguments — pass files to send, or one code to receive");
}
