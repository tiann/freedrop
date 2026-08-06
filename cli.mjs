#!/usr/bin/env node
// freedrop — direct file transfer between CLIs and browsers.
//
// The code is a 256-bit key. Both ends derive a rendezvous room from it
// (public MQTT brokers, AES-256-GCM — brokers see ciphertext only) and
// exchange WebRTC SDP/ICE there. The file bytes travel exclusively over
// the WebRTC DataChannel: direct P2P, DTLS-encrypted, never through any
// server. TURN (--turn) is the opt-in relay for NATs P2P can't punch.

import { createReadStream, createWriteStream, existsSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { RTCPeerConnection } from "werift";
import qrcode from "qrcode-terminal";
import { SignalRoom, b64u, DEFAULT_BROKERS } from "./signal.mjs";

const PAGE = process.env.FREEDROP_PAGE ?? "https://weishu.me/freedrop/";
const CHUNK = 16 * 1024;             // safe DataChannel message size
const HIGH_WATER = 4 * 1024 * 1024;  // pause the reader above this
const LOW_WATER = 1 * 1024 * 1024;   // resume below this

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

// ---- TURN (same three no-nonsense forms as tango-mirror, minus the relay) --

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

// ---- wire framing: every DataChannel message is binary, 1-byte tag ---------
// 1 = UTF-8 JSON control message, 0 = file bytes. Explicit tagging sidesteps
// the string/binary typing differences between browsers and werift.

const jframe = (obj) => Buffer.concat([Buffer.from([1]), Buffer.from(JSON.stringify(obj))]);

function parseFrame(data) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf[0] === 1) return { msg: JSON.parse(buf.subarray(1).toString()) };
    return { chunk: buf.subarray(1) };
}

// ---- progress + formatting --------------------------------------------------

const fmtSize = (n) =>
    n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(2)} GB`
    : n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB`
    : n >= 1024 ? `${(n / 1024).toFixed(0)} KB`
    : `${n} B`;

const status = (line) => process.stderr.write(`\r\x1b[K${line}`);

function progressLine(verb, done, total, t0) {
    const secs = (Date.now() - t0) / 1000;
    const rate = secs > 0.2 ? `  ${fmtSize(done / secs)}/s` : "";
    const pct = total ? ` ${Math.floor((done / total) * 100)}%` : "";
    status(`${verb}${pct}  ${fmtSize(done)} / ${fmtSize(total)}${rate}`);
}

// P2P failure is the one error users will actually hit — explain it
function watchConnection(pc, onFatal) {
    pc.connectionStateChange.subscribe((state) => {
        if (state === "failed") {
            onFatal(
                "\nWebRTC could not connect (symmetric NAT or CGNAT on both ends?).\n" +
                "Retry with a TURN relay on the SENDING side: --turn cloudflare\n" +
                "(free 1 TB/month — see the README)",
            );
        }
    });
}

