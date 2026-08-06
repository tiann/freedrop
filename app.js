// freedrop web client: sender (no fragment) and receiver (#<code>).
// Mirrors cli.mjs — same room protocol, same 1-byte frame tag, same
// backpressure water marks. Bytes never touch any server.
//
// File bytes carry offsets global to the whole transfer (files
// concatenated in manifest order), so files stream back to back with no
// per-file round trip and big transfers stripe across several
// PeerConnections — one SCTP association is CPU-bound, N of them scale.
// The receiver's hello advertises how many connections it can take.
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

const zh = (navigator.language || "").toLowerCase().startsWith("zh");
const T = zh ? {
    drop: "拖文件到这里，或点击选择",
    share: "把链接发给对方，或让对方运行:",
    waiting: "等待对方连接…",
    connecting: "连接中…",
    incoming: (n, s) => `收到 ${n} 个文件 (${s})`,
    save: "保存",
    copy: "复制链接",
    copied: "已复制",
    sending: (s) => `发送中 ${s}`,
    receiving: (s) => `接收中 ${s}`,
    doneSend: (s, t) => `✓ 已发送 ${s}，用时 ${t}s`,
    doneRecv: (s, t) => `✓ 已接收 ${s}，用时 ${t}s`,
    noSender: "找不到发送方 — 确认对方的 freedrop 还开着",
    p2pFail: "P2P 连接失败（双方都在对称 NAT/CGNAT 后面）— 发送方加 --turn 可解决",
    declined: "对方拒绝了",
    memWarn: "此浏览器不支持流式保存，大文件会占用内存",
    noRtc: "此浏览器不支持 WebRTC",
    brokerFail: "连不上任何会合节点 — 检查网络",
} : {
    drop: "Drop files here, or tap to choose",
    share: "Send the link, or have them run:",
    waiting: "waiting for the other side…",
    connecting: "connecting…",
    incoming: (n, s) => `incoming: ${n} file(s) (${s})`,
    save: "Save",
    copy: "Copy link",
    copied: "Copied",
    sending: (s) => `sending ${s}`,
    receiving: (s) => `receiving ${s}`,
    doneSend: (s, t) => `✓ sent ${s} in ${t}s`,
    doneRecv: (s, t) => `✓ received ${s} in ${t}s`,
    noSender: "no sender found — is their freedrop still running?",
    p2pFail: "P2P failed (symmetric NAT/CGNAT on both ends) — the sender can fix it with --turn",
    declined: "the other side declined",
    memWarn: "this browser can't stream to disk; large files are held in memory",
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
// lets the receiver drop replays (a channel's offsets only ever grow)
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

const fatal = (text) => status(text, true);

function watchConnection(pc) {
    pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed") fatal(T.p2pFail);
    };
}

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

        let sid = null;
        let dc = null; // control channel (connection 0)
        let streaming = false;
        let drainResolve = null;
        let t0 = 0;
        // conns[k]: one WebRTC connection per stripe; conns[0] also
        // carries control. Same rules as the CLI: a stripe that never
        // opens is ignored, one that dies after carrying data is fatal.
        const conns = [];

        // redrawing the DOM per chunk costs real throughput — throttle
        let lastDraw = 0;
        const draw = (sent) => {
            const now = Date.now();
            if (now - lastDraw < 100 && sent !== total) return;
            lastDraw = now;
            status(T.sending(`${fmtSize(sent)} / ${fmtSize(total)}`));
            bar(sent / total);
        };

        // 64 KiB messages measured fastest for the native CLI end and are
        // safe for any browser; a peer announcing 64 KiB or less (werift,
        // or a browser that hides pc.sctp) gets the proven 16 KB payload
        const mmsChunk = () => {
            const mms = conns[0].pc.sctp?.maxMessageSize ?? 65536;
            if (mms <= 65536) return 16 * 1024;
            return Math.min(mms, 64 * 1024) - 9;
        };

        const openPool = () => {
            const open = [];
            for (const c of conns) {
                if (!c) continue;
                if (c.dc && c.dc.readyState === "open") open.push(c);
                else if (c.used) throw new Error(T.p2pFail);
            }
            if (!open.length) throw new Error(T.p2pFail);
            return open;
        };

        const pickChannel = async () => {
            for (;;) {
                const open = openPool();
                let best = open[0];
                for (const c of open) if (c.dc.bufferedAmount < best.dc.bufferedAmount) best = c;
                if (best.dc.bufferedAmount <= HIGH_WATER) return best;
                await new Promise((r) => { drainResolve = r; });
            }
        };

        // files stream back to back as one byte range — offsets are
        // global, chunks fan out over every open stripe, and nothing waits
        // per file: completion is the receiver's side of the ledger
        const stream = async () => {
            t0 = Date.now();
            let sent = 0;
            let base = 0;
            const chunkSize = mmsChunk();
            for (const f of files) {
                const reader = f.stream().getReader();
                let local = 0;
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    for (let off = 0; off < value.length; off += chunkSize) {
                        const part = value.subarray(off, off + chunkSize);
                        const c = await pickChannel();
                        c.used = true;
                        c.dc.send(chunkFrame(base + local, part));
                        local += part.length;
                        sent += part.length;
                        draw(sent);
                    }
                }
                base += f.size;
            }
        };

        const addStripe = (k) => {
            const pc = new RTCPeerConnection({ iceServers: STUN });
            const c = { pc, dc: null, used: false };
            conns[k] = c;
            pc.onconnectionstatechange = () => {
                if (pc.connectionState === "failed" && c.used) fatal(T.p2pFail);
            };
            const ch = pc.createDataChannel(`freedrop-${k}`, { ordered: true });
            ch.binaryType = "arraybuffer";
            ch.bufferedAmountLowThreshold = LOW_WATER;
            ch.onbufferedamountlow = () => { drainResolve?.(); drainResolve = null; };
            ch.onopen = () => { c.dc = ch; };
            pc.onicecandidate = (e) => {
                if (e.candidate) room.send({ sid, t: "ice", conn: k, candidate: e.candidate.toJSON() });
            };
            (async () => {
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                room.send({ sid, t: "offer", conn: k, sdp: pc.localDescription.sdp, ice: [] });
            })().catch(() => {}); // a stripe that never opens is not fatal
        };

        room.onmessage = async (msg) => {
            if (msg.t === "hello" && !sid) {
                sid = msg.sid;
                const maxConns = Math.min(msg.conns ?? 1, STRIPE_CONNS);
                status(T.connecting);
                const pc = new RTCPeerConnection({ iceServers: STUN });
                const c0 = { pc, dc: null, used: true };
                conns[0] = c0;
                watchConnection(pc);
                const ch = pc.createDataChannel("freedrop", { ordered: true });
                dc = ch;
                ch.binaryType = "arraybuffer";
                ch.bufferedAmountLowThreshold = LOW_WATER;
                ch.onbufferedamountlow = () => { drainResolve?.(); drainResolve = null; };
                ch.onopen = () => {
                    c0.dc = ch;
                    ch.send(jframe({ t: "manifest", files: files.map(({ name, size }) => ({ name, size })) }));
                };
                ch.onmessage = (ev) => {
                    const { msg: m } = parseFrame(ev.data);
                    if (!m) return;
                    if (m.t === "accept") {
                        if (streaming) return; // duplicate accept must not restart
                        streaming = true;
                        stream().catch((e) => fatal(String(e.message ?? e)));
                    }
                    else if (m.t === "reject") fatal(T.declined);
                    else if (m.t === "done") {
                        bar(1);
                        status(T.doneSend(fmtSize(total), ((Date.now() - t0) / 1000).toFixed(1)));
                        setTimeout(() => {
                            for (const c of conns) { try { c?.pc.close(); } catch {} }
                            room.close();
                        }, 500);
                    }
                };
                pc.onicecandidate = (e) => {
                    if (e.candidate) room.send({ sid, t: "ice", candidate: e.candidate.toJSON() });
                };
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                room.send({ sid, t: "offer", sdp: pc.localDescription.sdp, ice: [] });
                if (total >= STRIPE_MIN) {
                    for (let k = 1; k < maxConns; k++) addStripe(k);
                }
            } else if (msg.sid !== sid) {
                // first receiver wins
            } else if (msg.t === "answer") {
                conns[msg.conn ?? 0]?.pc.setRemoteDescription({ type: "answer", sdp: msg.sdp }).catch(() => {});
            } else if (msg.t === "ice") {
                conns[msg.conn ?? 0]?.pc.addIceCandidate(msg.candidate).catch(() => {});
            }
        };
    }
}

