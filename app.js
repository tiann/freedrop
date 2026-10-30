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
import { SignalRoom, IceInbox, b64u } from "./signal.mjs";
import { qrSvg } from "./qr.mjs";

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
const HANDSHAKE_TIMEOUT = 5000;
const CONNECT_WINDOW = 15_000;
const RETRY_WINDOW = 90_000;

const zh = (navigator.language || "").toLowerCase().startsWith("zh");
const touch = matchMedia("(pointer: coarse)").matches;
const T = zh ? {
    tagline: "点对点传文件，不经过任何服务器",
    dropTitle: touch ? "选择要发送的文件" : "拖文件到这里",
    dropHint: touch ? "点按从设备中选取" : "或点击选择文件",
    trust: "端到端加密 · 文件不上传",
    files: (n, s) => `${n} 个文件 · ${s}`,
    shareLink: "把链接发给对方",
    shareOrScan: "把链接发给对方，或用手机扫码",
    qrLabel: "链接的二维码",
    orCli: "或在终端接收",
    copy: "复制",
    copied: "已复制",
    share: "分享",
    waiting: "等待对方打开链接…",
    keepOpen: "传完之前请保持此页面打开",
    connecting: "连接中…",
    reconnecting: "连接中断，重连中…",
    resuming: (s) => `继续上次的传输，已有 ${s}`,
    save: (n) => (n > 1 ? `保存 ${n} 个文件` : "保存"),
    sending: "发送中",
    receiving: "接收中",
    verifying: "校验中…",
    of: (a, b) => `${a} / ${b}`,
    left: (t) => `剩余 ${t}`,
    dur: (s) => s < 60 ? `${Math.ceil(s)} 秒`
        : s < 3600 ? `${Math.round(s / 60)} 分钟`
        : `${Math.floor(s / 3600)} 小时 ${Math.round((s % 3600) / 60)} 分`,
    doneSend: (s, t) => `已发送 ${s}，用时 ${t} · 对方已校验`,
    doneRecv: (s, t) => `已接收 ${s}，用时 ${t} · 已校验`,
    savedHint: "已存到下载目录，点文件名可再次保存",
    sendMore: "继续发送",
    startOver: "重新开始",
    retry: "重试",
    noSender: "找不到发送方 — 确认对方的 freedrop 还开着",
    p2pFail: "P2P 连接失败 — 检查网络；若双方都在对称 NAT/CGNAT 后，可在发送方加 --turn",
    savedReload: "连接中断 — 进度已保存，重新打开此链接可续传",
    declined: "对方拒绝了",
    busyTab: "这个链接正在另一个标签页接收 — 关掉那边或用那边",
    badhash: (n) => `${n}: 校验失败 — 发送方的文件变了？请重新传输`,
    tooOld: "此浏览器太旧（不支持 OPFS 本地暂存）",
    noSpace: (s) => `浏览器存储空间不足（需要 ${s}）`,
    noRtc: "此浏览器不支持 WebRTC",
    brokerFail: "连不上任何会合节点 — 检查网络",
    scan: "扫码接收",
    scanMore: "继续扫码接收",
    aim: "对准发送方屏幕上的二维码",
    notOurs: "这不是 freedrop 的二维码",
    noCamera: "打不开相机 — 请允许此页面使用相机",
    cancel: "取消",
    install: "安装应用",
} : {
    tagline: "Peer-to-peer file transfer, no server in between",
    dropTitle: touch ? "Choose files to send" : "Drop files here",
    dropHint: touch ? "Tap to pick from your device" : "or click to browse",
    trust: "End-to-end encrypted · nothing is uploaded",
    files: (n, s) => `${n} file${n === 1 ? "" : "s"} · ${s}`,
    shareLink: "Share this link",
    shareOrScan: "Share this link, or scan it with a phone",
    qrLabel: "QR code of the link",
    orCli: "Or receive in a terminal",
    copy: "Copy",
    copied: "Copied",
    share: "Share",
    waiting: "Waiting for the receiver…",
    keepOpen: "Keep this tab open until the transfer finishes.",
    connecting: "Connecting…",
    reconnecting: "Connection lost — reconnecting…",
    resuming: (s) => `Resuming — ${s} already here`,
    save: (n) => (n > 1 ? `Save ${n} files` : "Save"),
    sending: "Sending",
    receiving: "Receiving",
    verifying: "Verifying…",
    of: (a, b) => `${a} of ${b}`,
    left: (t) => `${t} left`,
    dur: (s) => s < 60 ? `${Math.ceil(s)} s`
        : s < 3600 ? `${Math.round(s / 60)} min`
        : `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`,
    doneSend: (s, t) => `Sent ${s} in ${t} — verified by the receiver`,
    doneRecv: (s, t) => `Received ${s} in ${t} — verified`,
    savedHint: "Saved to your downloads — click a file to save it again.",
    sendMore: "Send more files",
    startOver: "Start over",
    retry: "Try again",
    noSender: "No sender found — is their freedrop still running?",
    p2pFail: "P2P failed — check the network; for symmetric NAT/CGNAT on both ends, try --turn on the sender",
    savedReload: "Connection lost — progress is saved; reopen this link to resume",
    declined: "The other side declined",
    busyTab: "This link is already being received in another tab — use that one",
    badhash: (n) => `${n}: verification failed — did the sender's file change? Transfer it again`,
    tooOld: "This browser is too old (no OPFS staging support)",
    noSpace: (s) => `Not enough browser storage (need ${s})`,
    noRtc: "This browser does not support WebRTC",
    brokerFail: "Cannot reach any rendezvous broker — check the network",
    scan: "Scan to receive",
    scanMore: "Scan to receive more",
    aim: "Point the camera at the QR code on the sender's screen",
    notOurs: "That QR code isn't a freedrop link",
    noCamera: "Can't open the camera — allow this page to use it",
    cancel: "Cancel",
    install: "Install app",
};