const die = (msg) => {
    console.error(msg);
    process.exit(1);
};

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
    let pc = null;
    let dc = null;
    let drainResolve = null;
    let gotResolve = null;
    const t0 = { v: 0 };

    const cleanupAndExit = (code_) => {
        try { pc?.close(); } catch {}
        room.close();
        process.exit(code_);
    };

    const startStreaming = async () => {
        t0.v = Date.now();
        let sent = 0;
        for (let i = 0; i < files.length; i++) {
            const f = files[i];
            dc.send(jframe({ t: "file", i, name: f.name, size: f.size }));
            for await (const chunk of createReadStream(f.path, { highWaterMark: CHUNK })) {
                if (dc.readyState !== "open") die("\nconnection lost mid-transfer");
                if (dc.bufferedAmount > HIGH_WATER) {
                    await new Promise((r) => { drainResolve = r; });
                }
                dc.send(Buffer.concat([Buffer.from([0]), chunk]));
                sent += chunk.length;
                progressLine("sending", sent, total, t0.v);
            }
            dc.send(jframe({ t: "file-end", i }));
            await new Promise((r) => { gotResolve = r; }); // receiver confirmed
        }
    };

    room.onmessage = (msg) => {
        if (msg.t === "hello" && !sid) {
            sid = msg.sid;
            status("receiver found, connecting…");
            pc = new RTCPeerConnection({ iceServers: [...STUN, ...turn] });
            watchConnection(pc, die);
            dc = pc.createDataChannel("freedrop", { ordered: true });
            dc.bufferedAmountLowThreshold = LOW_WATER;
            dc.bufferedAmountLow.subscribe(() => { drainResolve?.(); drainResolve = null; });
            dc.onMessage.subscribe((data) => {
                const { msg: m } = parseFrame(data);
                if (!m) return;
                if (m.t === "accept") startStreaming().catch((e) => die(`\nsend failed: ${e.message}`));
                else if (m.t === "got") { gotResolve?.(); gotResolve = null; }
                else if (m.t === "done") {
                    const secs = ((Date.now() - t0.v) / 1000).toFixed(1);
                    status("");
                    console.log(`✓ sent ${fmtSize(total)} in ${secs}s`);
                    setTimeout(() => cleanupAndExit(0), 300);
                } else if (m.t === "reject") {
                    die("\nreceiver declined the transfer");
                }
            });
            dc.stateChanged.subscribe((st) => {
                if (st === "open") dc.send(jframe({ t: "manifest", files: files.map(({ name, size }) => ({ name, size })) }));
            });
            pc.onIceCandidate.subscribe((c) => {
                if (c) room.send({ sid, t: "ice", candidate: c.toJSON() });
            });
            (async () => {
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                // TURN rides along so the receiving side gets a relay path too
                room.send({ sid, t: "offer", sdp: pc.localDescription.sdp, ice: turn });
            })().catch((e) => die(`webrtc: ${e.message}`));
        } else if (msg.sid !== sid) {
            // single-receiver semantics: whoever said hello first wins
        } else if (msg.t === "answer") {
            pc.setRemoteDescription({ type: "answer", sdp: msg.sdp }).catch(() => {});
        } else if (msg.t === "ice") {
            pc.addIceCandidate(msg.candidate).catch(() => {});
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
    let pc = null;
    let dc = null;
    let manifest = null;
    let current = null; // { stream, i, received }
    let totalReceived = 0;
    let total = 0;
    let t0 = 0;

    const offerTimer = setTimeout(
        () => die("no sender found — is `freedrop <files>` still running on the other side?"),
        20_000,
    );

    // avoid clobbering: aaa.txt -> aaa(1).txt
    const freshPath = (name) => {
        const safe = basename(name);
        let p = join(outDir, safe);
        for (let n = 1; existsSync(p); n++) {
            const dot = safe.lastIndexOf(".");
            p = join(outDir, dot > 0 ? `${safe.slice(0, dot)}(${n})${safe.slice(dot)}` : `${safe}(${n})`);
        }
        return p;
    };

    const finish = () => {
        sendCtl({ t: "done" });
        const secs = ((Date.now() - t0) / 1000).toFixed(1);
        status("");
        console.log(`✓ received ${fmtSize(totalReceived)} in ${secs}s`);
        setTimeout(() => {
            try { pc?.close(); } catch {}
            room.close();
            process.exit(0);
        }, 300);
    };

    const onFrame = (data) => {
        const { msg, chunk } = parseFrame(data);
        if (chunk) {
            if (!current) return;
            current.stream.write(chunk);
            current.received += chunk.length;
            totalReceived += chunk.length;
            progressLine("receiving", totalReceived, total, t0);
            return;
        }
        if (msg.t === "manifest") {
            manifest = msg.files;
            total = manifest.reduce((n, f) => n + f.size, 0);
            console.log(`incoming: ${manifest.length} file(s), ${fmtSize(total)}`);
            for (const f of manifest) console.log(`  ${basename(f.name)}  (${fmtSize(f.size)})`);
            const go = () => {
                t0 = Date.now();
                sendCtl({ t: "accept" });
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
        } else if (msg.t === "file") {
            const path = freshPath(msg.name);
            current = { stream: createWriteStream(path), i: msg.i, path, received: 0 };
        } else if (msg.t === "file-end") {
            const done = current;
            current = null;
            done.stream.end(() => {
                sendCtl({ t: "got", i: done.i });
                if (done.i === manifest.length - 1) finish();
            });
        }
    };

    // the manifest only ever arrives over the DataChannel, so any reply
    // here is guaranteed an open channel
    const sendCtl = (obj) => dc.send(jframe(obj));

    room.onmessage = (msg) => {
        if (msg.sid !== sid) return;
        if (msg.t === "offer") {
            clearTimeout(offerTimer);
            status("sender found, connecting…");
            pc = new RTCPeerConnection({ iceServers: [...STUN, ...(msg.ice ?? []), ...turnExtra] });
            watchConnection(pc, die);
            pc.onDataChannel.subscribe((channel) => {
                dc = channel;
                dc.onMessage.subscribe(onFrame);
            });
            pc.onIceCandidate.subscribe((c) => {
                if (c) room.send({ sid, t: "ice", candidate: c.toJSON() });
            });
            (async () => {
                await pc.setRemoteDescription({ type: "offer", sdp: msg.sdp });
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                room.send({ sid, t: "answer", sdp: pc.localDescription.sdp });
            })().catch((e) => die(`webrtc: ${e.message}`));
        } else if (msg.t === "ice") {
            pc?.addIceCandidate(msg.candidate).catch(() => {});
        }
    };

    room.send({ sid, t: "hello" });
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
