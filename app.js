// freedrop web client: sender (no fragment) and receiver (#<code>).
// Mirrors cli.mjs — same room protocol, same 1-byte frame tag, same
// backpressure water marks, same resume + verify protocol. Bytes never
// touch any server.
//
// File bytes carry offsets global to the whole transfer (files
// concatenated in manifest order), so files stream back to back with no
// per-file round trip and big transfers stripe across several
// PeerConnections — one SCTP association is CPU-bound, N of them scale.
// Coverage is a set of [start,end) ranges: the receiver journals it in
// OPFS, tells the sender what it has (accept {have}), and only the
// complement travels — a reloaded page or a re-run sender resumes
// instead of restarting. Every file is verified against the sender's
// hash (sha256 over 4 MiB block sha256s) before it becomes a download.
import { SignalRoom, b64u } from "./signal.mjs";

const STUN = [
    { urls: "stun:stun.cloudflare.com:3478" },
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun.miwifi.com:3478" },
];
const HIGH_WATER = 4 * 1024 * 1024;
const LOW_WATER = 1 * 1024 * 1024;
const STRIPE_CONNS = 4;
const STRIPE_MIN = 64 * 1024 * 1024;
const HASH_BLOCK = 4 * 1024 * 1024;
const RETRY_WINDOW = 90_000;

const zh = (navigator.language || "").toLowerCase().startsWith("zh");
const T = zh ? {
    drop: "拖文件到这里，或点击选择",
    share: "把链接发给对方，或让对方运行:",
    waiting: "等待对方连接…",
    connecting: "连接中…",
    reconnecting: "连接中断，重连中…",
    incoming: (n, s) => `收到 ${n} 个文件 (${s})`,
    resuming: (s) => `继续上次的传输 — 已有 ${s}`,
    save: "保存",
    copy: "复制链接",
    copied: "已复制",
    sending: (s) => `发送中 ${s}`,
    receiving: (s) => `接收中 ${s}`,
    verifying: "校验中…",
    doneSend: (s, t) => `✓ 已发送 ${s}，用时 ${t}s（对方已校验）`,
    doneRecv: (s, t) => `✓ 已接收 ${s}，用时 ${t}s（已校验）`,
    noSender: "找不到发送方 — 确认对方的 freedrop 还开着",
    p2pFail: "P2P 连接失败（双方都在对称 NAT/CGNAT 后面）— 发送方加 --turn 可解决",
    savedReload: "连接中断 — 进度已保存，重新打开此链接可续传",
    declined: "对方拒绝了",
    badhash: (n) => `${n}: 校验失败 — 发送方的文件变了？请重新传输`,
    tooOld: "此浏览器太旧（不支持 OPFS 本地暂存）",
    noSpace: (s) => `浏览器存储空间不足（需要 ${s}）`,
    noRtc: "此浏览器不支持 WebRTC",
    brokerFail: "连不上任何会合节点 — 检查网络",
} : {
    drop: "Drop files here, or tap to choose",
    share: "Send the link, or have them run:",
    waiting: "waiting for the other side…",
    connecting: "connecting…",
    reconnecting: "connection lost — reconnecting…",
    incoming: (n, s) => `incoming: ${n} file(s) (${s})`,
    resuming: (s) => `resuming — ${s} already here`,
    save: "Save",
    copy: "Copy link",
    copied: "Copied",
    sending: (s) => `sending ${s}`,
    receiving: (s) => `receiving ${s}`,
    verifying: "verifying…",
    doneSend: (s, t) => `✓ sent ${s} in ${t}s — verified by the receiver`,
    doneRecv: (s, t) => `✓ received ${s} in ${t}s — verified`,
    noSender: "no sender found — is their freedrop still running?",
    p2pFail: "P2P failed (symmetric NAT/CGNAT on both ends) — the sender can fix it with --turn",
    savedReload: "connection lost — progress is saved; reopen this link to resume",
    declined: "the other side declined",
    badhash: (n) => `${n}: verification failed — did the sender's file change? transfer it again`,
    tooOld: "this browser is too old (no OPFS staging support)",
    noSpace: (s) => `not enough browser storage (need ${s})`,
    noRtc: "this browser does not support WebRTC",
    brokerFail: "cannot reach any rendezvous broker — check the network",
};

const $ = (id) => document.getElementById(id);
const enc = new TextEncoder();
const dec = new TextDecoder();

const fmtSize = (n) =>
    n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(2)} GB`
    : n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB`
    : n >= 1024 ? `${(n / 1024).toFixed(0)} KB`
    : `${n} B`;

