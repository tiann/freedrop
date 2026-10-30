// Shared plumbing for the freedrop end-to-end tests: real CLI processes,
// real WebRTC over loopback, sha256 over every byte. Signaling goes to
// the public brokers by default; set FREEDROP_TEST_BROKER to a local
// ws:// MQTT broker for a hermetic run (CI does — see the workflow).
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, readFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const CLI = join(ROOT, "cli.mjs");
export const TEST_BROKER = process.env.FREEDROP_TEST_BROKER ?? "";
const BROKER_ARGS = TEST_BROKER ? ["--broker", TEST_BROKER] : [];

const kids = new Set();

export function startCli(args, env = {}, options = {}) {
    const p = spawn(process.execPath, [CLI, ...args, ...BROKER_ARGS], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...env },
        ...options,
    });
    p.out = ""; // stdout + stderr, as a person would see them
    p.stdoutText = "";
    p.stdout.on("data", (d) => { p.out += d; p.stdoutText += d; });
    p.stderr.on("data", (d) => { p.out += d; });
    kids.add(p);
    p.on("exit", () => kids.delete(p));
    return p;
}

export function killAll() {
    for (const p of kids) { try { p.kill("SIGKILL"); } catch {} }
}

export const waitFor = (fn, ms, what) => new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(async () => {
        try {
            const v = await fn();
            if (v) { clearInterval(iv); resolve(v); }
            else if (Date.now() - t0 > ms) {
                clearInterval(iv);
                reject(new Error(`timeout waiting for ${what}`));
            }
        } catch (e) { clearInterval(iv); reject(e); }
    }, 100);
});

export const transferCode = (proc) =>
    waitFor(() => proc.out.match(/npx freedrop ([A-Za-z0-9_-]{40,48})/)?.[1], 30_000, "transfer code");

export const exited = (proc, ms = 180_000) =>
    waitFor(() => proc.exitCode !== null, ms, "process exit").then(() => proc.exitCode);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// a --json process's stdout: every line must be one JSON event
export const events = (proc) => proc.stdoutText.split("\n").filter(Boolean).map((l) => JSON.parse(l));

export function makeDir(p) {
    rmSync(p, { recursive: true, force: true });
    mkdirSync(p, { recursive: true });
    return p;
}

export async function makeRandom(path, bytes) {
    const ws = createWriteStream(path);
    for (let left = bytes; left > 0;) {
        const n = Math.min(left, 8 * 1024 * 1024);
        if (!ws.write(randomBytes(n))) await new Promise((r) => ws.once("drain", r));
        left -= n;
    }
    await new Promise((res, rej) => ws.end((e) => (e ? rej(e) : res())));
}

export const sha256 = (path) => new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(path)
        .on("data", (d) => h.update(d))
        .on("end", () => resolve(h.digest("hex")))
        .on("error", reject);
});

// the receiver-side journal for manifest slot i of a transfer — staging
// lives in <dir>/.freedrop-stage/<rid>/ where rid derives from the code
export function stageJournal(dir, code, i = 0) {
    const rid = createHash("sha256").update(`freedrop-stage:${code}`).digest("hex").slice(0, 20);
    return join(dir, ".freedrop-stage", rid, `${i}.json`);
}

// bytes a receiver's journal says are durably on disk (0 if absent/torn)
export function journalCovered(statePath) {
    try {
        const j = JSON.parse(readFileSync(statePath, "utf8"));
        return Array.isArray(j.ranges) ? j.ranges.reduce((n, [s, e]) => n + e - s, 0) : 0;
    } catch { return 0; }
}

export function journalDone(statePath) {
    try { return JSON.parse(readFileSync(statePath, "utf8")).done === true; } catch { return false; }
}
