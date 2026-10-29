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
import { randomBytes } from "node:crypto";
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
const MIME = { html: "text/html", js: "text/javascript", mjs: "text/javascript" };
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

const pageDone = (page, ms = 120_000) =>
    waitFor(() => page.locator("#status").textContent().then((s) => s.includes("✓")), ms, "✓ in #status");

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
    await pageDone(page);
    const hashes = await saveDownloads(page, got, ["big.bin", "small.bin"]);
    for (const n of Object.keys(hashes)) assert.equal(hashes[n], await sha256(join(W, n)), n);
    assert.match(sender.out, /resuming/, "the sender must see a resume, not a restart");
    assert.equal(await exited(sender), 0, sender.out);
    await page.context().close();
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