// ---- receive ----------------------------------------------------------------

async function receive(codeStr) {
    status(T.connecting);
    const key = b64u.decode(codeStr);
    const room = await SignalRoom.create({ key, role: "viewer" })
        .catch(() => { throw new Error(T.brokerFail); });
    const sid = [...crypto.getRandomValues(new Uint8Array(8))]
        .map((b) => b.toString(16).padStart(2, "0")).join("");

    const pcs = []; // conn-index → { pc, ch, rx, last }
    let dc = null; // control channel (connection 0)
    let manifest = null;
    let total = 0;
    let received = 0;
    let t0 = 0;
    let dirHandle = null; // File System Access API when available, memory otherwise
    // ledger: { i, name, size, base, writable, buf, opening, written, closing }
    let vfiles = null;
    let completed = 0;

    const offerTimer = setTimeout(() => fatal(T.noSender), 20_000);

    let lastDraw = 0;
    const draw = () => {
        const now = Date.now();
        if (now - lastDraw < 100 && received !== total) return;
        lastDraw = now;
        status(T.receiving(`${fmtSize(received)} / ${fmtSize(total)}`));
        bar(received / total);
    };

    // ---- positional writes keyed by global offset --------------------------
    // Chunks may arrive on any stripe in any relative order; each lands at
    // its position in a preallocated sink. A file is done when every byte
    // has been written — there are no per-file control frames.

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

    const openSink = async (f) => {
        if (dirHandle) {
            const fh = await dirHandle.getFileHandle(f.name.split("/").pop(), { create: true });
            f.writable = await fh.createWritable();
            await f.writable.truncate(f.size); // preallocate for positional writes
        } else {
            f.buf = new Uint8Array(f.size);
        }
    };

    const finish = () => {
        dc.send(jframe({ t: "done" }));
        bar(1);
        status(T.doneRecv(fmtSize(received), ((Date.now() - t0) / 1000).toFixed(1)));
        setTimeout(() => {
            for (const c of pcs) { try { c?.pc.close(); } catch {} }
            room.close();
        }, 500);
    };

    const maybeClose = (f) => {
        if (f.written !== f.size || f.closing) return;
        f.closing = true;
        f.opening.then(async () => {
            if (f.writable) {
                await f.writable.close();
            } else if (f.buf) {
                const a = document.createElement("a");
                a.href = URL.createObjectURL(new Blob([f.buf]));
                a.download = f.name.split("/").pop();
                a.click();
                setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
                f.buf = null;
            }
            if (++completed === vfiles.length) finish();
        }).catch((e) => fatal(String(e.message ?? e)));
    };

    const onChunk = (offset, chunk) => {
        const f = fileAt(offset);
        const local = offset - f.base;
        if (local + chunk.length > f.size) return fatal("data outside any file");
        // copy (the DataChannel buffer gets reused under us), then queue
        // behind the sink open; positional writes need no ordering
        const copy = chunk.slice();
        if (!f.opening) f.opening = openSink(f);
        f.opening
            .then(() => (f.writable
                ? f.writable.write({ type: "write", position: local, data: copy })
                : f.buf.set(copy, local)))
            .then(() => {
                f.written += copy.length;
                maybeClose(f);
            })
            .catch((e) => fatal(String(e.message ?? e)));
        received += chunk.length;
        draw();
    };

    const onFrame = (c, ev) => {
        const { msg, chunk, offset } = parseFrame(ev.data);
        if (chunk) {
            if (offset <= c.last) return; // engine replayed a message
            c.last = offset;
            return onChunk(offset, chunk);
        }
        if (msg.t === "manifest") {
            if (manifest) return; // replayed
            manifest = msg.files;
            total = manifest.reduce((n, f) => n + f.size, 0);
            let base = 0;
            vfiles = manifest.map((f, i) => {
                const entry = {
                    i, name: f.name, size: f.size, base,
                    writable: null, buf: null, opening: null, written: 0, closing: false,
                };
                base += f.size;
                return entry;
            });
            listFiles(manifest);
            status(T.incoming(manifest.length, fmtSize(total)));
            $("actions").hidden = false;
            const btn = document.createElement("button");
            btn.textContent = T.save;
            btn.onclick = async () => {
                btn.disabled = true;
                // the picker must run inside the click gesture
                if (window.showDirectoryPicker) {
                    try {
                        dirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
                    } catch {
                        btn.disabled = false;
                        return; // user cancelled the picker
                    }
                } else {
                    status(T.memWarn);
                }
                t0 = Date.now();
                dc.send(jframe({ t: "accept" }));
                // empty files get no chunks — create them right away
                for (const f of vfiles) {
                    if (f.size > 0) continue;
                    f.opening = openSink(f);
                    maybeClose(f);
                }
            };
            $("actions").appendChild(btn);
        }
    };

    room.onmessage = async (msg) => {
        if (msg.sid !== sid) return;
        if (msg.t === "offer") {
            const k = msg.conn ?? 0;
            if (pcs[k]) return; // replayed offer
            if (k === 0) clearTimeout(offerTimer);
            const pc = new RTCPeerConnection({ iceServers: [...STUN, ...(msg.ice ?? [])] });
            const c = { pc, ch: null, rx: false, last: -1 };
            pcs[k] = c;
            if (k === 0) watchConnection(pc);
            else pc.onconnectionstatechange = () => {
                // a stripe that already delivered data dying means lost bytes
                if (pc.connectionState === "failed" && c.rx) fatal(T.p2pFail);
            };
            pc.ondatachannel = (e) => {
                if (c.ch) return;
                c.ch = e.channel;
                c.ch.binaryType = "arraybuffer";
                c.ch.onmessage = (ev) => {
                    c.rx = true;
                    onFrame(c, ev);
                };
                if (k === 0) dc = c.ch;
            };
            pc.onicecandidate = (e) => {
                if (e.candidate) room.send({ sid, t: "ice", conn: k, candidate: e.candidate.toJSON() });
            };
            await pc.setRemoteDescription({ type: "offer", sdp: msg.sdp });
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            room.send({ sid, t: "answer", conn: k, sdp: pc.localDescription.sdp });
        } else if (msg.t === "ice") {
            pcs[msg.conn ?? 0]?.pc.addIceCandidate(msg.candidate).catch(() => {});
        }
    };

    room.send({ sid, t: "hello", conns: STRIPE_CONNS });
}
