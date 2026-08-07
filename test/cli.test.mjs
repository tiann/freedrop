// CLI ↔ CLI end-to-end tests over real WebRTC on loopback. Every
// scenario verifies final bytes with sha256; the resume scenarios kill
// processes with SIGKILL mid-transfer — the harshest interruption.
// Interruptible senders run under FREEDROP_BPS so the mid-transfer
// window is deterministic on any machine (an unthrottled loopback can
// finish before the first journal flush).
import test from "node:test";
import assert from "node:assert/strict";
import {
    copyFileSync, existsSync, mkdirSync, readdirSync, statSync, utimesSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import {
    ROOT, startCli, killAll, waitFor, transferCode, exited, sleep,
    makeDir, makeRandom, sha256, stageJournal, journalCovered, journalDone,
} from "./helpers.mjs";

const TMP = makeDir(join(ROOT, "test", ".tmp", "cli"));
const THROTTLE = { FREEDROP_BPS: "80000000" }; // ~80 MB/s → seconds-wide windows
const NO_HARDLINK = {
    NODE_OPTIONS: "--import=data:text/javascript,import%20fs%20from%20%22node%3Afs%22%3B" +
        "import%7BsyncBuiltinESMExports%20as%20s%7Dfrom%22node%3Amodule%22%3B" +
        "fs.linkSync%3D()%3D%3E%7Bconst%20e%3Dnew%20Error(%22forced%22)%3B" +
        "e.code%3D%22EPERM%22%3Bthrow%20e%7D%3Bs()%3B",
};

const noStage = (dst) => !existsSync(join(dst, ".freedrop-stage"));

test.after(() => killAll());

test("fresh transfer: striped big + small + empty, verified", { timeout: 240_000 }, async () => {
    const W = makeDir(join(TMP, "fresh"));
    const dst = makeDir(join(W, "dst"));
    await makeRandom(join(W, "big.bin"), 100e6); // > STRIPE_MIN
    await makeRandom(join(W, "small.bin"), 3e6);
    await makeRandom(join(W, "empty.bin"), 0);
    const sender = startCli(["--no-qr", join(W, "big.bin"), join(W, "small.bin"), join(W, "empty.bin")]);
    const code = await transferCode(sender);
    const recv = startCli(["-y", "-o", dst, code]);
    assert.equal(await exited(recv), 0, recv.out);
    assert.equal(await exited(sender), 0, sender.out);
    for (const n of ["big.bin", "small.bin", "empty.bin"]) {
        assert.equal(await sha256(join(dst, n)), await sha256(join(W, n)), n);
    }
    assert.ok(noStage(dst), "staging directory cleaned up");
});

test("receiver SIGKILLed mid-transfer, re-run resumes", { timeout: 300_000 }, async () => {
    const W = makeDir(join(TMP, "kill-recv"));
    const dst = makeDir(join(W, "dst"));
    await makeRandom(join(W, "big.bin"), 400e6);
    const sender = startCli(["--no-qr", join(W, "big.bin")], THROTTLE);
    const code = await transferCode(sender);
    const recv1 = startCli(["-y", "-o", dst, code]);
    await waitFor(() => journalCovered(stageJournal(dst, code)) > 100e6, 120_000, "partial coverage");
    recv1.kill("SIGKILL");
    await sleep(1000);
    const recv2 = startCli(["-y", "-o", dst, code]);
    assert.equal(await exited(recv2), 0, recv2.out);
    assert.match(recv2.out, /resuming/, "second run must resume, not restart");
    assert.equal(await exited(sender), 0, sender.out);
    assert.equal(await sha256(join(dst, "big.bin")), await sha256(join(W, "big.bin")));
    assert.ok(noStage(dst), "staging directory cleaned up");
});

test("sender SIGKILLed mid-transfer, --code re-run reconnects the waiting receiver", { timeout: 300_000 }, async () => {
    const W = makeDir(join(TMP, "kill-send"));
    const dst = makeDir(join(W, "dst"));
    await makeRandom(join(W, "big.bin"), 400e6);
    const sender1 = startCli(["--no-qr", join(W, "big.bin")], THROTTLE);
    const code = await transferCode(sender1);
    const recv = startCli(["-y", "-o", dst, code]);
    await waitFor(() => journalCovered(stageJournal(dst, code)) > 100e6, 120_000, "partial coverage");
    sender1.kill("SIGKILL");
    await sleep(2000);
    const sender2 = startCli(["--no-qr", "--code", code, join(W, "big.bin")]);
    assert.equal(await exited(recv, 240_000), 0, recv.out); // rides out the ~20 s stall detection
    assert.match(sender2.out, /resuming/, "the new sender must resume, not restart");
    assert.equal(await exited(sender2), 0, sender2.out);
    assert.equal(await sha256(join(dst, "big.bin")), await sha256(join(W, "big.bin")));
});

test("werift fallback engine (FREEDROP_RTC=js) resumes too", { timeout: 300_000 }, async () => {
    const W = makeDir(join(TMP, "werift"));
    const dst = makeDir(join(W, "dst"));
    await makeRandom(join(W, "big.bin"), 120e6);
    const sender = startCli(["--no-qr", join(W, "big.bin")], { FREEDROP_BPS: "40000000" });
    const code = await transferCode(sender);
    const recv1 = startCli(["-y", "-o", dst, code], { FREEDROP_RTC: "js" });
    await waitFor(() => journalCovered(stageJournal(dst, code)) > 30e6, 120_000, "partial coverage");
    recv1.kill("SIGKILL");
    await sleep(1000);
    const recv2 = startCli(["-y", "-o", dst, code], { FREEDROP_RTC: "js" });
    assert.equal(await exited(recv2, 240_000), 0, recv2.out);
    assert.match(recv2.out, /resuming/);
    assert.equal(await exited(sender), 0, sender.out);
    assert.equal(await sha256(join(dst, "big.bin")), await sha256(join(W, "big.bin")));
});

test("changed source rejects the stale journal, name stays clean", { timeout: 300_000 }, async () => {
    const W = makeDir(join(TMP, "stale"));
    const dst = makeDir(join(W, "dst"));
    await makeRandom(join(W, "big.bin"), 120e6);
    const sender1 = startCli(["--no-qr", join(W, "big.bin")], { FREEDROP_BPS: "40000000" });
    const code = await transferCode(sender1);
    const recv1 = startCli(["-y", "-o", dst, code]);
    await waitFor(() => journalCovered(stageJournal(dst, code)) > 20e6, 120_000, "partial coverage");
    recv1.kill("SIGKILL");
    sender1.kill("SIGKILL");
    await makeRandom(join(W, "big.bin"), 120e6); // same size, new content + mtime
    const sender2 = startCli(["--no-qr", "--code", code, join(W, "big.bin")]);
    const recv2 = startCli(["-y", "-o", dst, code]);
    assert.equal(await exited(recv2), 0, recv2.out);
    assert.doesNotMatch(recv2.out, /resuming/, "a stale journal must not resume");
    assert.equal(await exited(sender2), 0, sender2.out);
    assert.equal(await sha256(join(dst, "big.bin")), await sha256(join(W, "big.bin")));
    assert.ok(!readdirSync(dst).some((n) => n.includes("(1)")), "name stays clean");
    assert.ok(noStage(dst), "stale staging reclaimed and cleaned up");
});

test("done markers: a verified file survives an interrupted multi-file run", { timeout: 300_000 }, async () => {
    const W = makeDir(join(TMP, "done-marker"));
    const dst = makeDir(join(W, "dst"));
    await makeRandom(join(W, "first.bin"), 80e6);
    await makeRandom(join(W, "second.bin"), 400e6);
    const sender = startCli(["--no-qr", join(W, "first.bin"), join(W, "second.bin")], THROTTLE);
    const code = await transferCode(sender);
    // First run stores a relative output path; the resume names the same
    // directory absolutely from another cwd. Completed markers must not
    // depend on the cwd that wrote them.
    const recv1 = startCli(["-y", "-o", "dst", code], {}, { cwd: W });
    await waitFor(() =>
        existsSync(join(dst, "first.bin"))
        && journalDone(stageJournal(dst, code, 0))
        && existsSync(stageJournal(dst, code, 1)),
    120_000, "first verified while second is partial");
    recv1.kill("SIGKILL");
    await sleep(1000);
    const recv2 = startCli(["-y", "-o", dst, code], {}, { cwd: ROOT });
    assert.equal(await exited(recv2), 0, recv2.out);
    assert.match(recv2.out, /resuming/);
    assert.equal(await exited(sender), 0, sender.out);
    const names = readdirSync(dst);
    assert.ok(!names.some((n) => n.includes("(1)")), `no duplicates, got: ${names}`);
    assert.ok(noStage(dst), "staging (incl. done markers) cleaned up");
    for (const n of ["first.bin", "second.bin"]) {
        assert.equal(await sha256(join(dst, n)), await sha256(join(W, n)), n);
    }
});

test("an unrelated transfer never touches a paused transfer's staging", { timeout: 300_000 }, async () => {
    const W = makeDir(join(TMP, "foreign"));
    const dst = makeDir(join(W, "dst"));
    const srcA = makeDir(join(W, "srcA"));
    const srcB = makeDir(join(W, "srcB"));
    await makeRandom(join(srcA, "report.bin"), 240e6);
    await makeRandom(join(srcB, "report.bin"), 60e6);
    // transfer A pauses mid-flight (both ends killed)
    const senderA = startCli(["--no-qr", join(srcA, "report.bin")], THROTTLE);
    const codeA = await transferCode(senderA);
    const recvA = startCli(["-y", "-o", dst, codeA]);
    await waitFor(() => journalCovered(stageJournal(dst, codeA)) > 40e6, 120_000, "A partial");
    recvA.kill("SIGKILL");
    senderA.kill("SIGKILL");
    const covA = journalCovered(stageJournal(dst, codeA));
    // unrelated transfer B, same filename, same directory — staging is
    // disjoint by construction; names are claimed at landing time, so B
    // (finishing first) takes the clean name
    const senderB = startCli(["--no-qr", join(srcB, "report.bin")]);
    const codeB = await transferCode(senderB);
    const recvB = startCli(["-y", "-o", dst, codeB]);
    assert.equal(await exited(recvB), 0, recvB.out);
    assert.equal(await exited(senderB), 0, senderB.out);
    assert.equal(journalCovered(stageJournal(dst, codeA)), covA, "A's journal untouched");
    assert.equal(await sha256(join(dst, "report.bin")), await sha256(join(srcB, "report.bin")));
    // A still resumes, landing beside B
    const senderA2 = startCli(["--no-qr", "--code", codeA, join(srcA, "report.bin")]);
    const recvA2 = startCli(["-y", "-o", dst, codeA]);
    assert.equal(await exited(recvA2), 0, recvA2.out);
    assert.match(recvA2.out, /resuming/);
    assert.equal(await exited(senderA2), 0, senderA2.out);
    assert.equal(await sha256(join(dst, "report(1).bin")), await sha256(join(srcA, "report.bin")));
});

test("identical metadata from a different code never claims a paused partial", { timeout: 300_000 }, async () => {
    const W = makeDir(join(TMP, "strict-rid"));
    const dst = makeDir(join(W, "dst"));
    const srcA = makeDir(join(W, "srcA"));
    const srcB = makeDir(join(W, "srcB"));
    await makeRandom(join(srcA, "data.bin"), 240e6);
    await makeRandom(join(srcB, "data.bin"), 240e6); // same size, different bytes
    const stA = statSync(join(srcA, "data.bin"));
    utimesSync(join(srcB, "data.bin"), stA.atime, stA.mtime); // …and same mtime
    // transfer A pauses mid-flight
    const senderA = startCli(["--no-qr", join(srcA, "data.bin")], THROTTLE);
    const codeA = await transferCode(senderA);
    const recvA = startCli(["-y", "-o", dst, codeA]);
    await waitFor(() => journalCovered(stageJournal(dst, codeA)) > 40e6, 120_000, "A partial");
    recvA.kill("SIGKILL");
    senderA.kill("SIGKILL");
    const covA = journalCovered(stageJournal(dst, codeA));
    // transfer B: indistinguishable by metadata, different content — it
    // must not claim (and thereby pollute + lose) A's stage
    const senderB = startCli(["--no-qr", join(srcB, "data.bin")]);
    const codeB = await transferCode(senderB);
    const recvB = startCli(["-y", "-o", dst, codeB]);
    assert.equal(await exited(recvB), 0, recvB.out);
    assert.doesNotMatch(recvB.out, /resuming/, "B must not claim A's partial");
    assert.equal(await exited(senderB), 0, senderB.out);
    assert.equal(journalCovered(stageJournal(dst, codeA)), covA, "A's journal untouched");
    assert.equal(await sha256(join(dst, "data.bin")), await sha256(join(srcB, "data.bin")));
    // and A still resumes
    const senderA2 = startCli(["--no-qr", "--code", codeA, join(srcA, "data.bin")]);
    const recvA2 = startCli(["-y", "-o", dst, codeA]);
    assert.equal(await exited(recvA2), 0, recvA2.out);
    assert.match(recvA2.out, /resuming/);
    assert.equal(await exited(senderA2), 0, senderA2.out);
    assert.equal(await sha256(join(dst, "data(1).bin")), await sha256(join(srcA, "data.bin")));
});

test("a done-marked file is re-verified against the current run's hash", { timeout: 300_000 }, async () => {
    const W = makeDir(join(TMP, "done-reverify"));
    const dst = makeDir(join(W, "dst"));
    await makeRandom(join(W, "first.bin"), 80e6);
    await makeRandom(join(W, "second.bin"), 300e6);
    const oldHash = await sha256(join(W, "first.bin"));
    const sender1 = startCli(["--no-qr", join(W, "first.bin"), join(W, "second.bin")], THROTTLE);
    const code = await transferCode(sender1);
    const recv1 = startCli(["-y", "-o", dst, code]);
    await waitFor(() =>
        existsSync(join(dst, "first.bin"))
        && journalDone(stageJournal(dst, code, 0))
        && existsSync(stageJournal(dst, code, 1)),
    120_000, "first verified while second is partial");
    recv1.kill("SIGKILL");
    sender1.kill("SIGKILL");
    // swap first.bin's content, preserving size AND mtime — metadata
    // alone can no longer tell the difference
    const st = statSync(join(W, "first.bin"));
    await makeRandom(join(W, "first.bin"), 80e6);
    utimesSync(join(W, "first.bin"), st.atime, st.mtime);
    const sender2 = startCli(["--no-qr", "--code", code, join(W, "first.bin"), join(W, "second.bin")]);
    const recv2 = startCli(["-y", "-o", dst, code]);
    assert.notEqual(await exited(recv2), 0, "claiming success with old bytes would be a lie");
    assert.match(recv2.out, /no longer matches/, recv2.out);
    assert.equal(await sha256(join(dst, "first.bin")), oldHash, "the finished old copy is kept");
    assert.ok(!existsSync(stageJournal(dst, code, 0)), "stale done marker dropped");
    sender2.kill("SIGKILL");
    await sleep(1000);
    // next run transfers the new version beside the old one
    const sender3 = startCli(["--no-qr", "--code", code, join(W, "first.bin"), join(W, "second.bin")]);
    const recv3 = startCli(["-y", "-o", dst, code]);
    assert.equal(await exited(recv3), 0, recv3.out);
    assert.equal(await exited(sender3), 0, sender3.out);
    assert.equal(await sha256(join(dst, "first.bin")), oldHash);
    assert.equal(await sha256(join(dst, "first(1).bin")), await sha256(join(W, "first.bin")));
    assert.equal(await sha256(join(dst, "second.bin")), await sha256(join(W, "second.bin")));
});

test("hostile filenames (foo.part, foo.part.state.tmp) land intact under their own names", { timeout: 240_000 }, async () => {
    const W = makeDir(join(TMP, "hostile-names"));
    const dst = makeDir(join(W, "dst"));
    await makeRandom(join(W, "foo"), 5e6);
    await makeRandom(join(W, "foo.part"), 7e6);
    await makeRandom(join(W, "foo.part.state.tmp"), 3e6);
    // pre-existing files that used to be staging-suffix collision bait
    await makeRandom(join(dst, "bar.part"), 1e6);
    const barPartHash = await sha256(join(dst, "bar.part"));
    const sender = startCli([
        "--no-qr", join(W, "foo"), join(W, "foo.part"), join(W, "foo.part.state.tmp"),
    ]);
    const code = await transferCode(sender);
    const recv = startCli(["-y", "-o", dst, code]);
    assert.equal(await exited(recv), 0, recv.out);
    assert.equal(await exited(sender), 0, sender.out);
    // staging is opaque, so none of these names collide with it — every
    // file keeps its exact original name
    for (const n of ["foo", "foo.part", "foo.part.state.tmp"]) {
        assert.equal(await sha256(join(dst, n)), await sha256(join(W, n)), n);
    }
    assert.equal(await sha256(join(dst, "bar.part")), barPartHash, "pre-existing file untouched");
    assert.ok(noStage(dst));
});

test("no-hardlink receivers claim colliding final names without partial or lost files", { timeout: 240_000 }, async () => {
    const W = makeDir(join(TMP, "no-hardlink-race"));
    const dst = makeDir(join(W, "dst"));
    const a = makeDir(join(W, "a"));
    const b = makeDir(join(W, "b"));
    await makeRandom(join(a, "same.bin"), 20e6);
    await makeRandom(join(b, "same.bin"), 20e6);
    const senderA = startCli(["--no-qr", join(a, "same.bin")]);
    const senderB = startCli(["--no-qr", join(b, "same.bin")]);
    const [codeA, codeB] = await Promise.all([transferCode(senderA), transferCode(senderB)]);
    const recvA = startCli(["-y", "-o", dst, codeA], NO_HARDLINK);
    const recvB = startCli(["-y", "-o", dst, codeB], NO_HARDLINK);
    assert.equal(await exited(recvA), 0, recvA.out);
    assert.equal(await exited(recvB), 0, recvB.out);
    assert.equal(await exited(senderA), 0, senderA.out);
    assert.equal(await exited(senderB), 0, senderB.out);
    const got = await Promise.all([sha256(join(dst, "same.bin")), sha256(join(dst, "same(1).bin"))]);
    const want = await Promise.all([sha256(join(a, "same.bin")), sha256(join(b, "same.bin"))]);
    assert.deepEqual(got.sort(), want.sort());
    assert.ok(noStage(dst));
});

test("a crash after atomic rename resumes from the claiming marker", { timeout: 240_000 }, async () => {
    const W = makeDir(join(TMP, "claiming-after-rename"));
    const dst = makeDir(join(W, "dst"));
    const src = join(W, "file.bin");
    await makeRandom(src, 5e6);
    const st = statSync(src);
    const code = randomBytes(32).toString("base64url");
    const journal = stageJournal(dst, code);
    mkdirSync(dirname(journal), { recursive: true });
    copyFileSync(src, join(dst, "file.bin")); // rename landed; stage path is gone
    writeFileSync(journal, JSON.stringify({
        v: 3, name: "file.bin", size: st.size, mtime: Math.round(st.mtimeMs),
        claiming: true, finalName: "file.bin",
    }));
    const sender = startCli(["--no-qr", "--code", code, src]);
    await transferCode(sender);
    const recv = startCli(["-y", "-o", dst, code]);
    assert.equal(await exited(recv), 0, recv.out);
    assert.equal(await exited(sender), 0, sender.out);
    assert.equal(await sha256(join(dst, "file.bin")), await sha256(src));
    assert.ok(!existsSync(join(dst, "file(1).bin")));
    assert.ok(noStage(dst));
});

test("a pre-claim marker never adopts an unrelated same-size final file", { timeout: 240_000 }, async () => {
    const W = makeDir(join(TMP, "claiming-before-land"));
    const dst = makeDir(join(W, "dst"));
    const src = join(W, "file.bin");
    await makeRandom(src, 5e6);
    await makeRandom(join(dst, "file.bin"), 5e6);
    const foreignHash = await sha256(join(dst, "file.bin"));
    const st = statSync(src);
    const code = randomBytes(32).toString("base64url");
    const journal = stageJournal(dst, code);
    mkdirSync(dirname(journal), { recursive: true });
    copyFileSync(src, journal.replace(/\.json$/, ".part"));
    writeFileSync(journal, JSON.stringify({
        v: 3, name: "file.bin", size: st.size, mtime: Math.round(st.mtimeMs),
        claiming: true, finalName: "file.bin",
    }));
    const sender = startCli(["--no-qr", "--code", code, src]);
    await transferCode(sender);
    const recv = startCli(["-y", "-o", dst, code], NO_HARDLINK);
    assert.equal(await exited(recv), 0, recv.out);
    assert.equal(await exited(sender), 0, sender.out);
    assert.equal(await sha256(join(dst, "file.bin")), foreignHash);
    assert.equal(await sha256(join(dst, "file(1).bin")), await sha256(src));
    assert.ok(noStage(dst));
});

test("a code that starts with a dash parses as a code, not an option", { timeout: 240_000 }, async () => {
    const W = makeDir(join(TMP, "dash-code"));
    const dst = makeDir(join(W, "dst"));
    await makeRandom(join(W, "f.bin"), 3e6);
    // base64url of a key whose first 6 bits are 62 → the code begins "-"
    const code = Buffer.concat([Buffer.from([0xf8]), randomBytes(31)]).toString("base64url");
    assert.ok(code.startsWith("-"), code);
    const sender = startCli(["--no-qr", "--code", code, join(W, "f.bin")]);
    await transferCode(sender);
    const recv = startCli(["-y", "-o", dst, code]);
    assert.equal(await exited(recv), 0, recv.out);
    assert.equal(await exited(sender), 0, sender.out);
    assert.equal(await sha256(join(dst, "f.bin")), await sha256(join(W, "f.bin")));
});

test("twin files (same name/size/mtime, different bytes) resume-pair by manifest slot", { timeout: 300_000 }, async () => {
    const W = makeDir(join(TMP, "twins"));
    const dst = makeDir(join(W, "dst"));
    const d1 = makeDir(join(W, "d1"));
    const d2 = makeDir(join(W, "d2"));
    await makeRandom(join(d1, "dup.bin"), 150e6);
    await makeRandom(join(d2, "dup.bin"), 150e6);
    const st = statSync(join(d1, "dup.bin"));
    utimesSync(join(d2, "dup.bin"), st.atime, st.mtime);
    const sender = startCli(["--no-qr", join(d1, "dup.bin"), join(d2, "dup.bin")], THROTTLE);
    const code = await transferCode(sender);
    const recv1 = startCli(["-y", "-o", dst, code]);
    // wait until the SECOND twin has a journal too, so the re-run must
    // pair two indistinguishable-by-metadata journals — only the slot
    // can do that correctly
    await waitFor(() => journalCovered(stageJournal(dst, code, 1)) > 30e6, 120_000, "second twin partial");
    recv1.kill("SIGKILL");
    await sleep(1000);
    const recv2 = startCli(["-y", "-o", dst, code]);
    assert.equal(await exited(recv2), 0, recv2.out);
    assert.match(recv2.out, /resuming/);
    assert.equal(await exited(sender), 0, sender.out);
    assert.equal(await sha256(join(dst, "dup.bin")), await sha256(join(d1, "dup.bin")));
    assert.equal(await sha256(join(dst, "dup(1).bin")), await sha256(join(d2, "dup.bin")));
});