const $ = (id) => document.getElementById(id);
const enc = new TextEncoder();
const dec = new TextDecoder();

const fmtSize = (n) =>
    n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(2)} GB`
    : n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB`
    : n >= 1024 ? `${(n / 1024).toFixed(0)} KB`
    : `${n} B`;
const fmtElapsed = (ms) => (ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : T.dur(ms / 1000));

const hex = (buf) =>
    [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

const ICON = {
    file: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>`,
    check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`,
    copy: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2.5"/><path d="M5 15H4.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5"/></svg>`,
    share: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3m-4 4l4-4 4 4"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>`,
};

// The card is one column of optional blocks; each helper owns a block
// and shows it only while it has something to say.
const hint = (text = "") => {
    $("hint").textContent = text;
    $("hint").hidden = !text;
};
let retryLabel = null; // what reloading the page means in this mode
let retryBtn = null;
const BADGE = { busy: "", done: "✓", error: "!" };
const status = (text, state = "") => {
    $("status").className = state;
    $("status").replaceChildren();
    if (state in BADGE) $("status").append(Object.assign(document.createElement("i"), { textContent: BADGE[state] }));
    if (text) $("status").append(text);
    $("pct").textContent = "";
    $("meta").hidden = true;
    $("progress").hidden = !text && $("bar").hidden;
    document.title = state === "done" ? "✓ freedrop" : "freedrop";
    if (state !== "error" && retryBtn) {
        retryBtn.remove();
        retryBtn = null;
        $("actions").hidden = !$("actions").children.length;
    }
};
const bar = (frac) => {
    $("bar").hidden = false;
    $("progress").hidden = false;
    $("bar").firstElementChild.style.width = `${Math.floor(frac * 100)}%`;
};
const action = (label, onclick, className = "") => {
    const b = Object.assign(document.createElement("button"), { textContent: label, className, onclick });
    $("actions").append(b);
    $("actions").hidden = false;
    return b;
};
const clearActions = () => {
    $("actions").replaceChildren();
    $("actions").hidden = true;
    retryBtn = null;
};

// throughput over a sliding window — whole-transfer averages lie after
// a stall or a resume; a shrinking count is a new attempt, start over
const samples = [];
const rate = (bytes) => {
    const now = performance.now();
    if (samples.length && bytes < samples.at(-1)[1]) samples.length = 0;
    samples.push([now, bytes]);
    while (samples.length > 2 && now - samples[0][0] > 4000) samples.shift();
    const secs = (now - samples[0][0]) / 1000;
    return secs >= 1 ? (bytes - samples[0][1]) / secs : 0;
};
const progress = (verb, done, total) => {
    const pct = `${Math.floor((total ? done / total : 1) * 100)}%`;
    status(verb);
    bar(total ? done / total : 1);
    $("pct").textContent = pct;
    $("meta").hidden = false;
    $("amount").textContent = T.of(fmtSize(done), fmtSize(total));
    const r = rate(done);
    $("rate").textContent = r <= 0 ? ""
        : done < total ? `${fmtSize(r)}/s · ${T.left(T.dur((total - done) / r))}`
        : `${fmtSize(r)}/s`;
    document.title = `${pct} · freedrop`;
};
const showDone = (text) => {
    $("card").classList.add("done");
    bar(1);
    status(text, "done");
};

const listFiles = (files) => {
    $("count").textContent = T.files(files.length, fmtSize(files.reduce((n, f) => n + f.size, 0)));
    $("summary").hidden = false;
    $("files").hidden = false;
    $("files").replaceChildren();
    for (const f of files) {
        const li = document.createElement("li");
        li.className = "file";
        li.innerHTML = `<span class="tile"></span><span class="name"></span><span class="size"></span>`;
        const [tile, name, size] = li.children;
        const ext = /\.([a-z0-9]{1,4})$/i.exec(f.name)?.[1];
        if (ext) tile.textContent = ext.toUpperCase();
        else tile.innerHTML = ICON.file;
        name.textContent = f.name;
        name.title = f.name;
        size.textContent = fmtSize(f.size);
        $("files").appendChild(li);
    }
};
const markDone = (row) => {
    row.classList.add("done");
    row.querySelector(".tile").innerHTML = ICON.check;
};

// a phone that turns its screen off suspends the tab, and a suspended tab
// drops its peer connections — hold the screen on while a transfer needs
// it. The system lets go whenever the tab is hidden: ask again on return.
let wakeWanted = false;
let wake = null; // Promise<WakeLockSentinel | null>, held or pending
const keepAwake = (on) => {
    wakeWanted = on;
    if (!on) {
        wake?.then((lock) => lock?.release());
        return;
    }
    if (wake || document.visibilityState !== "visible" || !navigator.wakeLock) return;
    wake = navigator.wakeLock.request("screen").then((lock) => {
        lock.addEventListener("release", () => { wake = null; });
        if (!wakeWanted) lock.release();
        return lock;
    }, () => (wake = null));
};
document.addEventListener("visibilitychange", () => keepAwake(wakeWanted));

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

// every error offers the way out a reload gives in this mode: a receiver
// resumes from its journal, a sender gets back to the drop zone
const fatal = (text) => {
    status(text, "error");
    hint();
    $("trust").hidden = true;
    if (retryLabel && !retryBtn) {
        retryBtn = action(retryLabel, () => {
            onbeforeunload = null;
            location.reload();
        }, "ghost");
    }
};
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
const files = new Map(); // id -> { name, size, mtime, ranges, covered, dirty, sha, ready, handle, access, slots, seq, finalizing, done }
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

// Journals are double-slotted (fN.json / fN.json.b, monotone seq): OPFS
// has no rename, so an in-place rewrite torn by a dying tab could parse
// as garbage — and a lost journal costs the whole stage. Alternating
// slots keeps one intact record at all times; a torn write loses at
// most half a second of ranges.
const savedSeq = new Map(); // id -> seq of the journal chosen at init
// Navigation can release the page's Web Lock before Chromium finishes
// closing its worker's OPFS handles. Wait for that cleanup while keeping
// exclusive access; a live owner must still cause a bounded failure.
const openAccess = async (handle) => {
    const deadline = Date.now() + 5000;
    for (;;) {
        try { return await handle.createSyncAccessHandle(); }
        catch (err) {
            if (err.name !== "NoModificationAllowedError" || Date.now() >= deadline) throw err;
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
    }
};
const writeJournal = (f, obj) => { // throws: callers decide what a failure means
    // The sequence is a commit index, not an attempt counter. If write,
    // truncate, or flush fails, retry the same inactive slot so the last
    // known-good slot is never touched until its replacement is durable.
    const seq = f.seq + 1;
    const buf = enc.encode(JSON.stringify({ ...obj, seq }));
    const slot = f.slots[seq % 2];
    slot.write(buf, { at: 0 });
    slot.truncate(buf.length);
    slot.flush();
    f.seq = seq;
};

// transfer-level liveness/completion marker: "meta" carries a heartbeat
// while this page owns the stage and done:true once the transfer lands.
// The sweep below trusts ONLY this file — journals can't express
// "paused but worth keeping" (small files leave done slots, unstarted
// ones leave empty journals).
let metaAccess = null;
let metaDone = false;
const writeMeta = () => {
    if (!metaAccess) return;
    try {
        const buf = enc.encode(JSON.stringify({ v: 1, done: metaDone, t: Date.now() }));
        metaAccess.write(buf, { at: 0 });
        metaAccess.truncate(buf.length);
        metaAccess.flush();
    } catch {}
};
setInterval(() => { if (!metaDone) writeMeta(); }, 15_000);

// a foreign stage may be swept only when it is finished or abandoned;
// a live tab (fresh heartbeat, or meta locked by its open handle) and a
// paused-within-a-week transfer both stay
const KEEP_MS = 7 * 24 * 3600 * 1000;
async function sweepable(d) {
    let mf;
    try {
        mf = await (await d.getFileHandle("meta")).getFile();
    } catch (e) {
        // no meta at all: not a stage worth keeping. Anything else
        // (locked by a live tab) — deletion is the dangerous direction.
        return !!e && e.name === "NotFoundError";
    }
    try {
        const m = JSON.parse(await mf.text());
        if (m && m.done) return true;
    } catch {} // torn meta must still expire — fall through to the age policy
    return Date.now() - mf.lastModified > KEEP_MS;
}

async function readJournal(name) {
    try {
        const j = JSON.parse(await (await (await dir.getFileHandle(name)).getFile()).text());
        return j && Number.isInteger(j.size) && Number.isInteger(j.seq) ? j : null;
    } catch { return null; }
}

async function init(rid) {
    const opfs = await navigator.storage.getDirectory();
    const top = await opfs.getDirectoryHandle("freedrop", { create: true });
    const names = [];
    for await (const n of top.keys()) names.push(n);
    for (const n of names) {
        if (n === rid) continue;
        let sweep = false;
        try { sweep = await sweepable(await top.getDirectoryHandle(n)); } catch {}
        if (sweep) { try { await top.removeEntry(n, { recursive: true }); } catch {} }
    }
    dir = await top.getDirectoryHandle(rid, { create: true });
    // claim this stage: the open meta handle doubles as a liveness lock
    metaAccess = await openAccess(await dir.getFileHandle("meta", { create: true }));
    writeMeta();
    // journals from an interrupted visit of this same link
    const entries = [];
    const ids = new Set();
    for await (const n of dir.keys()) {
        const m = /^f(\\d+)\\.json(\\.b)?$/.exec(n);
        if (m) ids.add(Number(m[1]));
    }
    for (const i of ids) {
        try {
            await dir.getFileHandle("f" + i);
        } catch {
            // journals without a stage are orphans (badhash cleanup torn
            // mid-way) — their stale high seq would shadow a fresh run's
            // journal later; remove them instead of skipping
            try { await dir.removeEntry("f" + i + ".json"); } catch {}
            try { await dir.removeEntry("f" + i + ".json.b"); } catch {}
            continue;
        }
        const a = await readJournal("f" + i + ".json");
        const b = await readJournal("f" + i + ".json.b");
        const j = a && b ? (a.seq >= b.seq ? a : b) : (a ?? b);
        if (!j) continue;
        savedSeq.set(i, j.seq);
        entries.push({ i, name: j.name, size: j.size, mtime: j.mtime, ranges: j.ranges, done: !!j.done });
    }
    postMessage({ op: "state", entries });
}

function flushJournals() {
    for (const f of files.values()) {
        if (!f.dirty || f.done || !f.slots) continue;
        try {
            f.access.flush(); // the bytes a journal describes must be durable first
            writeJournal(f, { name: f.name, size: f.size, mtime: f.mtime, ranges: f.ranges });
            f.dirty = false; // cleared only after the journal landed — else retry
            f.jfails = 0;
        } catch (err) {
            if (++f.jfails >= 10) { // persistently failing journal = broken resume
                postMessage({ op: "error", message: String((err && err.message) || err) });
            }
        }
    }
}
setInterval(flushJournals, 500);

async function checkDone(id, f) {
    if (f.done || f.finalizing || !f.sha || f.covered !== f.size) return;
    f.finalizing = true;
    f.access.flush();
    // the delivered artifact must be byte-for-byte what we hash: exact
    // length and every read complete — a sealed stage with appended
    // bytes would otherwise hash clean on its prefix and ship the extra
    let ok = f.access.getSize() === f.size;
    const digests = [];
    for (let pos = 0; ok && pos < f.size; pos += BLOCK) {
        const buf = new Uint8Array(Math.min(BLOCK, f.size - pos));
        if (f.access.read(buf, { at: pos }) !== buf.length) { ok = false; break; }
        digests.push(new Uint8Array(await crypto.subtle.digest("SHA-256", buf)));
    }
    const cat = new Uint8Array(digests.length * 32);
    digests.forEach((d, k) => cat.set(d, k * 32));
    const sha = ok ? hex(await crypto.subtle.digest("SHA-256", cat)) : null;
    f.access.close();
    if (sha !== f.sha) { // wrong length, changed source, or corruption
        for (const s of f.slots ?? []) { try { s.close(); } catch {} }
        try { await dir.removeEntry("f" + id); } catch {}
        try { await dir.removeEntry("f" + id + ".json"); } catch {}
        try { await dir.removeEntry("f" + id + ".json.b"); } catch {}
        files.delete(id);
        postMessage({ op: "badhash", id, name: f.name });
        return;
    }
    f.done = true;
    if (f.slots) { // sealed re-checks already carry their marker on disk
        // keep a done marker: a reloaded page must not re-download this
        // file (a failed marker write only costs a re-download)
        try { writeJournal(f, { name: f.name, size: f.size, mtime: f.mtime, done: true }); } catch {}
        for (const s of f.slots) { try { s.close(); } catch {} }
    }
    postMessage({ op: "file", id, file: await f.handle.getFile() });
}

onmessage = async (e) => {
    const m = e.data;
    try {
        if (m.op === "init") await init(m.rid);
        else if (m.op === "open") {
            if (files.has(m.id)) return; // a reconnect re-opens — idempotent
            if (m.done) {
                // verified by an earlier visit — but it must still prove
                // itself against THIS run's hash (the source may have been
                // swapped, same name/size/mtime): hold the stage sealed
                // until the hash frame arrives, then re-verify it
                const f = {
                    name: m.name, size: m.size, mtime: m.mtime,
                    ranges: [[0, m.size]], covered: m.size, dirty: false,
                    sha: null, seq: savedSeq.get(m.id) ?? 0, slots: null,
                    sealed: true, finalizing: false, done: false, jfails: 0,
                };
                files.set(m.id, f);
                f.ready = (async () => {
                    f.handle = await dir.getFileHandle("f" + m.id);
                    f.access = await openAccess(f.handle);
                })();
                await f.ready;
                return;
            }
            const ranges = cleanRanges(m.ranges, m.size);
            const f = {
                name: m.name, size: m.size, mtime: m.mtime, ranges,
                covered: coveredBytes(ranges), dirty: false, sha: null,
                seq: savedSeq.get(m.id) ?? 0, jfails: 0,
                finalizing: false, done: false,
            };
            files.set(m.id, f);
            f.ready = (async () => {
                f.handle = await dir.getFileHandle("f" + m.id, { create: true });
                f.access = await openAccess(f.handle);
                if (m.fresh) f.access.truncate(0); // drop bytes from any older stage
                f.access.truncate(m.size);
                f.slots = [
                    await openAccess(await dir.getFileHandle("f" + m.id + ".json", { create: true })),
                    await openAccess(await dir.getFileHandle("f" + m.id + ".json.b", { create: true })),
                ];
                await checkDone(m.id, f); // 0-byte files need no chunks
            })();
            await f.ready;
        } else if (m.op === "write") {
            const f = files.get(m.id);
            await f.ready;
            if (f.done || f.finalizing || f.sealed) return;
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
        } else if (m.op === "complete") { // whole transfer landed
            metaDone = true;
            writeMeta();
            try { metaAccess.close(); } catch {}
        }
    } catch (err) {
        postMessage({ op: "error", name: err && err.name, message: String((err && err.message) || err) });
    }
};
`;

// ---------------------------------------------------------------------------

$("tagline").textContent = T.tagline;
$("trust-text").textContent = T.trust;
// a file dropped anywhere outside the drop zone would otherwise replace
// the page — and with it a running transfer
addEventListener("dragover", (e) => e.preventDefault());
addEventListener("drop", (e) => e.preventDefault());

// the code in a link (`…/#<code>`, legacy `#k=<code>`, any host — every
// copy of this page speaks the same protocol), in the CLI command, or bare
const codeIn = (text) => {
    const ok = (c) => (/^[A-Za-z0-9_-]{40,48}$/.test(c) ? c : null);
    text = text.trim();
    try {
        const c = ok(decodeURIComponent(new URL(text).hash.slice(1).replace(/^k=/, "")));
        if (c) return c;
    } catch {}
    return ok(text.replace(/^npx freedrop\s+/, ""));
};

const code = codeIn(location.href);
if (typeof RTCPeerConnection === "undefined") {
    fatal(T.noRtc);
} else if (code) {
    receive(code).catch((e) => fatal(String(e.message ?? e)));
} else {
    sendMode();
}

// The service worker (sw.js) makes this an installable app: a shell that
// starts offline, and Android's share sheet as a way to send. Chrome
// offers installing from its menu only — surface it while it can.
addEventListener("load", () => navigator.serviceWorker?.register("./sw.js").catch(() => {}));
let installPrompt = null;
$("install").textContent = T.install;
addEventListener("beforeinstallprompt", (e) => {
    installPrompt = e;
    $("install").hidden = false;
});
addEventListener("appinstalled", () => { $("install").hidden = true; });
$("install").onclick = () => {
    $("install").hidden = true;
    installPrompt?.prompt().catch(() => {});
    installPrompt = null;
};

// ---- send ------------------------------------------------------------------
// A loop of attempts, like the CLI: each receiver hello gets fresh
// connections and a manifest; accept {have} starts one sequential pass
// that hashes every block and transmits only the missing ranges. A lost
// receiver just puts the page back into "waiting" — its next hello
// (same tab retrying, or a re-run `freedrop <code>`) resumes.

function sendMode() {
    $("drop").hidden = false;
    $("drop-title").textContent = T.dropTitle;
    $("drop-hint").textContent = T.dropHint;
    $("drop").onclick = () => $("picker").click();
    // the whole window is the drop target; a depth count survives the
    // enter/leave pairs every child element fires
    let depth = 0;
    const hover = (d) => {
        depth = Math.max(0, d);
        $("drop").classList.toggle("hover", depth > 0 && !$("drop").hidden);
    };
    ondragenter = (e) => { if (e.dataTransfer?.types.includes("Files")) hover(depth + 1); };
    ondragleave = () => hover(depth - 1);
    const go = (files) => start(files).catch((e) => fatal(String(e.message ?? e)));
    ondrop = (e) => {
        hover(0);
        if (!$("drop").hidden) go([...(e.dataTransfer?.files ?? [])]);
    };
    $("picker").onchange = () => go([...$("picker").files]);
    $("scan-label").textContent = T.scan;
    $("scan").onclick = scan;
    // ways in from the installed app: Android's share sheet (the service
    // worker holds the shared files for us) and the "Scan" icon shortcut
    const via = new URLSearchParams(location.search);
    if (location.search) history.replaceState(null, "", location.pathname);
    if (via.has("share-target") && navigator.serviceWorker) {
        navigator.serviceWorker.addEventListener("message", (e) => {
            if (e.data?.t === "share" && !$("drop").hidden) go(e.data.files);
        });
        navigator.serviceWorker.ready.then((r) => r.active.postMessage("share-ready"));
    }
    canScan().then((ok) => {
        $("scan").hidden = !ok || $("drop").hidden;
        if (ok && via.has("scan") && !$("drop").hidden) scan();
    });

    async function start(files) {
        if (!files.length) return;
        $("drop").hidden = true;
        $("scan").hidden = true;
        $("trust").hidden = true;
        listFiles(files);
        status(T.connecting, "busy");
        retryLabel = T.startOver;
        // the picked files die with the page — confirm before leaving
        onbeforeunload = (e) => e.preventDefault();
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
        const cmd = `npx freedrop ${codeStr}`;
        // the CLI row's copy button stays text-free: tests (and people)
        // read the code straight out of #link's text
        $("link").innerHTML = `<div class="label"></div>
            <div class="share"><div class="qr" role="img"></div><div class="links">
                <div class="field"><span class="val"></span></div>
                <div class="label cli"></div>
                <div class="field cmd"><code class="val"></code></div>
            </div></div>`;
        const [linkLabel, share] = $("link").children;
        const [qrBox, links] = share.children;
        const [linkField, cliLabel, cliField] = links.children;
        // phone cameras open the link straight from the screen; a link too
        // long for the encoder just goes without
        const svg = qrSvg(link);
        if (svg) {
            qrBox.innerHTML = svg;
            qrBox.setAttribute("aria-label", T.qrLabel);
        } else qrBox.remove();
        linkLabel.textContent = svg ? T.shareOrScan : T.shareLink;
        linkField.firstElementChild.textContent = link.replace(/^https?:\/\//, "");
        cliLabel.textContent = T.orCli;
        cliField.firstElementChild.textContent = cmd;
        const copyButton = (field, text, label) => {
            const b = document.createElement("button");
            const idle = `${ICON.copy}${label ? `<span>${label}</span>` : ""}`;
            b.className = label ? "" : "icon";
            b.innerHTML = idle;
            b.setAttribute("aria-label", T.copy);
            b.onclick = async () => {
                try {
                    await navigator.clipboard.writeText(text);
                } catch { // no clipboard (insecure origin): select it instead
                    getSelection().selectAllChildren(field.firstElementChild);
                    return;
                }
                b.innerHTML = `${ICON.check}${label ? `<span>${T.copied}</span>` : ""}`;
                setTimeout(() => (b.innerHTML = idle), 1500);
            };
            field.append(b);
        };
        copyButton(linkField, link, T.copy);
        if (navigator.share) {
            const b = document.createElement("button");
            b.className = "ghost";
            b.innerHTML = `${ICON.share}<span></span>`;
            b.lastElementChild.textContent = T.share;
            b.onclick = () => navigator.share({ url: link }).catch(() => {});
            linkField.append(b);
        }
        copyButton(cliField, cmd);
        // the link matters until a receiver is in; once the transfer
        // runs (or is done and the room closed) it is just noise
        const waiting = () => {
            status(T.waiting, "busy");
            $("link").hidden = false;
        };
        waiting();
        hint(T.keepOpen);
        keepAwake(true);

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
            progress(T.sending, sent, need);
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
            if (at === a && !done) waiting();
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
            let lastPing = Date.now();
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
                    // a resumed transfer scans its covered prefix without
                    // sending a frame — keep the receiver from mistaking
                    // the silence for a dead peer and reconnecting
                    if (Date.now() - lastPing > 5000) {
                        lastPing = Date.now();
                        sendCtl(a, { t: "ping" });
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
            status(T.verifying, "busy");
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
            const a = { sid, conns: [], ice: new IceInbox(), dead: false, streaming: false, drainResolve: null };
            at = a;
            status(T.connecting, "busy");
            const pc = new RTCPeerConnection({ iceServers: STUN });
            const c0 = { pc, dc: null, used: true };
            a.conns[0] = c0;
            pc.onconnectionstatechange = () => {
                if (pc.connectionState === "failed" && !a.dead) {
                    if (!acceptedEver && at === a) {
                        teardown(a);
                        fatal(T.p2pFail); // keep the TURN hint visible — lost() would overwrite it
                    } else lost(a);
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
                    $("link").hidden = true;
                    streamAll(a, m.have).catch((e) => {
                        if (e === ABORT) { if (at === a && !done) waiting(); }
                        else fatal(String(e.message ?? e));
                    });
                } else if (m.t === "more") {
                    streamMore(a, m.have).catch((e) => {
                        if (e === ABORT) { if (at === a && !done) waiting(); }
                        else fatal(String(e.message ?? e));
                    });
                } else if (m.t === "reject") {
                    fatal(T.declined);
                } else if (m.t === "done") {
                    done = true;
                    onbeforeunload = null;
                    keepAwake(false);
                    showDone(T.doneSend(fmtSize(total), fmtElapsed(Date.now() - t0)));
                    hint();
                    for (const row of $("files").children) markDone(row);
                    action(T.sendMore, () => location.reload());
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
            })().catch((e) => { if (at === a && !a.dead) fatal(String(e.message ?? e)); });
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
                const k = msg.conn ?? 0;
                const pc = at.conns[k]?.pc;
                if (pc) at.ice.setRemoteDescription(k, pc, { type: "answer", sdp: msg.sdp }).catch(() => {});
            } else if (msg.t === "ice") {
                at.ice.add(msg.conn ?? 0, msg.candidate);
            }
        };
    }
}

// ---- scan -------------------------------------------------------------------
// Scanning with the camera app is a detour, and its link opens in
// whatever browser it picks. Where the page has a QR detector of its own
// (BarcodeDetector: Chromium on macOS, ChromeOS, and Android with Google
// Play services) the landing page scans the sender's screen itself and
// opens the code as if it were a link; elsewhere the button never shows.

async function canScan() {
    if (!navigator.mediaDevices?.getUserMedia || typeof BarcodeDetector === "undefined") return false;
    const formats = await BarcodeDetector.getSupportedFormats().catch(() => []);
    return formats.includes("qr_code");
}

async function scan() {
    const video = $("viewfinder").firstElementChild;
    const detector = new BarcodeDetector({ formats: ["qr_code"] });
    // the viewfinder takes over the card — from the drop zone, or from a
    // finished transfer's files — and cancelling puts back what it covered
    const covered = [...$("card").children]
        .filter((el) => !el.hidden && !["hint", "actions", "trust"].includes(el.id));
    const hintWas = $("hint").textContent;
    const actionsWas = [...$("actions").children];
    let stream = null;
    let live = true;
    let unhint = 0;
    const release = () => {
        live = false;
        clearTimeout(unhint);
        for (const t of stream?.getTracks() ?? []) t.stop();
        video.srcObject = null;
    };
    const cancel = () => {
        if (!live) return;
        release();
        $("viewfinder").hidden = true;
        for (const el of covered) el.hidden = false;
        $("hint").classList.remove("error");
        hint(hintWas);
        $("actions").replaceChildren(...actionsWas);
        $("actions").hidden = !actionsWas.length;
    };
    for (const el of covered) el.hidden = true;
    $("viewfinder").hidden = false;
    hint(T.aim);
    clearActions();
    action(T.cancel, cancel, "ghost");
    try {
        stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
            audio: false,
        });
    } catch {
        if (!live) return;
        $("viewfinder").hidden = true;
        hint(T.noCamera);
        $("hint").classList.add("error");
        return;
    }
    if (!live) return release(); // cancelled while the permission prompt was up
    const [track] = stream.getVideoTracks();
    track.onended = cancel; // taken by another app, or unplugged
    // a webcam facing the user reads like a mirror; a rear camera doesn't
    video.classList.toggle("mirror", track.getSettings().facingMode !== "environment");
    video.srcObject = stream;
    video.play().catch(() => {});
    while (live) {
        const found = await detector.detect(video).catch(() => []);
        if (!live) return;
        const hit = found.map((b) => codeIn(b.rawValue)).find(Boolean);
        if (hit) {
            release();
            // a reload into the link's own URL: receiving runs exactly as
            // it does from an opened link, and a retry reloads into it
            location.hash = hit;
            location.reload();
            return;
        }
        if (found.length) {
            hint(T.notOurs);
            clearTimeout(unhint);
            unhint = setTimeout(() => live && hint(T.aim), 2000);
        }
        await new Promise((r) => setTimeout(r, 150));
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
    const startedAt = Date.now();
    retryLabel = T.retry;
    status(T.connecting, "busy");
    if (!navigator.storage?.getDirectory) throw new Error(T.tooOld);
    const rid = hex(await crypto.subtle.digest("SHA-256", enc.encode(`freedrop-stage:${codeStr}`))).slice(0, 20);
    // two tabs on the same link would share the OPFS stage and corrupt
    // each other (truncating slots mid-verify, clobbering journals) —
    // hold a web lock for the page's lifetime, refuse if already held
    if (navigator.locks) {
        const granted = await new Promise((resolve) => {
            navigator.locks.request(`freedrop-recv-${rid}`, { ifAvailable: true }, (lock) => {
                resolve(!!lock);
                if (lock) return new Promise(() => {}); // held until the page dies
            }).catch(() => resolve(true));
        });
        if (!granted) throw new Error(T.busyTab);
    }
    const worker = new Worker(URL.createObjectURL(new Blob([WORKER_SRC], { type: "text/javascript" })));
    const saved = await new Promise((resolve, reject) => {
        worker.onmessage = ({ data }) => {
            if (data.op === "state") resolve(data.entries);
            else reject(new Error(data.name === "NoModificationAllowedError" ? T.busyTab : data.message || T.tooOld));
        };
        worker.onerror = (e) => reject(new Error(e.message || T.tooOld));
        worker.postMessage({ op: "init", rid });
    });

    const key = b64u.decode(codeStr);
    const waitMs = Math.min(10_000, Math.max(1, CONNECT_WINDOW - (Date.now() - startedAt)));
    const room = await SignalRoom.create({ key, role: "viewer", waitMs })
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
    let failed = false;
    let moreRounds = 0;
    let coveredAtEof = -1;

    // ---- attempt state ----
    let at = null; // { sid, pcs: [{ pc, ch, rx, last }], dc, gotOffer }
    let senderFound = false;
    let disconnectedAt = 0;
    let lastData = Date.now();
    const timers = [];

    const stop = () => {
        keepAwake(false);
        for (const t of timers) clearInterval(t);
        teardownAttempt();
        room.close();
    };

    let lastDraw = 0;
    const draw = () => {
        const now = Date.now();
        if (now - lastDraw < 100 && coveredTotal !== total) return;
        lastDraw = now;
        progress(T.receiving, coveredTotal, total);
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
        if (finished || failed) return;
        finished = true;
        worker.postMessage({ op: "complete" }); // mark the stage sweepable
        sendCtl({ t: "done" });
        showDone(T.doneRecv(fmtSize(total), fmtElapsed(Date.now() - t0)));
        hint(T.savedHint);
        // the next transfer is one scan away — no trip back to the start
        canScan().then((ok) => ok && action(T.scanMore, scan));
        setTimeout(stop, 500);
    };

    // a verified file becomes a download (disk-backed — no memory copy)
    // and its list row becomes a link, for when the browser blocks the
    // automatic click (multi-file transfers, mobile quirks)
    const onFileReady = (i, file) => {
        if (failed) return;
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
            a.textContent = f.name;
            row.querySelector(".name").replaceChildren(a);
            markDone(row);
        }
        const a = document.createElement("a");
        a.href = url;
        a.download = name;
        a.click();
        if (++completed === vfiles.length) finish();
    };

    // terminal failures: stop timers and connections first, so nothing
    // (health timer, a later finish) can overwrite the message — the
    // ledger still claims the bytes the worker just discarded
    const fail = (text) => {
        failed = true;
        stop();
        fatal(text);
    };
    worker.onmessage = (e) => {
        const m = e.data;
        if (m.op === "file") onFileReady(m.id, m.file);
        else if (m.op === "badhash") fail(T.badhash(m.name));
        else if (m.op === "error") fail(m.name === "NoModificationAllowedError" ? T.busyTab : m.message);
    };
    worker.onerror = (e) => fail(String(e.message ?? e));

    const onChunk = (offset, chunk) => {
        if (failed) return; // late stripe data must not repaint a terminal error
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
        $("trust").hidden = true;
        keepAwake(true);
        if (!t0) t0 = Date.now();
        if (!staged) {
            staged = true;
            for (const f of vfiles) {
                worker.postMessage({
                    op: "open", id: f.i, name: f.name, size: f.size, mtime: f.mtime,
                    done: f.priorDone, fresh: !f.resumed && !f.priorDone,
                    ranges: f.resumed ? f.ranges : [],
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
            if (!same) return fail(T.declined); // terminal — retrying would loop forever
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
            const priorDone = !!prior?.done; // verified by an earlier visit
            const ranges = priorDone ? [[0, mf.size]]
                : prior ? cleanRanges(prior.ranges, mf.size) : [];
            const entry = {
                i, name: mf.name, size: mf.size, mtime: mf.mtime, base,
                resumed: !!prior && !priorDone, priorDone, ranges,
                covered: priorDone ? mf.size : coveredBytes(ranges),
                sha: null, done: false,
            };
            coveredTotal += entry.covered;
            base += mf.size;
            return entry;
        });
        listFiles(manifest);
        status("");
        hint();
        if (coveredTotal > 0) {
            // this link was accepted once already — pick up where it stopped
            status(T.resuming(fmtSize(coveredTotal)), "busy");
            return acceptNow();
        }
        action(T.save(manifest.length), async () => {
            clearActions();
            try { // staging needs quota headroom for the whole transfer
                const { quota = Infinity, usage = 0 } = await navigator.storage.estimate();
                if (total > quota - usage) return fatal(T.noSpace(fmtSize(total)));
            } catch {}
            acceptNow();
        });
    };

    // eof races the stripes: it rides connection 0 while other stripes
    // may still hold megabytes in flight — judge gaps only once the pipe
    // has drained, and count only DRY rounds toward the give-up
    const onEof = async () => {
        for (;;) {
            const seen = coveredTotal;
            await new Promise((r) => setTimeout(r, 1500));
            if (coveredTotal === seen) break;
        }
        if (finished || failed || !at || coveredTotal === total) return;
        if (coveredTotal > coveredAtEof) moreRounds = 0;
        coveredAtEof = coveredTotal;
        if (++moreRounds > 5) return fail(T.p2pFail);
        // gap chunks arrive at lower offsets than the stripes have seen;
        // lift the per-channel replay guard for the new round
        for (const c of at.pcs) if (c) c.last = -1;
        sendCtl({ t: "more", have: globalHave() });
    };

    const onFrame = (c, ev) => {
        const { msg, chunk, offset } = parseFrame(ev.data);
        lastData = Date.now();
        // a manifest only proves the attempt negotiated, not that the
        // transfer progresses — clearing the clock on it would let an
        // endless reconnect loop dodge the give-up window forever
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
            const f = vfiles?.[msg.i];
            if (f && !f.done && typeof msg.sha === "string") {
                f.sha = msg.sha;
                worker.postMessage({ op: "expect", id: f.i, sha: msg.sha });
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
            sid: hex(crypto.getRandomValues(new Uint8Array(8))),
            pcs: [], ice: new IceInbox(), dc: null, gotOffer: false, gotManifest: false, lastSignalAt: Date.now(),
        };
        room.send({ sid: at.sid, t: "hello", conns: STRIPE_CONNS });
    };

    const retry = () => {
        if (finished || failed) return;
        const now = Date.now();
        if (!manifest) {
            if (now - startedAt >= CONNECT_WINDOW) return fail(senderFound ? T.p2pFail : T.noSender);
            status(T.reconnecting, "busy");
            startAttempt();
            return;
        }
        if (!disconnectedAt) disconnectedAt = now;
        if (now - disconnectedAt > RETRY_WINDOW) {
            stop();
            return fatal(T.savedReload); // the journal survives — reopening resumes
        }
        status(T.reconnecting, "busy");
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
                if (!manifest) status(T.connecting, "busy");
            }
            const pc = new RTCPeerConnection({ iceServers: [...STUN, ...(msg.ice ?? [])] });
            const c = { pc, ch: null, rx: false, last: -1 };
            a.pcs[k] = c;
            pc.onconnectionstatechange = () => {
                if (at !== a || pc.connectionState !== "failed") return;
                if (k === 0 || c.rx) retry();
            };
            pc.ondatachannel = (e) => {
                if (at !== a || c.ch) return;
                c.ch = e.channel;
                c.ch.binaryType = "arraybuffer";
                c.ch.onclose = () => {
                    if (at === a && k === 0) retry();
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
                room.send({ sid: a.sid, t: "ice", conn: k, candidate: e.candidate.toJSON() });
            };
            try {
                await a.ice.setRemoteDescription(k, pc, { type: "offer", sdp: msg.sdp });
                if (at !== a) return;
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                if (at === a) room.send({ sid: a.sid, t: "answer", conn: k, sdp: pc.localDescription.sdp });
            } catch {
                if (at === a) retry();
            }
        } else if (msg.t === "ice") {
            at.ice.add(msg.conn ?? 0, msg.candidate);
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
        if (!at.gotManifest) {
            // An offer is not a working channel. Lost SDP/ICE must get a
            // fresh sid even before Save, just as reopening the link does.
            if ((!manifest && now - startedAt >= CONNECT_WINDOW) || now - at.lastSignalAt >= HANDSHAKE_TIMEOUT) retry();
            return;
        }
        if (!acceptedEver) return; // waiting at the Save button is not a stall
        const allShaKnown = vfiles.every((f) => f.done || f.sha);
        if (coveredTotal === total && allShaKnown) {
            status(T.verifying, "busy");
            return;
        }
        const grace = coveredTotal === total ? 30_000 : 20_000;
        if (now - lastData > grace) retry();
    }, 1000));

    startAttempt();
}