const hex = (buf) =>
    [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

const status = (text, error = false) => {
    $("status").textContent = text;
    $("status").className = error ? "error" : "";
};
const bar = (frac) => {
    $("bar").style.display = "block";
    $("bar").firstElementChild.style.width = `${Math.floor(frac * 100)}%`;
};
const listFiles = (files) => {
    $("files").innerHTML = "";
    for (const f of files) {
        const div = document.createElement("div");
        div.className = "file";
        div.innerHTML = `<span></span><span class="size"></span>`;
        div.firstElementChild.textContent = f.name;
        div.lastElementChild.textContent = fmtSize(f.size);
        $("files").appendChild(div);
    }
};

// tag 1 = JSON control; tag 0 = file bytes + 8-byte transfer-global
// offset, which lets each chunk land positionally from any stripe and
// lets the receiver drop replays (a channel's offsets only ever grow).
// Control flow: manifest {files:[{name,size,mtime}]} → accept {have} →
// data → hash {i,sha} per file → eof → more {have} if gaps → done.
const jframe = (obj) => {
    const body = enc.encode(JSON.stringify(obj));
    const out = new Uint8Array(1 + body.length);
    out[0] = 1;
    out.set(body, 1);
    return out;
};
const chunkFrame = (offset, payload) => {
    const out = new Uint8Array(9 + payload.length);
    new DataView(out.buffer).setBigUint64(1, BigInt(offset));
    out.set(payload, 9);
    return out;
};
const parseFrame = (data) => {
    const u8 = new Uint8Array(data);
    if (u8[0] === 1) return { msg: JSON.parse(dec.decode(u8.subarray(1))) };
    return {
        offset: Number(new DataView(u8.buffer, u8.byteOffset).getBigUint64(1)),
        chunk: u8.subarray(9),
    };
};

// ---- offset ranges (same shapes as cli.mjs) --------------------------------

const addRange = (rs, s, e) => {
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
    return e - s - removed;
};
const coveredBytes = (rs) => rs.reduce((n, [s, e]) => n + (e - s), 0);
const complement = (rs, total) => {
    const out = [];
    let p = 0;
    for (const [s, e] of rs) {
        if (s > p) out.push([p, s]);
        p = Math.max(p, e);
    }
    if (p < total) out.push([p, total]);
    return out;
};
const cleanRanges = (raw, max) => {
    const rs = [];
    for (const r of Array.isArray(raw) ? raw : []) {
        const s = Number(r?.[0]);
        const e = Number(r?.[1]);
        if (Number.isSafeInteger(s) && Number.isSafeInteger(e) && s >= 0 && s < e && e <= max) {
            addRange(rs, s, e);
        }
    }
    return rs;
};

const fatal = (text) => status(text, true);
const ABORT = Symbol("attempt aborted");

// The receiver's OPFS staging worker. It owns every byte: positional
// writes on a SyncAccessHandle (the fastest browser write path), an
// interval journal flushed twice a second so a closed tab can resume,
// and final verification (fdhash: sha256 over 4 MiB block sha256s —
// WebCrypto has no streaming digest, block hashes stream on both ends).
// Staging lives in freedrop/<rid>/ where rid derives from the transfer
// code: revisiting the same link finds its own half-finished stage,
// anything else is swept.
const WORKER_SRC = `
const BLOCK = ${HASH_BLOCK};
const enc = new TextEncoder();
const files = new Map(); // id -> { name, size, mtime, ranges, covered, dirty, sha, ready, handle, access, jhandle, finalizing, done }
let dir = null;
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const addRange = (rs, s, e) => {
    let i = 0;
    while (i < rs.length && rs[i][1] < s) i++;
    let removed = 0, j = i;
    while (j < rs.length && rs[j][0] <= e) {
        removed += rs[j][1] - rs[j][0];
        s = Math.min(s, rs[j][0]); e = Math.max(e, rs[j][1]); j++;
    }
    rs.splice(i, j - i, [s, e]);
    return e - s - removed;
};
const coveredBytes = (rs) => rs.reduce((n, [s, e]) => n + (e - s), 0);
const cleanRanges = (raw, max) => {
    const rs = [];
    for (const r of Array.isArray(raw) ? raw : []) {
        const s = Number(r && r[0]), e = Number(r && r[1]);
        if (Number.isSafeInteger(s) && Number.isSafeInteger(e) && s >= 0 && s < e && e <= max) addRange(rs, s, e);
    }
    return rs;
};

async function init(rid) {
    const opfs = await navigator.storage.getDirectory();
    const top = await opfs.getDirectoryHandle("freedrop", { create: true });
    const names = [];
    for await (const n of top.keys()) names.push(n);
    for (const n of names) if (n !== rid) { try { await top.removeEntry(n, { recursive: true }); } catch {} }
    dir = await top.getDirectoryHandle(rid, { create: true });
    // probe the sync write path (private windows, old engines)
    const ph = await dir.getFileHandle("probe", { create: true });
    (await ph.createSyncAccessHandle()).close();
    await dir.removeEntry("probe");
    // journals from an interrupted visit of this same link
    const entries = [];
    const dn = [];
    for await (const n of dir.keys()) dn.push(n);
    for (const n of dn) {
        const m = /^f(\\d+)\\.json$/.exec(n);
        if (!m) continue;
        try {
            const j = JSON.parse(await (await (await dir.getFileHandle(n)).getFile()).text());
            await dir.getFileHandle("f" + m[1]); // its stage must exist too
            if (j && Number.isInteger(j.size)) {
                entries.push({ i: Number(m[1]), name: j.name, size: j.size, mtime: j.mtime, ranges: j.ranges });
            }
        } catch {}
    }
    postMessage({ op: "state", entries });
}

function flushJournals() {
    for (const f of files.values()) {
        if (!f.dirty || f.done || !f.jhandle) continue;
        f.dirty = false;
        try {
            const buf = enc.encode(JSON.stringify({ name: f.name, size: f.size, mtime: f.mtime, ranges: f.ranges }));
            f.jhandle.write(buf, { at: 0 });
            f.jhandle.truncate(buf.length);
            f.jhandle.flush();
        } catch {}
    }
}
setInterval(flushJournals, 500);

async function checkDone(id, f) {
    if (f.done || f.finalizing || !f.sha || f.covered !== f.size) return;
    f.finalizing = true;
    f.access.flush();
    const digests = [];
    for (let pos = 0; pos < f.size; pos += BLOCK) {
        const buf = new Uint8Array(Math.min(BLOCK, f.size - pos));
        f.access.read(buf, { at: pos });
        digests.push(new Uint8Array(await crypto.subtle.digest("SHA-256", buf)));
    }
    const cat = new Uint8Array(digests.length * 32);
    digests.forEach((d, k) => cat.set(d, k * 32));
    const sha = hex(await crypto.subtle.digest("SHA-256", cat));
    f.access.close();
    f.jhandle.close();
    if (sha !== f.sha) { // sender's file changed between runs, or corruption
        try { await dir.removeEntry("f" + id); } catch {}
        try { await dir.removeEntry("f" + id + ".json"); } catch {}
        files.delete(id);
        postMessage({ op: "badhash", id, name: f.name });
        return;
    }
    try { await dir.removeEntry("f" + id + ".json"); } catch {}
    f.done = true;
    postMessage({ op: "file", id, file: await f.handle.getFile() });
}

onmessage = async (e) => {
    const m = e.data;
    try {
        if (m.op === "init") await init(m.rid);
        else if (m.op === "open") {
            if (files.has(m.id)) return; // a reconnect re-opens — idempotent
            const ranges = cleanRanges(m.ranges, m.size);
            const f = {
                name: m.name, size: m.size, mtime: m.mtime, ranges,
                covered: coveredBytes(ranges), dirty: false, sha: null,
                finalizing: false, done: false,
            };
            files.set(m.id, f);
            f.ready = (async () => {
                f.handle = await dir.getFileHandle("f" + m.id, { create: true });
                f.access = await f.handle.createSyncAccessHandle();
                if (m.fresh) f.access.truncate(0); // drop bytes from any older stage
                f.access.truncate(m.size);
                f.jhandle = await (await dir.getFileHandle("f" + m.id + ".json", { create: true })).createSyncAccessHandle();
                await checkDone(m.id, f); // 0-byte files need no chunks
            })();
            await f.ready;
        } else if (m.op === "write") {
            const f = files.get(m.id);
            await f.ready;
            if (f.done || f.finalizing) return;
            f.access.write(new Uint8Array(m.buf, m.off, m.len), { at: m.pos });
            f.covered += addRange(f.ranges, m.pos, m.pos + m.len);
            f.dirty = true;
            if (f.covered === f.size) await checkDone(m.id, f);
        } else if (m.op === "expect") {
            const f = files.get(m.id);
            if (f) {
                await f.ready;
                f.sha = m.sha;
                await checkDone(m.id, f);
            }
        }
    } catch (err) {
        postMessage({ op: "error", message: String((err && err.message) || err) });
    }
};
`;

// ---------------------------------------------------------------------------

const code = decodeURIComponent(location.hash.slice(1).replace(/^k=/, ""));
if (typeof RTCPeerConnection === "undefined") {
    fatal(T.noRtc);
} else if (/^[A-Za-z0-9_-]{40,48}$/.test(code)) {
    receive(code).catch((e) => fatal(String(e.message ?? e)));
} else {
    sendMode();
}

// ---- send ------------------------------------------------------------------
// A loop of attempts, like the CLI: each receiver hello gets fresh
// connections and a manifest; accept {have} starts one sequential pass
// that hashes every block and transmits only the missing ranges. A lost
// receiver just puts the page back into "waiting" — its next hello
// (same tab retrying, or a re-run `freedrop <code>`) resumes.

function sendMode() {
    $("drop").hidden = false;
    $("drop-label").textContent = T.drop;
    $("drop").onclick = () => $("picker").click();
    $("drop").ondragover = (e) => { e.preventDefault(); $("drop").classList.add("hover"); };
    $("drop").ondragleave = () => $("drop").classList.remove("hover");
    $("drop").ondrop = (e) => {
        e.preventDefault();
        start([...e.dataTransfer.files]);
    };
    $("picker").onchange = () => start([...$("picker").files]);

    async function start(files) {
        if (!files.length) return;
        $("drop").hidden = true;
        listFiles(files);
        const total = files.reduce((n, f) => n + f.size, 0);
        const bases = [];
        {
            let b = 0;
            for (const f of files) {
                bases.push(b);
                b += f.size;
            }
        }

        const key = crypto.getRandomValues(new Uint8Array(32));
        const codeStr = b64u.encode(key);
        const room = await SignalRoom.create({ key, role: "host" })
            .catch(() => { throw new Error(T.brokerFail); });

        const link = `${location.origin}${location.pathname}#${codeStr}`;
        $("link").hidden = false;
        $("link").textContent = `${link}\n\n${T.share}  npx freedrop ${codeStr}`;
        $("actions").hidden = false;
        const copyBtn = document.createElement("button");
        copyBtn.textContent = T.copy;
        copyBtn.onclick = () => {
            navigator.clipboard?.writeText(link);
            copyBtn.textContent = T.copied;
            setTimeout(() => (copyBtn.textContent = T.copy), 1500);
        };
        $("actions").appendChild(copyBtn);
        if (navigator.share) {
            const shareBtn = document.createElement("button");
            shareBtn.className = "ghost";
            shareBtn.textContent = "Share";
            shareBtn.onclick = () => navigator.share({ url: link }).catch(() => {});
            $("actions").appendChild(shareBtn);
        }
        status(T.waiting);

        let at = null; // current attempt
        let acceptedEver = false;
        let done = false;
        let t0 = 0;

        // redrawing the DOM per chunk costs real throughput — throttle
        let lastDraw = 0;
        const draw = (sent, need) => {
            const now = Date.now();
            if (now - lastDraw < 100 && sent !== need) return;
            lastDraw = now;
            status(T.sending(`${fmtSize(sent)} / ${fmtSize(need)}`));
            bar(need ? sent / need : 1);
        };

        // 64 KiB messages measured fastest for the native CLI end and are
        // safe for any browser; a peer announcing 64 KiB or less (werift,
        // or a browser that hides pc.sctp) gets the proven 16 KB payload
        const mmsChunk = (a) => {
            const mms = a.conns[0].pc.sctp?.maxMessageSize ?? 65536;
            if (mms <= 65536) return 16 * 1024;
            return Math.min(mms, 64 * 1024) - 9;
        };

        const teardown = (a) => {
            if (!a) return;
            a.dead = true;
            a.drainResolve?.();
            a.drainResolve = null;
            for (const c of a.conns) { try { c?.pc.close(); } catch {} }
        };

        const lost = (a) => {
            teardown(a);
            if (at === a && !done) status(T.waiting);
        };

        const sendCtl = (a, obj) => {
            try { a.conns[0].dc.send(jframe(obj)); } catch {}
        };

        const openPool = (a) => {
            const open = [];
            for (const c of a.conns) {
                if (!c) continue;
                if (c.dc && c.dc.readyState === "open") open.push(c);
                else if (c.used) { // a stripe that carried data died
                    teardown(a);
                    throw ABORT;
                }
            }
            if (!open.length) {
                teardown(a);
                throw ABORT;
            }
            return open;
        };

        const pickChannel = async (a) => {
            for (;;) {
                if (a.dead) throw ABORT;
                const open = openPool(a);
                let best = open[0];
                for (const c of open) if (c.dc.bufferedAmount < best.dc.bufferedAmount) best = c;
                if (best.dc.bufferedAmount <= HIGH_WATER) return best;
                await new Promise((r) => {
                    a.drainResolve = r;
                    setTimeout(r, 5000); // dead peers don't always report — re-check
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

        // one sequential pass: hash every block (resume needs fresh
        // hashes), transmit only what the receiver reported missing
        const streamAll = async (a, have) => {
            const missing = complement(cleanRanges(have, total), total);
            const need = missing.reduce((n, [s, e]) => n + (e - s), 0);
            t0 = Date.now();
            let sent = 0;
            let mi = 0;
            const chunkSize = mmsChunk(a);
            for (let fi = 0; fi < files.length; fi++) {
                const f = files[fi];
                const digests = [];
                const scratch = new Uint8Array(HASH_BLOCK);
                let fill = 0;
                const reader = f.stream().getReader();
                let local = 0;
                for (;;) {
                    const { done: eod, value } = await reader.read();
                    if (eod) break;
                    if (a.dead) {
                        reader.cancel?.();
                        throw ABORT;
                    }
                    // block hashing rides the same sequential read
                    let off = 0;
                    while (off < value.length) {
                        const take = Math.min(HASH_BLOCK - fill, value.length - off);
                        scratch.set(value.subarray(off, off + take), fill);
                        fill += take;
                        off += take;
                        if (fill === HASH_BLOCK) {
                            digests.push(new Uint8Array(await crypto.subtle.digest("SHA-256", scratch)));
                            fill = 0;
                        }
                    }
                    const gs = bases[fi] + local;
                    const ge = gs + value.length;
                    while (mi < missing.length && missing[mi][1] <= gs) mi++;
                    for (let j = mi; j < missing.length && missing[j][0] < ge; j++) {
                        const s = Math.max(gs, missing[j][0]);
                        const e = Math.min(ge, missing[j][1]);
                        for (let p = s; p < e; p += chunkSize) {
                            const q = Math.min(e, p + chunkSize);
                            const c = await pickChannel(a);
                            sendChunk(a, c, p, value.subarray(p - gs, q - gs));
                            sent += q - p;
                            draw(sent, need);
                        }
                    }
                    local += value.length;
                }
                if (local !== f.size) throw new Error("file changed while sending");
                if (fill > 0) digests.push(new Uint8Array(await crypto.subtle.digest("SHA-256", scratch.subarray(0, fill))));
                const cat = new Uint8Array(digests.length * 32);
                digests.forEach((d, k) => cat.set(d, k * 32));
                sendCtl(a, { t: "hash", i: fi, sha: hex(await crypto.subtle.digest("SHA-256", cat)) });
            }
            sendCtl(a, { t: "eof" });
            status(T.verifying);
        };

        const fileIndexAt = (off) => {
            let lo = 0;
            let hi = files.length - 1;
            while (lo < hi) {
                const mid = (lo + hi + 1) >> 1;
                if (bases[mid] <= off) lo = mid;
                else hi = mid - 1;
            }
            return lo;
        };

        // gap fill after eof — rare, small, windowed reads via slice()
        const streamMore = async (a, have) => {
            const missing = complement(cleanRanges(have, total), total);
            const chunkSize = mmsChunk(a);
            const WINDOW = 8 * 1024 * 1024;
            for (const [s, e] of missing) {
                let p = s;
                while (p < e) {
                    const fi = fileIndexAt(p);
                    const end = Math.min(e, bases[fi] + files[fi].size, p + WINDOW);
                    const u8 = new Uint8Array(
                        await files[fi].slice(p - bases[fi], end - bases[fi]).arrayBuffer());
                    for (let q = 0; q < u8.length; q += chunkSize) {
                        if (a.dead) throw ABORT;
                        const c = await pickChannel(a);
                        sendChunk(a, c, p + q, u8.subarray(q, q + chunkSize));
                    }
                    p = end;
                }
            }
            sendCtl(a, { t: "eof" });
        };

        const addStripe = (a, k) => {
            const pc = new RTCPeerConnection({ iceServers: STUN });
            const c = { pc, dc: null, used: false };
            a.conns[k] = c;
            pc.onconnectionstatechange = () => {
                if (pc.connectionState === "failed" && c.used && !a.dead) teardown(a);
            };
            const ch = pc.createDataChannel(`freedrop-${k}`, { ordered: true });
            ch.binaryType = "arraybuffer";
            ch.bufferedAmountLowThreshold = LOW_WATER;
            ch.onbufferedamountlow = () => { a.drainResolve?.(); a.drainResolve = null; };
            ch.onopen = () => { c.dc = ch; };
            pc.onicecandidate = (e) => {
                if (e.candidate) room.send({ sid: a.sid, t: "ice", conn: k, candidate: e.candidate.toJSON() });
            };
            (async () => {
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                room.send({ sid: a.sid, t: "offer", conn: k, sdp: pc.localDescription.sdp, ice: [] });
            })().catch(() => {}); // a stripe that never opens is not fatal
        };

        const beginAttempt = (sid, connsWanted) => {
            const maxConns = Math.min(connsWanted ?? 1, STRIPE_CONNS);
            const a = { sid, conns: [], dead: false, streaming: false, drainResolve: null };
            at = a;
            status(T.connecting);
            const pc = new RTCPeerConnection({ iceServers: STUN });
            const c0 = { pc, dc: null, used: true };
            a.conns[0] = c0;
            pc.onconnectionstatechange = () => {
                if (pc.connectionState === "failed" && !a.dead) {
                    if (!acceptedEver && at === a) fatal(T.p2pFail);
                    lost(a);
                }
            };
            const ch = pc.createDataChannel("freedrop", { ordered: true });
            ch.binaryType = "arraybuffer";
            ch.bufferedAmountLowThreshold = LOW_WATER;
            ch.onbufferedamountlow = () => { a.drainResolve?.(); a.drainResolve = null; };
            ch.onclose = () => { if (!a.dead && !done) lost(a); };
            ch.onopen = () => {
                c0.dc = ch;
                ch.send(jframe({
                    t: "manifest",
                    files: files.map((f) => ({ name: f.name, size: f.size, mtime: f.lastModified })),
                }));
            };
            ch.onmessage = (ev) => {
                const { msg: m } = parseFrame(ev.data);
                if (!m) return;
                if (m.t === "accept") {
                    if (a.streaming) return; // duplicate accept must not restart
                    a.streaming = true;
                    acceptedEver = true;
                    streamAll(a, m.have).catch((e) => {
                        if (e === ABORT) { if (at === a && !done) status(T.waiting); }
                        else fatal(String(e.message ?? e));
                    });
                } else if (m.t === "more") {
                    streamMore(a, m.have).catch((e) => {
                        if (e === ABORT) { if (at === a && !done) status(T.waiting); }
                        else fatal(String(e.message ?? e));
                    });
                } else if (m.t === "reject") {
                    fatal(T.declined);
                } else if (m.t === "done") {
                    done = true;
                    bar(1);
                    status(T.doneSend(fmtSize(total), ((Date.now() - t0) / 1000).toFixed(1)));
                    setTimeout(() => {
                        teardown(a);
                        room.close();
                    }, 500);
                }
            };
            pc.onicecandidate = (e) => {
                if (e.candidate) room.send({ sid: a.sid, t: "ice", candidate: e.candidate.toJSON() });
            };
            (async () => {
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                room.send({ sid: a.sid, t: "offer", sdp: pc.localDescription.sdp, ice: [] });
            })().catch((e) => fatal(String(e.message ?? e)));
            if (total >= STRIPE_MIN) {
                for (let k = 1; k < maxConns; k++) addStripe(a, k);
            }
        };

        room.onmessage = (msg) => {
            if (msg.t === "hello") {
                // same sid again is a periodic re-hello; a new sid is a
                // (re)connecting receiver and supersedes the old attempt
                if (at && !at.dead && msg.sid === at.sid) return;
                teardown(at);
                beginAttempt(msg.sid, msg.conns);
            } else if (!at || msg.sid !== at.sid) {
                // stale attempt traffic
            } else if (msg.t === "answer") {
                at.conns[msg.conn ?? 0]?.pc.setRemoteDescription({ type: "answer", sdp: msg.sdp }).catch(() => {});
            } else if (msg.t === "ice") {
                at.conns[msg.conn ?? 0]?.pc.addIceCandidate(msg.candidate).catch(() => {});
            }
        };
    }
}

// ---- receive ----------------------------------------------------------------
// MEGA-style client-side staging: chunks land positionally in OPFS
// (origin-private, zero permission prompts — the only per-file write API
// that works on mobile), each verified file then becomes a normal
// browser download backed by the staged bytes on disk, so nothing is
// ever held in memory. The stage and its journal survive the tab: the
// same link resumes where it stopped, and a lost connection re-hellos
// into the same transfer.

async function receive(codeStr) {
    status(T.connecting);
    if (!navigator.storage?.getDirectory) throw new Error(T.tooOld);
    const rid = hex(await crypto.subtle.digest("SHA-256", enc.encode(`freedrop-stage:${codeStr}`))).slice(0, 20);
    const worker = new Worker(URL.createObjectURL(new Blob([WORKER_SRC], { type: "text/javascript" })));
    const saved = await new Promise((resolve, reject) => {
        worker.onmessage = (e) => (e.data.op === "state" ? resolve(e.data.entries) : reject(new Error(T.tooOld)));
        worker.onerror = () => reject(new Error(T.tooOld));
        worker.postMessage({ op: "init", rid });
    });

    const key = b64u.decode(codeStr);
    const room = await SignalRoom.create({ key, role: "viewer" })
        .catch(() => { throw new Error(T.brokerFail); });

    // ---- transfer state (survives attempts) ----
    let manifest = null;
    let vfiles = null; // ledger: { i, name, size, mtime, base, resumed, ranges, covered, sha, done }
    let total = 0;
    let coveredTotal = 0;
    let completed = 0;
    let t0 = 0;
    let acceptedEver = false;
    let staged = false;
    let finished = false;
    let moreRounds = 0;

    // ---- attempt state ----
    let at = null; // { sid, pcs: [{ pc, ch, rx, last }], dc, gotOffer }
    const startedAt = Date.now();
    let connectedOnce = false;
    let disconnectedAt = 0;
    let lastData = Date.now();
    const timers = [];

    const stop = () => {
        for (const t of timers) clearInterval(t);
        teardownAttempt();
        room.close();
    };

    let lastDraw = 0;
    const draw = () => {
        const now = Date.now();
        if (now - lastDraw < 100 && coveredTotal !== total) return;
        lastDraw = now;
        status(T.receiving(`${fmtSize(coveredTotal)} / ${fmtSize(total)}`));
        bar(total ? coveredTotal / total : 1);
    };

    const sendCtl = (obj) => {
        try { at.dc.send(jframe(obj)); } catch {}
    };

    const globalHave = () => {
        const have = [];
        for (const f of vfiles) for (const [s, e] of f.ranges) have.push([f.base + s, f.base + e]);
        return have;
    };

    const fileAt = (offset) => {
        let lo = 0;
        let hi = vfiles.length - 1;
        while (lo < hi) { // last file whose base ≤ offset (skips empty files)
            const mid = (lo + hi + 1) >> 1;
            if (vfiles[mid].base <= offset) lo = mid;
            else hi = mid - 1;
        }
        return vfiles[lo];
    };

    const finish = () => {
        finished = true;
        sendCtl({ t: "done" });
        bar(1);
        status(T.doneRecv(fmtSize(total), ((Date.now() - t0) / 1000).toFixed(1)));
        setTimeout(stop, 500);
    };

    // a verified file becomes a download (disk-backed — no memory copy)
    // and its list row becomes a link, for when the browser blocks the
    // automatic click (multi-file transfers, mobile quirks)
    const onFileReady = (i, file) => {
        const f = vfiles[i];
        if (f.done) return;
        f.done = true;
        const name = f.name.split("/").pop();
        const url = URL.createObjectURL(file);
        const row = $("files").children[i];
        if (row) {
            const a = document.createElement("a");
            a.href = url;
            a.download = name;
            a.textContent = name;
            row.firstElementChild.replaceChildren(a);
        }
        const a = document.createElement("a");
        a.href = url;
        a.download = name;
        a.click();
        if (++completed === vfiles.length) finish();
    };

    worker.onmessage = (e) => {
        const m = e.data;
        if (m.op === "file") onFileReady(m.id, m.file);
        else if (m.op === "badhash") fatal(T.badhash(m.name));
        else if (m.op === "error") fatal(m.message);
    };
    worker.onerror = (e) => fatal(String(e.message ?? e));

    const onChunk = (offset, chunk) => {
        const f = fileAt(offset);
        const local = offset - f.base;
        if (local + chunk.length > f.size) return fatal("data outside any file");
        if (f.done) return;
        // main thread mirrors coverage (for accept/more/progress); the
        // worker owns the durable copy. The message buffer is transferred,
        // not copied — datachannel to disk with zero copies on this
        // thread (it detaches, so read the length first).
        const len = chunk.length;
        const added = addRange(f.ranges, local, local + len);
        f.covered += added;
        coveredTotal += added;
        worker.postMessage(
            { op: "write", id: f.i, pos: local, buf: chunk.buffer, off: chunk.byteOffset, len },
            [chunk.buffer],
        );
        draw();
    };

    const acceptNow = () => {
        acceptedEver = true;
        if (!t0) t0 = Date.now();
        if (!staged) {
            staged = true;
            for (const f of vfiles) {
                worker.postMessage({
                    op: "open", id: f.i, name: f.name, size: f.size, mtime: f.mtime,
                    fresh: !f.resumed, ranges: f.resumed ? f.ranges : [],
                });
            }
        }
        sendCtl({ t: "accept", have: globalHave() });
    };

    const onManifest = (m) => {
        if (manifest) {
            // a reconnect re-sends the manifest — it must be the same transfer
            const same = m.files.length === manifest.length && m.files.every((mf, i) =>
                mf.name === manifest[i].name && mf.size === manifest[i].size && mf.mtime === manifest[i].mtime);
            if (!same) return fatal(T.declined);
            if (acceptedEver) acceptNow();
            return;
        }
        manifest = m.files;
        total = manifest.reduce((n, f) => n + f.size, 0);
        let base = 0;
        coveredTotal = 0;
        vfiles = manifest.map((mf, i) => {
            const prior = saved.find((s) =>
                s.i === i && s.name === mf.name && s.size === mf.size && s.mtime === mf.mtime);
            const ranges = prior ? cleanRanges(prior.ranges, mf.size) : [];
            const entry = {
                i, name: mf.name, size: mf.size, mtime: mf.mtime, base,
                resumed: !!prior, ranges, covered: coveredBytes(ranges),
                sha: null, done: false,
            };
            coveredTotal += entry.covered;
            base += mf.size;
            return entry;
        });
        listFiles(manifest);
        status(T.incoming(manifest.length, fmtSize(total)));
        if (coveredTotal > 0) {
            // this link was accepted once already — pick up where it stopped
            status(T.resuming(fmtSize(coveredTotal)));
            return acceptNow();
        }
        $("actions").hidden = false;
        const btn = document.createElement("button");
        btn.textContent = T.save;
        btn.onclick = async () => {
            btn.disabled = true;
            try { // staging needs quota headroom for the whole transfer
                const { quota = Infinity, usage = 0 } = await navigator.storage.estimate();
                if (total > quota - usage) return fatal(T.noSpace(fmtSize(total)));
            } catch {}
            acceptNow();
        };
        $("actions").appendChild(btn);
    };

    const onEof = () => {
        if (finished || coveredTotal === total) return; // verification will finish it
        if (++moreRounds > 5) return fatal(T.p2pFail);
        // gap chunks arrive at lower offsets than the stripes have seen;
        // lift the per-channel replay guard for the new round
        for (const c of at.pcs) if (c) c.last = -1;
        sendCtl({ t: "more", have: globalHave() });
    };

    const onFrame = (c, ev) => {
        const { msg, chunk, offset } = parseFrame(ev.data);
        lastData = Date.now();
        disconnectedAt = 0;
        if (chunk) {
            if (offset <= c.last) return; // engine replayed a message
            c.last = offset;
            return onChunk(offset, chunk);
        }
        if (msg.t === "manifest") onManifest(msg);
        else if (msg.t === "hash") {
            const f = vfiles?.[msg.i];
            if (f && !f.done && typeof msg.sha === "string") {
                f.sha = msg.sha;
                worker.postMessage({ op: "expect", id: f.i, sha: msg.sha });
            }
        } else if (msg.t === "eof") onEof();
    };

    const teardownAttempt = () => {
        if (!at) return;
        for (const c of at.pcs) { try { c?.pc.close(); } catch {} }
        at = null;
    };

    const startAttempt = () => {
        teardownAttempt();
        at = {
            sid: hex(crypto.getRandomValues(new Uint8Array(8))),
            pcs: [], dc: null, gotOffer: false,
        };
        room.send({ sid: at.sid, t: "hello", conns: STRIPE_CONNS });
    };

    const retry = () => {
        if (finished) return;
        if (!acceptedEver) {
            // never carried data — almost always NAT, and retrying the
            // same pair of networks will not do better
            if (connectedOnce) fatal(T.p2pFail);
            return; // pre-connection: the hello re-send loop is still trying
        }
        const now = Date.now();
        if (!disconnectedAt) disconnectedAt = now;
        if (now - disconnectedAt > RETRY_WINDOW) {
            stop();
            return fatal(T.savedReload); // the journal survives — reopening resumes
        }
        status(T.reconnecting);
        lastData = now; // fresh grace period for the new attempt
        startAttempt();
    };

    room.onmessage = async (msg) => {
        if (!at || msg.sid !== at.sid) return;
        if (msg.t === "offer") {
            const k = msg.conn ?? 0;
            if (at.pcs[k]) return; // replayed offer
            const a = at;
            a.gotOffer = true;
            if (k === 0) {
                connectedOnce = true;
                if (!manifest) status(T.connecting);
            }
            const pc = new RTCPeerConnection({ iceServers: [...STUN, ...(msg.ice ?? [])] });
            const c = { pc, ch: null, rx: false, last: -1 };
            a.pcs[k] = c;
            pc.onconnectionstatechange = () => {
                if (at !== a || pc.connectionState !== "failed") return;
                if (k === 0 || c.rx) retry();
            };
            pc.ondatachannel = (e) => {
                if (c.ch) return;
                c.ch = e.channel;
                c.ch.binaryType = "arraybuffer";
                c.ch.onclose = () => {
                    if (at === a && k === 0) retry();
                };
                c.ch.onmessage = (ev) => {
                    c.rx = true;
                    onFrame(c, ev);
                };
                if (k === 0) at.dc = c.ch;
            };
            pc.onicecandidate = (e) => {
                if (e.candidate) room.send({ sid: a.sid, t: "ice", conn: k, candidate: e.candidate.toJSON() });
            };
            await pc.setRemoteDescription({ type: "offer", sdp: msg.sdp });
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            room.send({ sid: a.sid, t: "answer", conn: k, sdp: pc.localDescription.sdp });
        } else if (msg.t === "ice") {
            at.pcs[msg.conn ?? 0]?.pc.addIceCandidate(msg.candidate).catch(() => {});
        }
    };

    // hello re-send until an offer lands: covers a sender that starts (or
    // restarts) after us, and a first hello lost in broker weather
    timers.push(setInterval(() => {
        if (at && !at.gotOffer && !finished) {
            room.send({ sid: at.sid, t: "hello", conns: STRIPE_CONNS });
        }
    }, 5000));

    // liveness: data stalls mean a dead peer far more often than a slow
    // one — tear down and re-negotiate; the journal makes it cheap. Once
    // everything is covered and every hash is in, the rest is local
    // verification and no timer should touch it.
    timers.push(setInterval(() => {
        if (finished || !at) return;
        const now = Date.now();
        if (!connectedOnce) {
            if (now - startedAt > 20_000) {
                stop();
                fatal(T.noSender);
            }
            return;
        }
        if (!acceptedEver) return; // waiting at the Save button is not a stall
        const allShaKnown = vfiles.every((f) => f.done || f.sha);
        if (coveredTotal === total && allShaKnown) {
            status(T.verifying);
            return;
        }
        const grace = coveredTotal === total ? 30_000 : 20_000;
        if (now - lastData > grace) retry();
    }, 3000));

    startAttempt();
}
