// Small synchronous lease lock used by the CLI receiver.
//
// The lock itself is a directory. mkdir is the atomic ownership step;
// owner.json is written immediately afterwards. A contender treats a fresh,
// not-yet-initialized directory as live. Recovery is serialized by a separate
// exclusive-create file. That recovery file is deliberately never reclaimed
// automatically: check-then-unlink of a fixed reclaim pathname has an ABA race
// and can delete a newer owner's guard. A crash in the tiny recovery section
// therefore fails safe and asks for manual removal instead of admitting two
// owners into the same critical section.

import {
    existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

const INIT_GRACE_MS = 5000;

const sleepSync = (ms) => {
    try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {}
};

const lockError = (code, message, path) => {
    const err = new Error(message);
    err.code = code;
    err.path = path;
    return err;
};

function ownerState(lockPath) {
    let st;
    try { st = statSync(lockPath); } catch (e) {
        if (e.code === "ENOENT") return "missing";
        throw e;
    }

    let pid = 0;
    try {
        if (st.isDirectory()) {
            pid = Number(JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8")).pid);
        } else { // migrate a lock left by the pre-directory implementation
            pid = Number(readFileSync(lockPath, "utf8"));
        }
    } catch {}

    if (Number.isInteger(pid) && pid > 0) {
        if (pid === process.pid) return "live";
        try {
            process.kill(pid, 0);
            return "live";
        } catch (e) {
            if (e.code === "EPERM") return "live";
            return "dead";
        }
    }
    return Date.now() - st.mtimeMs < INIT_GRACE_MS ? "initializing" : "dead";
}

export function acquireLeaseLock(lockPath, { waitMs = 0, pollMs = 50 } = {}) {
    const reclaimPath = lockPath + ".reclaim";
    const deadline = Date.now() + waitMs;
    const token = `${process.pid}-${randomBytes(12).toString("hex")}`;

    const waitOrThrow = (code, message, path = lockPath) => {
        if (Date.now() < deadline) {
            sleepSync(pollMs);
            return true;
        }
        throw lockError(code, message, path);
    };

    for (;;) {
        // No new owner may appear while a reclaimer is between its final
        // validation and removal of the old generation.
        if (existsSync(reclaimPath)) {
            if (waitOrThrow(
                "ELOCKRECOVERY",
                `lock recovery was interrupted; remove ${reclaimPath} only if no freedrop receiver is running`,
                reclaimPath,
            )) continue;
        }

        let created = false;
        try {
            mkdirSync(lockPath);
            created = true;
            writeFileSync(
                join(lockPath, "owner.json"),
                JSON.stringify({ v: 1, pid: process.pid, token, t: Date.now() }),
                { flag: "wx" },
            );
            // Close the pre-check/create race: a reclaimer that started from
            // the previous generation may have appeared meanwhile. Yield our
            // fresh lock and let that serialized recovery finish.
            if (existsSync(reclaimPath)) {
                rmSync(lockPath, { recursive: true, force: true });
                created = false;
                if (waitOrThrow(
                    "ELOCKRECOVERY",
                    `lock recovery was interrupted; remove ${reclaimPath} only if no freedrop receiver is running`,
                    reclaimPath,
                )) continue;
            }

            let released = false;
            return () => {
                if (released) return;
                released = true;
                try {
                    const owner = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8"));
                    if (owner.pid === process.pid && owner.token === token) {
                        rmSync(lockPath, { recursive: true, force: true });
                    }
                } catch {}
            };
        } catch (e) {
            if (created) {
                rmSync(lockPath, { recursive: true, force: true });
                throw e;
            }
            if (e.code !== "EEXIST") throw e;
        }

        const state = ownerState(lockPath);
        if (state === "missing") continue;
        if (state === "live" || state === "initializing") {
            if (waitOrThrow("ELOCKED", `lock is held by another freedrop process`, lockPath)) continue;
        }

        try {
            writeFileSync(
                reclaimPath,
                JSON.stringify({ v: 1, pid: process.pid, token, t: Date.now() }),
                { flag: "wx" },
            );
        } catch (e) {
            if (e.code !== "EEXIST") throw e;
            if (waitOrThrow(
                "ELOCKRECOVERY",
                `lock recovery was interrupted; remove ${reclaimPath} only if no freedrop receiver is running`,
                reclaimPath,
            )) continue;
        }

        try {
            // Revalidate while every conforming creator is excluded by the
            // reclaim file. This is the only code path that removes a lock it
            // did not create.
            const current = ownerState(lockPath);
            if (current === "live" || current === "initializing") {
                if (waitOrThrow("ELOCKED", `lock is held by another freedrop process`, lockPath)) continue;
            }
            if (current !== "missing") rmSync(lockPath, { recursive: true, force: true });
        } finally {
            rmSync(reclaimPath, { force: true });
        }
    }
}
