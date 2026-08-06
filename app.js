// freedrop web client: sender (no fragment) and receiver (#<code>).
// Mirrors cli.mjs — same room protocol, same 1-byte frame tag, same
// backpressure water marks. Bytes never touch any server.
import { SignalRoom, b64u } from "./signal.mjs";

const STUN = [
    { urls: "stun:stun.cloudflare.com:3478" },
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun.miwifi.com:3478" },
];
const CHUNK = 16 * 1024;
const HIGH_WATER = 4 * 1024 * 1024;
const LOW_WATER = 1 * 1024 * 1024;

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

const jframe = (obj) => {
    const body = enc.encode(JSON.stringify(obj));
    const out = new Uint8Array(1 + body.length);
    out[0] = 1;
    out.set(body, 1);
    return out;
};
const parseFrame = (data) => {
    const u8 = new Uint8Array(data);
    if (u8[0] === 1) return { msg: JSON.parse(dec.decode(u8.subarray(1))) };
    return { chunk: u8.subarray(1) };
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
        let pc = null;
        let dc = null;
        let drainResolve = null;
        let gotResolve = null;
        let t0 = 0;

        const stream = async () => {
            t0 = Date.now();
            let sent = 0;
            for (let i = 0; i < files.length; i++) {
                const f = files[i];
                dc.send(jframe({ t: "file", i, name: f.name, size: f.size }));
                const reader = f.stream().getReader();
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    // reader chunks can be large; respect the message size cap
                    for (let off = 0; off < value.length; off += CHUNK) {
                        if (dc.bufferedAmount > HIGH_WATER) {
                            await new Promise((r) => { drainResolve = r; });
                        }
                        const part = value.subarray(off, off + CHUNK);
                        const framed = new Uint8Array(1 + part.length);
                        framed.set(part, 1);
                        dc.send(framed);
                        sent += part.length;
                    }
                    status(T.sending(`${fmtSize(sent)} / ${fmtSize(total)}`));
                    bar(sent / total);
                }
                dc.send(jframe({ t: "file-end", i }));
                await new Promise((r) => { gotResolve = r; });
            }
        };

        room.onmessage = async (msg) => {
            if (msg.t === "hello" && !sid) {
                sid = msg.sid;
                status(T.connecting);
                pc = new RTCPeerConnection({ iceServers: STUN });
                watchConnection(pc);
                dc = pc.createDataChannel("freedrop", { ordered: true });
                dc.binaryType = "arraybuffer";
                dc.bufferedAmountLowThreshold = LOW_WATER;
                dc.onbufferedamountlow = () => { drainResolve?.(); drainResolve = null; };
                dc.onopen = () =>
                    dc.send(jframe({ t: "manifest", files: files.map(({ name, size }) => ({ name, size })) }));
                dc.onmessage = (ev) => {
                    const { msg: m } = parseFrame(ev.data);
                    if (!m) return;
                    if (m.t === "accept") stream().catch((e) => fatal(String(e.message ?? e)));
                    else if (m.t === "got") { gotResolve?.(); gotResolve = null; }
                    else if (m.t === "reject") fatal(T.declined);
                    else if (m.t === "done") {
                        bar(1);
                        status(T.doneSend(fmtSize(total), ((Date.now() - t0) / 1000).toFixed(1)));
                        setTimeout(() => { pc.close(); room.close(); }, 500);
                    }
                };
                pc.onicecandidate = (e) => {
                    if (e.candidate) room.send({ sid, t: "ice", candidate: e.candidate.toJSON() });
                };
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                room.send({ sid, t: "offer", sdp: pc.localDescription.sdp, ice: [] });
            } else if (msg.sid !== sid) {
                // first receiver wins
            } else if (msg.t === "answer") {
                pc.setRemoteDescription({ type: "answer", sdp: msg.sdp }).catch(() => {});
            } else if (msg.t === "ice") {
                pc.addIceCandidate(msg.candidate).catch(() => {});
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

    let pc = null;
    let dc = null;
    let manifest = null;
    let total = 0;
    let received = 0;
    let t0 = 0;
    // per-file sink: File System Access API when available, memory otherwise
    let dirHandle = null;
    let writable = null;
    let writeChain = Promise.resolve();
    let parts = null;
    let currentName = "";

    const offerTimer = setTimeout(() => fatal(T.noSender), 20_000);

    const openSink = async (name) => {
        currentName = name.split("/").pop();
        if (dirHandle) {
            const fh = await dirHandle.getFileHandle(currentName, { create: true });
            writable = await fh.createWritable();
        } else {
            parts = [];
        }
    };
    const closeSink = async () => {
        await writeChain;
        if (writable) {
            await writable.close();
            writable = null;
        } else {
            const blob = new Blob(parts);
            parts = null;
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = currentName;
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
        }
    };

    const onFrame = (ev) => {
        const { msg, chunk } = parseFrame(ev.data);
        if (chunk) {
            // copy (the DataChannel buffer gets reused under us) and queue on
            // the chain so the sink decision happens after openSink() ran
            const copy = chunk.slice();
            writeChain = writeChain.then(() => (writable ? writable.write(copy) : parts?.push(copy)));
            received += chunk.length;
            status(T.receiving(`${fmtSize(received)} / ${fmtSize(total)}`));
            bar(received / total);
            return;
        }
        if (msg.t === "manifest") {
            manifest = msg.files;
            total = manifest.reduce((n, f) => n + f.size, 0);
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
            };
            $("actions").appendChild(btn);
        } else if (msg.t === "file") {
            writeChain = writeChain.then(() => openSink(msg.name));
        } else if (msg.t === "file-end") {
            const last = msg.i === manifest.length - 1;
            writeChain = writeChain.then(async () => {
                await closeSink();
                dc.send(jframe({ t: "got", i: msg.i }));
                if (last) {
                    dc.send(jframe({ t: "done" }));
                    bar(1);
                    status(T.doneRecv(fmtSize(received), ((Date.now() - t0) / 1000).toFixed(1)));
                    setTimeout(() => { pc.close(); room.close(); }, 500);
                }
            });
        }
    };

    room.onmessage = async (msg) => {
        if (msg.sid !== sid) return;
        if (msg.t === "offer") {
            clearTimeout(offerTimer);
            pc = new RTCPeerConnection({ iceServers: [...STUN, ...(msg.ice ?? [])] });
            watchConnection(pc);
            pc.ondatachannel = (e) => {
                dc = e.channel;
                dc.binaryType = "arraybuffer";
                dc.onmessage = onFrame;
            };
            pc.onicecandidate = (e) => {
                if (e.candidate) room.send({ sid, t: "ice", candidate: e.candidate.toJSON() });
            };
            await pc.setRemoteDescription({ type: "offer", sdp: msg.sdp });
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            room.send({ sid, t: "answer", sdp: pc.localDescription.sdp });
        } else if (msg.t === "ice") {
            pc?.addIceCandidate(msg.candidate).catch(() => {});
        }
    };

    room.send({ sid, t: "hello" });
}
