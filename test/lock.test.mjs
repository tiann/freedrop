import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
    existsSync, mkdirSync, rmSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, makeDir } from "./helpers.mjs";
import { acquireLeaseLock } from "../lock.mjs";

const TMP = makeDir(join(ROOT, "test", ".tmp", "lock"));

const deadOwner = (lockPath) => {
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(join(lockPath, "owner.json"), JSON.stringify({
        v: 1, pid: 2147483647, token: "dead", t: 0,
    }));
};

test("stale lock recovery admits only one critical-section owner", { timeout: 30_000 }, async () => {
    const W = makeDir(join(TMP, "contention"));
    const lockPath = join(W, "lock");
    const critical = join(W, "critical");
    deadOwner(lockPath);
    const moduleUrl = pathToFileURL(join(ROOT, "lock.mjs")).href;
    const worker = [
        `import { acquireLeaseLock } from ${JSON.stringify(moduleUrl)};`,
        `import { mkdirSync, rmdirSync } from "node:fs";`,
        `const release=acquireLeaseLock(process.argv[1],{waitMs:10000,pollMs:5});`,
        `try{mkdirSync(process.argv[2]);}catch{process.exit(9)}`,
        `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30);`,
        `rmdirSync(process.argv[2]);release();`,
    ].join("");
    const runs = Array.from({ length: 32 }, () => new Promise((resolve, reject) => {
        const p = spawn(process.execPath, ["--input-type=module", "-e", worker, lockPath, critical]);
        let err = "";
        p.stderr.on("data", (d) => { err += d; });
        p.on("exit", (code) => code === 0 ? resolve() : reject(new Error(err || `exit ${code}`)));
    }));
    await Promise.all(runs);
    assert.ok(!existsSync(critical));
    assert.ok(!existsSync(lockPath + ".reclaim"));
});

test("an abandoned reclaim guard fails safe instead of deleting a newer owner", () => {
    const W = makeDir(join(TMP, "stale-reclaim"));
    const lockPath = join(W, "lock");
    deadOwner(lockPath);
    writeFileSync(lockPath + ".reclaim", "dead reclaimer");
    assert.throws(
        () => acquireLeaseLock(lockPath, { waitMs: 25, pollMs: 5 }),
        (e) => e.code === "ELOCKRECOVERY",
    );
    assert.ok(existsSync(lockPath), "the observed lock generation was not removed");
    rmSync(lockPath + ".reclaim");
    const release = acquireLeaseLock(lockPath, { waitMs: 1000, pollMs: 5 });
    release();
    assert.ok(!existsSync(lockPath));
});
