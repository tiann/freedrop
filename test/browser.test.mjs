// Browser end-to-end tests via Playwright headless Chromium: the static
// page served from this repo on 127.0.0.1 (a secure context, so OPFS and
// WebCrypto work), real signaling, real CLI peers as subprocesses,
// sha256 over every byte. Covers all three interop paths plus both
// browser resume paths (reload the receiving tab; kill the CLI receiver
// under a browser sender).
//
// Needs a Playwright chromium: `npx playwright install chromium`, or
// point FREEDROP_TEST_CHROMIUM at a chromium/headless-shell binary.
import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
    ROOT, TEST_BROKER, startCli, killAll, waitFor, transferCode, exited,
    sleep, makeDir, makeRandom, sha256, stageJournal, journalCovered,
} from "./helpers.mjs";

const TMP = makeDir(join(ROOT, "test", ".tmp", "browser"));
const DL = makeDir(join(TMP, "dl"));

// ---- static server; FREEDROP_TEST_BROKER rewrites the broker list the
// page ships with, so a hermetic run stays hermetic in the browser too
const MIME = {
    html: "text/html", js: "text/javascript", mjs: "text/javascript",
    webmanifest: "application/manifest+json", png: "image/png",
};
const server = createServer(async (req, res) => {
    const p = req.url.split(/[?#]/)[0];
    const file = p === "/" ? "/index.html" : p;
    try {
        let data = await readFile(ROOT + file);
        if (file === "/signal.mjs" && TEST_BROKER) {
            data = data.toString().replace(
                /export const DEFAULT_BROKERS = \[[^\]]*\]/,
                `export const DEFAULT_BROKERS = ${JSON.stringify([TEST_BROKER])}`,
            );
        }
        res.setHeader("content-type", MIME[file.split(".").pop()] ?? "application/octet-stream");
        res.end(data);
    } catch {
        res.statusCode = 404;
        res.end();
    }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const EXE = process.env.FREEDROP_TEST_CHROMIUM;
const browser = await chromium.launch(EXE ? { executablePath: EXE } : {});

test.after(async () => {
    killAll();
    await browser.close();
    server.close();
});

const newPage = async (label) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.log(`  [${label} pageerror] ${e.message}`));
    return page;
};

const collectDownloads = (page) => {
    const got = new Map();
    page.on("download", (d) => got.set(d.suggestedFilename(), d));
    return got;
};

// wait for every named download, clicking the per-file row links for
// anything the browser swallowed (multiple-download policies)
const saveDownloads = async (page, got, names) => {
    await waitFor(async () => {
        if (names.every((n) => got.has(n))) return true;
        for (const n of names.filter((n) => !got.has(n))) {
            await page.locator(".file a", { hasText: n }).first().click({ timeout: 1000 }).catch(() => {});
        }
        return false;
    }, 30_000, `downloads: ${names.join(", ")}`);
    const out = {};
    for (const n of names) {
        const path = join(DL, `${Date.now()}-${n}`);
        await got.get(n).saveAs(path);
        out[n] = await sha256(path);
    }
    return out;
};

const pageDone = async (page, ms = 120_000) => {
    try {
        await waitFor(() => page.locator("#status").textContent().then((s) => s.includes("✓")), ms, "✓ in #status");
    } catch (error) {
        const state = await page.evaluate(() => ({
            status: document.getElementById("status").textContent,
            actions: document.getElementById("actions").textContent,
            progress: document.querySelector("#bar div").style.width,
        })).catch(String);
        throw new Error(`${error.message}; page state: ${JSON.stringify(state)}`, { cause: error });
    }
};

// Exercise public-broker reordering deterministically, even on loopback.
// SDP can trail trickled ICE, and installing it is itself asynchronous.
const signalingRace = async (page, mode) => {
    await page.addInitScript(() => {
        window.signalRace = { early: [], applied: [], hellos: [], dropped: 0 };
        const add = RTCPeerConnection.prototype.addIceCandidate;
        RTCPeerConnection.prototype.addIceCandidate = async function (candidate) {
            await add.call(this, candidate);
            window.signalRace.applied.push(candidate.candidate);
        };
        const set = RTCPeerConnection.prototype.setRemoteDescription;
        RTCPeerConnection.prototype.setRemoteDescription = async function (description) {
            await new Promise((r) => setTimeout(r, 200));
            return set.call(this, description);
        };
    });
    await page.route("**/signal.mjs", async (route) => {
        const response = await route.fetch();
        const body = await response.text();
        await route.fulfill({ response, body: body + `
const createRoom = SignalRoom.create;
SignalRoom.create = async function (...args) {
    const room = await createRoom.apply(this, args);
    const mode = ${JSON.stringify(mode)};
    const released = new Set();
    let handler = null;
    let blockedSid = null;
    Object.defineProperty(room, "onmessage", {
        set: (fn) => { handler = fn; },
        get: () => (msg) => {
            const conn = msg.conn ?? 0;
            if (mode === "stall" && msg.t === "offer" && !blockedSid) blockedSid = msg.sid;
            if (mode === "early-ice") {
                if (msg.t === "offer" || msg.t === "answer") {
                    msg.sdp = msg.sdp.replace(/^a=(?:candidate:.*|end-of-candidates)\\r?\\n/gm, "");
                    setTimeout(() => { released.add(conn); handler?.(msg); }, 300);
                    return;
                }
                if (msg.t === "ice" && !released.has(conn)) window.signalRace.early.push(msg.candidate.candidate);
            }
            handler?.(msg);
        },
    });
    const send = room.send.bind(room);
    room.send = (msg) => {
        if (msg.t === "hello") window.signalRace.hellos.push(msg.sid);
        if (mode === "stall" && msg.sid === blockedSid && (msg.t === "answer" || msg.t === "ice")) {
            window.signalRace.dropped++;
            return Promise.resolve();
        }
        return send(msg);
    };
    return room;
};` });
    });
};

test("CLI → browser: ICE before SDP survives a cold first visit", { timeout: 90_000 }, async (t) => {
    const W = makeDir(join(TMP, "early-ice"));
    await makeRandom(join(W, "aaa.txt"), 1024);
    const sender = startCli(["--no-qr", join(W, "aaa.txt")]);
    t.after(() => sender.kill("SIGKILL"));
    const code = await transferCode(sender);
    const page = await newPage("early-ice");
    t.after(() => page.context().close());
    await signalingRace(page, "early-ice");
    const got = collectDownloads(page);
    await page.goto(`${BASE}/#${code}`);
    await page.getByRole("button", { name: /Save|保存/ }).click({ timeout: 15_000 });
    await pageDone(page);
    const race = await page.evaluate(() => window.signalRace);
    assert.ok(race.early.length, "the test must deliver ICE before the offer");
    for (const candidate of race.early) assert.ok(race.applied.includes(candidate), "early ICE must reach the peer");
    const hashes = await saveDownloads(page, got, ["aaa.txt"]);
    assert.equal(hashes["aaa.txt"], await sha256(join(W, "aaa.txt")));
    assert.equal(await exited(sender), 0, sender.out);
});

test("CLI → browser: stalled first handshake retries without a page reload", { timeout: 90_000 }, async (t) => {
    const W = makeDir(join(TMP, "first-retry"));
    await makeRandom(join(W, "aaa.txt"), 1024);
    const sender = startCli(["--no-qr", join(W, "aaa.txt")]);
    t.after(() => sender.kill("SIGKILL"));
    const code = await transferCode(sender);
    const page = await newPage("first-retry");
    t.after(() => page.context().close());
    await signalingRace(page, "stall");
    await page.clock.install();
    const got = collectDownloads(page);
    await page.goto(`${BASE}/#${code}`);
    // Let the delayed setRemoteDescription finish before advancing the
    // handshake watchdog. The first answer is deliberately discarded.
    await page.clock.resume();
    await waitFor(() => page.evaluate(() => window.signalRace.dropped > 0), 10_000, "discarded first answer");
    await page.clock.fastForward(5500);
    await page.getByRole("button", { name: /Save|保存/ }).click({ timeout: 10_000 });
    await pageDone(page);
    const race = await page.evaluate(() => window.signalRace);
    assert.ok(new Set(race.hellos).size >= 2, "a fresh attempt must replace the stalled handshake");
    const hashes = await saveDownloads(page, got, ["aaa.txt"]);
    assert.equal(hashes["aaa.txt"], await sha256(join(W, "aaa.txt")));
    assert.equal(await exited(sender), 0, sender.out);
});

test("browser: an absent sender stops retries after the connection window", { timeout: 30_000 }, async (t) => {
    const page = await newPage("no-sender");
    t.after(() => page.context().close());
    await signalingRace(page, "observe");
    await page.clock.install();
    await page.goto(`${BASE}/#${randomBytes(32).toString("base64url")}`);
    await waitFor(() => page.evaluate(() => window.signalRace.hellos.length), 10_000, "first hello");
    await page.clock.fastForward(15_000);
    assert.match(await page.locator("#status.error").textContent(), /no sender found|找不到发送方/i);
    const hellos = await page.evaluate(() => window.signalRace.hellos.length);
    await page.clock.fastForward(60_000);
    assert.equal(await page.evaluate(() => window.signalRace.hellos.length), hellos, "terminal failure must stop retrying");
});

// A recording stand-in for the Screen Wake Lock API, with the system's
// side of it: hiding the tab releases every lock.
const fakeWakeLock = (page) => page.addInitScript(() => {
    let visible = true;
    const held = new Set();
    window.wake = { requests: 0, held: () => held.size };
    Object.defineProperty(document, "visibilityState", { get: () => (visible ? "visible" : "hidden") });
    window.setVisible = (v) => {
        visible = v;
        if (!v) for (const lock of [...held]) lock.release();
        document.dispatchEvent(new Event("visibilitychange"));
    };
    Object.defineProperty(navigator, "wakeLock", {
        value: {
            request: async () => {
                const lock = new EventTarget();
                lock.release = async () => {
                    if (!held.delete(lock)) return;
                    lock.dispatchEvent(new Event("release"));
                };
                held.add(lock);
                window.wake.requests++;
                return lock;
            },
        },
    });
});
const wakeHeld = (page) => page.evaluate(() => window.wake.held());

test("CLI → browser: the screen stays on while receiving, and again after the tab returns", { timeout: 90_000 }, async (t) => {
    const W = makeDir(join(TMP, "wake-recv"));
    await makeRandom(join(W, "aaa.bin"), 20e6);
    const sender = startCli(["--no-qr", join(W, "aaa.bin")], { FREEDROP_BPS: "4000000" });
    t.after(() => sender.kill("SIGKILL"));
    const code = await transferCode(sender);
    const page = await newPage("wake-recv");
    t.after(() => page.context().close());
    await fakeWakeLock(page);
    const got = collectDownloads(page);
    await page.goto(`${BASE}/#${code}`);
    const save = page.getByRole("button", { name: /Save|保存/ });
    await save.waitFor({ timeout: 15_000 });
    assert.equal(await wakeHeld(page), 0, "deciding at the Save button needs no lock");
    await save.click();
    await waitFor(async () => await wakeHeld(page) === 1, 10_000, "lock while receiving");
    await page.evaluate(() => window.setVisible(false));
    assert.equal(await wakeHeld(page), 0);
    await page.evaluate(() => window.setVisible(true));
    await waitFor(async () => await wakeHeld(page) === 1, 5_000, "lock taken again after the tab returns");
    await pageDone(page);
    await waitFor(async () => await wakeHeld(page) === 0, 5_000, "lock released when done");
    assert.equal(await page.evaluate(() => window.wake.requests), 2);
    const hashes = await saveDownloads(page, got, ["aaa.bin"]);
    assert.equal(hashes["aaa.bin"], await sha256(join(W, "aaa.bin")));
    assert.equal(await exited(sender), 0, sender.out);
});

test("browser → CLI: the sender keeps the screen on from the link until done", { timeout: 90_000 }, async (t) => {
    const W = makeDir(join(TMP, "wake-send"));
    const dst = makeDir(join(W, "dst"));
    await makeRandom(join(W, "aaa.bin"), 1024);
    const page = await newPage("wake-send");
    t.after(() => page.context().close());
    await fakeWakeLock(page);
    await page.goto(`${BASE}/`);
    assert.equal(await wakeHeld(page), 0, "an idle drop zone needs no lock");
    await page.setInputFiles("#picker", [join(W, "aaa.bin")]);
    const code = await waitFor(() => page.locator("#link").textContent()
        .then((s) => s.match(/npx freedrop ([A-Za-z0-9_-]{40,48})/)?.[1]), 30_000, "browser code");
    assert.equal(await wakeHeld(page), 1, "waiting for the receiver needs the screen on");
    const recv = startCli(["-y", "-o", dst, code]);
    assert.equal(await exited(recv), 0, recv.out);
    await pageDone(page);
    assert.equal(await wakeHeld(page), 0, "lock released when done");
    assert.equal(await sha256(join(dst, "aaa.bin")), await sha256(join(W, "aaa.bin")));
});

// A stand-in camera and QR detector — headless Linux Chromium has no
// BarcodeDetector at all. The camera is a canvas stream that counts its
// stopped tracks; detect() reports the next string queued in
// window.scan.codes, if any.
const fakeScanner = (page, opts = {}) => page.addInitScript(({ formats = ["qr_code"], camera = true }) => {
    window.scan = { codes: [], opened: 0, stopped: 0 };
    window.BarcodeDetector = class {
        static async getSupportedFormats() { return formats; }
        async detect() {
            const rawValue = window.scan.codes.shift();
            return rawValue ? [{ rawValue, format: "qr_code" }] : [];
        }
    };
    navigator.mediaDevices.getUserMedia = async () => {
        if (!camera) throw new DOMException("Permission denied", "NotAllowedError");
        const canvas = Object.assign(document.createElement("canvas"), { width: 64, height: 64 });
        const g = canvas.getContext("2d");
        setInterval(() => g.fillRect(0, 0, 64, 64), 100);
        const stream = canvas.captureStream();
        for (const track of stream.getTracks()) {
            const stop = track.stop.bind(track);
            track.stop = () => { window.scan.stopped++; stop(); };
        }
        window.scan.opened++;
        return stream;
    };
}, opts);
const scanButton = (page) => page.getByRole("button", { name: /Scan|扫码/ });

test("browser: the scan button needs a QR detector; cancelling or a denied camera goes back", { timeout: 30_000 }, async (t) => {
    const blind = await newPage("scan-blind");
    t.after(() => blind.context().close());
    await fakeScanner(blind, { formats: ["ean_13"] });
    await blind.goto(`${BASE}/`);
    await blind.locator("#drop").waitFor();
    await blind.evaluate(() => new Promise((r) => setTimeout(r, 200)));
    assert.ok(await scanButton(blind).isHidden(), "no qr_code format, no scan button");

    const page = await newPage("scan-cancel");
    t.after(() => page.context().close());
    await fakeScanner(page);
    await page.goto(`${BASE}/`);
    await scanButton(page).click();
    await waitFor(() => page.evaluate(() => !!document.querySelector("#viewfinder video").srcObject), 5_000, "camera preview");
    assert.ok(await page.locator("#drop").isHidden());
    await page.getByRole("button", { name: /Cancel|取消/ }).click();
    assert.deepEqual(await page.evaluate(() => [window.scan.opened, window.scan.stopped]), [1, 1], "cancel stops the camera");
    assert.ok(await page.locator("#viewfinder").isHidden());
    assert.ok(await page.locator("#drop").isVisible());
    assert.ok(await scanButton(page).isVisible());

    const denied = await newPage("scan-denied");
    t.after(() => denied.context().close());
    await fakeScanner(denied, { camera: false });
    await denied.goto(`${BASE}/`);
    await scanButton(denied).click();
    assert.match(await denied.locator("#hint.error").textContent(), /camera|相机/i);
    assert.ok(await denied.locator("#viewfinder").isHidden());
    await denied.getByRole("button", { name: /Cancel|取消/ }).click();
    assert.ok(await scanButton(denied).isVisible(), "the button stays for another try");
    assert.ok(await denied.locator("#hint").isHidden());

    // the installed app's "Scan" shortcut opens straight into the scanner
    const shortcut = await newPage("scan-shortcut");
    t.after(() => shortcut.context().close());
    await fakeScanner(shortcut);
    await shortcut.goto(`${BASE}/?scan`);
    await shortcut.locator("#viewfinder").waitFor({ timeout: 5_000 });
    assert.equal(shortcut.url(), `${BASE}/`, "the shortcut's query is dropped from the URL");
});

test("CLI → browser: scanning QR codes receives on this page, one transfer after another", { timeout: 120_000 }, async (t) => {
    const W = makeDir(join(TMP, "scan"));
    await makeRandom(join(W, "aaa.txt"), 1024);
    await makeRandom(join(W, "bbb.txt"), 2048);
    const senderA = startCli(["--no-qr", join(W, "aaa.txt")]);
    const senderB = startCli(["--no-qr", join(W, "bbb.txt")]);
    t.after(() => senderA.kill("SIGKILL"));
    t.after(() => senderB.kill("SIGKILL"));
    const [codeA, codeB] = await Promise.all([transferCode(senderA), transferCode(senderB)]);
    const page = await newPage("scan");
    t.after(() => page.context().close());
    await fakeScanner(page);
    const got = collectDownloads(page);
    await page.goto(`${BASE}/`);
    await scanButton(page).click();
    await page.evaluate(() => window.scan.codes.push("https://example.com/"));
    await waitFor(() => page.locator("#hint").textContent().then((s) => /isn't a freedrop|不是 freedrop/.test(s)),
        5_000, "not-a-freedrop-code hint");
    assert.ok(await page.locator("#viewfinder").isVisible(), "a foreign QR code keeps scanning");
    // what the CLI's terminal QR code holds: the link on freedrop.dev —
    // it opens here, on the page that scanned it
    await page.evaluate((c) => window.scan.codes.push(`https://freedrop.dev/#${c}`), codeA);
    await page.getByRole("button", { name: /Save|保存/ }).click({ timeout: 15_000 });
    assert.equal(page.url(), `${BASE}/#${codeA}`);
    await pageDone(page);
    assert.equal((await saveDownloads(page, got, ["aaa.txt"]))["aaa.txt"], await sha256(join(W, "aaa.txt")));
    assert.equal(await exited(senderA), 0, senderA.out);

    // the finished page scans the next one; cancelling gives it back intact
    await scanButton(page).click();
    assert.ok(await page.locator("#viewfinder").isVisible());
    assert.ok(await page.locator("#files").isHidden(), "the viewfinder covers the last transfer");
    await page.getByRole("button", { name: /Cancel|取消/ }).click();
    assert.ok(await page.locator("#files .file a", { hasText: "aaa.txt" }).isVisible());
    assert.match(await page.locator("#status").textContent(), /✓/);
    await scanButton(page).click();
    await page.evaluate((c) => window.scan.codes.push(`https://freedrop.dev/#${c}`), codeB);
    await page.getByRole("button", { name: /Save|保存/ }).click({ timeout: 15_000 });
    assert.equal(page.url(), `${BASE}/#${codeB}`);
    await pageDone(page);
    assert.equal((await saveDownloads(page, got, ["bbb.txt"]))["bbb.txt"], await sha256(join(W, "bbb.txt")));
    assert.equal(await exited(senderB), 0, senderB.out);
});

// the page once its service worker controls it — the point from which
// it is an installed app's page
const controlled = (page) => waitFor(() => page.evaluate(() => !!navigator.serviceWorker.controller),
    10_000, "service worker in control");

test("browser: installable — manifest, icons, an offline start, and the install button", { timeout: 30_000 }, async (t) => {
    const page = await newPage("pwa");
    t.after(() => page.context().close());
    await page.goto(`${BASE}/`);
    const manifestUrl = await page.locator("link[rel=manifest]").evaluate((l) => l.href);
    const manifest = await (await page.request.get(manifestUrl)).json();
    assert.equal(manifest.display, "standalone");
    assert.equal(new URL(manifest.start_url, manifestUrl).href, `${BASE}/`);
    assert.ok(manifest.icons.some((i) => i.sizes === "192x192" && !i.purpose), "a 192px icon");
    assert.ok(manifest.icons.some((i) => i.sizes === "512x512" && !i.purpose), "a 512px icon");
    assert.ok(manifest.icons.some((i) => i.purpose === "maskable"), "a maskable icon");
    // every icon is a PNG of the size it claims
    const icons = [...manifest.icons, ...manifest.shortcuts.flatMap((s) => s.icons),
        { src: await page.locator("link[rel=apple-touch-icon]").getAttribute("href"), sizes: "180x180" }];
    for (const icon of icons) {
        const res = await page.request.get(new URL(icon.src, manifestUrl).href);
        assert.equal(res.status(), 200, icon.src);
        const png = await res.body();
        assert.equal(png.subarray(1, 4).toString(), "PNG", icon.src);
        assert.equal(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`, icon.sizes, icon.src);
    }
    const share = manifest.share_target;
    assert.deepEqual([share.method, share.enctype, share.params.files[0].name], ["POST", "multipart/form-data", "files"]);
    assert.equal(new URL(share.action, manifestUrl).href, `${BASE}/?share-target`);

    await controlled(page);
    await page.context().setOffline(true);
    await page.reload();
    await page.locator("#drop").waitFor({ timeout: 5_000 });
    await page.context().setOffline(false);

    assert.ok(await page.locator("#install").isHidden(), "nothing to offer before the browser does");
    await page.evaluate(() => {
        window.prompted = 0;
        const e = new Event("beforeinstallprompt");
        e.prompt = async () => { window.prompted++; };
        dispatchEvent(e);
    });
    await page.getByRole("button", { name: /Install|安装/ }).click();
    assert.equal(await page.evaluate(() => window.prompted), 1);
    assert.ok(await page.locator("#install").isHidden());
});

test("browser → CLI: files shared from another app go straight to sending", { timeout: 90_000 }, async (t) => {
    const W = makeDir(join(TMP, "share-target"));
    const dst = makeDir(join(W, "dst"));
    await makeRandom(join(W, "aaa.bin"), 1024);
    await makeRandom(join(W, "bbb.bin"), 300_000);
    const page = await newPage("share-target");
    t.after(() => page.context().close());
    await page.goto(`${BASE}/`);
    await controlled(page);
    // what Android's share sheet does: a multipart POST navigation to the
    // manifest's share_target action
    await page.evaluate(() => {
        const form = Object.assign(document.createElement("form"),
            { method: "post", enctype: "multipart/form-data", action: "./?share-target" });
        form.append(Object.assign(document.createElement("input"), { type: "file", name: "files", multiple: true }));
        document.body.append(form);
    });
    await page.setInputFiles("form input[name=files]", [join(W, "aaa.bin"), join(W, "bbb.bin")]);
    await page.evaluate(() => document.querySelector("form").submit());
    const code = await waitFor(() => page.locator("#link").textContent()
        .then((s) => s.match(/npx freedrop ([A-Za-z0-9_-]{40,48})/)?.[1]).catch(() => null), 30_000, "browser code");
    assert.equal(page.url(), `${BASE}/`, "the share URL is not left behind to re-share on reload");
    const recv = startCli(["-y", "-o", dst, code]);
    assert.equal(await exited(recv), 0, recv.out);
    await pageDone(page);
    for (const n of ["aaa.bin", "bbb.bin"]) assert.equal(await sha256(join(dst, n)), await sha256(join(W, n)), n);
});

test("CLI → browser: striped big + small + empty", { timeout: 300_000 }, async () => {
    const W = makeDir(join(TMP, "c2b"));
    await makeRandom(join(W, "big.bin"), 100e6);
    await makeRandom(join(W, "small.bin"), 3e6);
    await makeRandom(join(W, "empty.bin"), 0);
    const sender = startCli(["--no-qr", join(W, "big.bin"), join(W, "small.bin"), join(W, "empty.bin")]);
    const code = await transferCode(sender);
    const page = await newPage("c2b");
    const got = collectDownloads(page);
    await page.goto(`${BASE}/#${code}`);
    await page.getByRole("button", { name: /Save|保存/ }).click({ timeout: 30_000 });
    await pageDone(page);
    const hashes = await saveDownloads(page, got, ["big.bin", "small.bin", "empty.bin"]);
    for (const n of Object.keys(hashes)) assert.equal(hashes[n], await sha256(join(W, n)), n);
    assert.equal(await exited(sender), 0, sender.out);
    await page.context().close();
});

test("browser → CLI: striped big + small + empty", { timeout: 300_000 }, async () => {
    const W = makeDir(join(TMP, "b2c"));
    const dst = makeDir(join(W, "dst"));
    await makeRandom(join(W, "big.bin"), 100e6);
    await makeRandom(join(W, "small.bin"), 3e6);
    await makeRandom(join(W, "empty.bin"), 0);
    const page = await newPage("b2c");
    await page.goto(`${BASE}/`);
    await page.setInputFiles("#picker", [join(W, "big.bin"), join(W, "small.bin"), join(W, "empty.bin")]);
    const code = await waitFor(() => page.locator("#link").textContent()
        .then((s) => s.match(/npx freedrop ([A-Za-z0-9_-]{40,48})/)?.[1]), 30_000, "browser code");
    const recv = startCli(["-y", "-o", dst, code]);
    assert.equal(await exited(recv), 0, recv.out);
    for (const n of ["big.bin", "small.bin", "empty.bin"]) {
        assert.equal(await sha256(join(dst, n)), await sha256(join(W, n)), n);
    }
    await page.context().close();
});

test("browser → browser: multi-file with ICE before offers and answers", { timeout: 300_000 }, async () => {
    const W = makeDir(join(TMP, "b2b"));
    await makeRandom(join(W, "small.bin"), 3e6);
    await makeRandom(join(W, "empty.bin"), 0);
    const sendPage = await newPage("b2b-send");
    await signalingRace(sendPage, "early-ice");
    await sendPage.goto(`${BASE}/`);
    await sendPage.setInputFiles("#picker", [join(W, "small.bin"), join(W, "empty.bin")]);
    const code = await waitFor(() => sendPage.locator("#link").textContent()
        .then((s) => s.match(/npx freedrop ([A-Za-z0-9_-]{40,48})/)?.[1]), 30_000, "browser code");
    const recvPage = await newPage("b2b-recv");
    await signalingRace(recvPage, "early-ice");
    const got = collectDownloads(recvPage);
    await recvPage.goto(`${BASE}/#${code}`);
    await recvPage.getByRole("button", { name: /Save|保存/ }).click({ timeout: 30_000 });
    await pageDone(recvPage);
    const hashes = await saveDownloads(recvPage, got, ["small.bin", "empty.bin"]);
    for (const n of Object.keys(hashes)) assert.equal(hashes[n], await sha256(join(W, n)), n);
    for (const page of [sendPage, recvPage]) {
        const race = await page.evaluate(() => window.signalRace);
        assert.ok(race.early.length, "ICE must arrive before SDP on both sides");
        for (const candidate of race.early) assert.ok(race.applied.includes(candidate), "early ICE must reach the peer");
    }
    await sendPage.context().close();
    await recvPage.context().close();
});

test("CLI → browser: waits for the previous page's OPFS handle to close", { timeout: 45_000 }, async (t) => {
    const W = makeDir(join(TMP, "storage-handoff"));
    await makeRandom(join(W, "aaa.txt"), 1024);
    const sender = startCli(["--no-qr", join(W, "aaa.txt")]);
    t.after(() => sender.kill("SIGKILL"));
    const code = await transferCode(sender);

    // Page navigation can release the Web Lock before Chromium has
    // closed the old worker's OPFS handles. Hold the actual meta file
    // from a second worker to exercise that storage handoff directly.
    const owner = await newPage("storage-owner");
    t.after(() => owner.context().close());
    await owner.goto(BASE);
    await owner.evaluate(async (code) => {
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`freedrop-stage:${code}`));
        const rid = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 20);
        const top = await (await navigator.storage.getDirectory()).getDirectoryHandle("freedrop", { create: true });
        const dir = await top.getDirectoryHandle(rid, { create: true });
        const handle = await dir.getFileHandle("meta", { create: true });
        const worker = new Worker(URL.createObjectURL(new Blob([`
            let access;
            onmessage = async ({ data }) => {
                if (data === "release") {
                    access.close();
                    postMessage("released");
                    close();
                } else {
                    access = await data.createSyncAccessHandle();
                    postMessage("locked");
                }
            };
        `], { type: "text/javascript" })));
        await new Promise((resolve, reject) => {
            worker.onmessage = resolve;
            worker.onerror = reject;
            worker.postMessage(handle);
        });
        window.releaseStage = () => new Promise((resolve) => {
            worker.onmessage = resolve;
            worker.postMessage("release");
        });
    }, code);

    const page = await owner.context().newPage();
    const got = collectDownloads(page);
    const ready = page.waitForEvent("worker");
    await page.goto(`${BASE}/#${code}`);
    await ready;
    await sleep(250);
    await owner.evaluate(() => window.releaseStage());
    await page.getByRole("button", { name: /Save|保存/ }).click({ timeout: 10_000 });
    await pageDone(page);
    const hashes = await saveDownloads(page, got, ["aaa.txt"]);
    assert.equal(hashes["aaa.txt"], await sha256(join(W, "aaa.txt")));
    assert.equal(await exited(sender), 0, sender.out);
});

test("CLI → browser: reload mid-transfer resumes; verified files come back from OPFS", { timeout: 300_000 }, async () => {
    const W = makeDir(join(TMP, "reload"));
    await makeRandom(join(W, "small.bin"), 3e6); // verifies before the reload → done-marker path
    await makeRandom(join(W, "big.bin"), 300e6);
    // throttled so the reload window is deterministic on fast machines
    const sender = startCli(["--no-qr", join(W, "small.bin"), join(W, "big.bin")], { FREEDROP_BPS: "100000000" });
    const code = await transferCode(sender);
    const page = await newPage("reload");
    const got = collectDownloads(page);
    await page.goto(`${BASE}/#${code}`);
    await page.getByRole("button", { name: /Save|保存/ }).click({ timeout: 30_000 });
    await waitFor(() => page.locator("#bar div").evaluate((el) => parseInt(el.style.width) >= 20),
        60_000, "partial progress");
    await page.reload(); // same link, same OPFS — must auto-resume, no Save button
    await pageDone(page).catch((error) => {
        console.log(`  [reload sender] ${sender.out}`);
        throw error;
    });
    const hashes = await saveDownloads(page, got, ["big.bin", "small.bin"]);
    for (const n of Object.keys(hashes)) assert.equal(hashes[n], await sha256(join(W, n)), n);
    assert.match(sender.out, /resuming/, "the sender must see a resume, not a restart");
    assert.equal(await exited(sender), 0, sender.out);
    await page.context().close();
});

// a context's OPFS stages, named by rid (derived from the code)
const stageRid = (code) => createHash("sha256").update(`freedrop-stage:${code}`).digest("hex").slice(0, 20);
const stages = (page) => page.evaluate(async () => {
    const top = await (await navigator.storage.getDirectory()).getDirectoryHandle("freedrop", { create: true });
    const names = [];
    for await (const n of top.keys()) names.push(n);
    return names;
});

test("CLI → browser: a finished link reopens as received; its stage is swept once the tab is gone", { timeout: 120_000 }, async (t) => {
    const W = makeDir(join(TMP, "landed"));
    await makeRandom(join(W, "aaa.txt"), 200_000);
    await makeRandom(join(W, "empty.bin"), 0);
    const names = ["aaa.txt", "empty.bin"];
    const sender = startCli(["--no-qr", ...names.map((n) => join(W, n))]);
    t.after(() => sender.kill("SIGKILL"));
    const code = await transferCode(sender);
    const page = await newPage("landed");
    const ctx = page.context();
    t.after(() => ctx.close());
    const first = collectDownloads(page);
    await page.goto(`${BASE}/#${code}`);
    await page.getByRole("button", { name: /Save|保存/ }).click({ timeout: 30_000 });
    await pageDone(page);
    await saveDownloads(page, first, names);
    assert.equal(await exited(sender), 0, sender.out);

    // the sender left when it was done: a reopen must not wait the
    // connection window for it and then call it missing
    const got = collectDownloads(page);
    await page.reload();
    await pageDone(page, 5000);
    assert.match(await page.locator("#hint").textContent(), /can't be received again|不能再接收/);
    await sleep(500);
    assert.equal(got.size, 0, "a reopen must not save every file again unasked");
    const saveAgain = async () => {
        got.clear();
        const hashes = await saveDownloads(page, got, names);
        for (const n of names) assert.equal(hashes[n], await sha256(join(W, n)), n);
    };
    await saveAgain();

    // another link's page sweeps finished stages — not this one while its
    // tab still offers the files
    const rid = stageRid(code);
    const otherCode = randomBytes(32).toString("base64url");
    const other = await ctx.newPage();
    await other.goto(`${BASE}/#${otherCode}`);
    await waitFor(async () => (await stages(other)).includes(stageRid(otherCode)), 10_000, "second stage");
    assert.ok((await stages(other)).includes(rid), "an open tab's received files must survive a sweep");
    await saveAgain();

    // once the tab is gone the next visit reclaims the space; the other
    // link's unfinished stage stays for a resume
    await page.close();
    await other.close();
    const probe = await ctx.newPage();
    await probe.goto(`${BASE}/`);
    await waitFor(() => probe.evaluate(async (rids) => {
        const top = await (await navigator.storage.getDirectory()).getDirectoryHandle("freedrop");
        for (const r of rids) {
            try { await (await (await top.getDirectoryHandle(r)).getFileHandle("meta")).getFile(); } catch { return false; }
        }
        return true;
    }, [rid, stageRid(otherCode)]), 10_000, "closed tabs to release their stages");
    const thirdCode = randomBytes(32).toString("base64url");
    const third = await ctx.newPage();
    await third.goto(`${BASE}/#${thirdCode}`);
    await waitFor(async () => (await stages(third)).includes(stageRid(thirdCode)), 10_000, "third stage");
    const left = await stages(third);
    assert.ok(!left.includes(rid), "a received link's stage must be swept once its tab is gone");
    assert.ok(left.includes(stageRid(otherCode)), "an unfinished stage must be kept for a resume");
});

test("browser sender resumes a SIGKILLed-and-re-run CLI receiver", { timeout: 300_000 }, async () => {
    const W = makeDir(join(TMP, "b-resume"));
    const dst = makeDir(join(W, "dst"));
    await makeRandom(join(W, "big.bin"), 300e6);
    const page = await newPage("b-resume");
    await page.goto(`${BASE}/`);
    await page.setInputFiles("#picker", [join(W, "big.bin")]);
    const code = await waitFor(() => page.locator("#link").textContent()
        .then((s) => s.match(/npx freedrop ([A-Za-z0-9_-]{40,48})/)?.[1]), 30_000, "browser code");
    // a werift receiver is slow enough to guarantee the kill window (the
    // browser sender can't be throttled from here)
    const recv1 = startCli(["-y", "-o", dst, code], { FREEDROP_RTC: "js" });
    await waitFor(() => journalCovered(stageJournal(dst, code)) > 80e6, 120_000, "partial coverage");
    recv1.kill("SIGKILL");
    await sleep(1500);
    const recv2 = startCli(["-y", "-o", dst, code]);
    assert.equal(await exited(recv2, 240_000), 0, recv2.out);
    assert.match(recv2.out, /resuming/);
    assert.equal(await sha256(join(dst, "big.bin")), await sha256(join(W, "big.bin")));
    await page.context().close();
});
