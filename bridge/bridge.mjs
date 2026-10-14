// Claude Speak bridge — runs under Windows node.exe, started by the claude-speak mod.
// Drives tts-worker.mjs (copied from copilot-cli-speak) against that extension's install,
// whose model, ffplay and native addon it reuses. It is fed from a spool folder:
// the mod drops <time>-<n>.json files ({ text, speed, sid, swedish }) and this
// speaks them in order. One bridge per machine; it exits once no Claude session
// has written a heartbeat (hb-*) for a while.
//
//   node bridge.mjs <copilot speak extension dir> <claude-speak home dir>

import { fork } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync, unlinkSync, statSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const [speakDir, homeDir] = process.argv.slice(2);
const SPOOL = join(homeDir, "spool");
const ALIVE = join(homeDir, "bridge.alive");
const LOG_PATH = join(homeDir, "bridge.log");
const HEARTBEAT_TTL = 45_000;

mkdirSync(SPOOL, { recursive: true });

function log(msg) {
    try { appendFileSync(LOG_PATH, `${new Date().toISOString()} [bridge ${process.pid}] ${msg}\n`); } catch {}
}

function ageMs(path) {
    try { return Date.now() - statSync(path).mtimeMs; } catch { return Infinity; }
}

// Singleton: another bridge that touched the alive file recently keeps the job
try {
    const owner = Number(readFileSync(ALIVE, "utf-8"));
    if (owner !== process.pid && ageMs(ALIVE) < 5_000) {
        log(`bridge ${owner} is alive, exiting`);
        process.exit(0);
    }
} catch {}
const touchAlive = () => { try { writeFileSync(ALIVE, String(process.pid)); } catch {} };
touchAlive();
setInterval(touchAlive, 2_000);

// ── Worker ─────────────────────────────────────────────────────────

let worker = null;
let ready = null;
let requestId = 0;
const pending = new Map();

function ensureWorker() {
    if (worker) return ready;
    log("spawning tts-worker");
    ready = new Promise((resolve) => {
        const child = fork(join(homeDir, "tts-worker.mjs"), [speakDir], {
            stdio: ["pipe", "ignore", "ignore", "ipc"],
            windowsHide: true,
            execArgv: [],
        });
        child.on("message", (msg) => {
            if (msg.type === "ready") resolve();
            else if (msg.type === "done" || msg.type === "error") {
                const p = pending.get(msg.id);
                pending.delete(msg.id);
                if (msg.type === "error") log(`worker error: ${msg.error}`);
                p?.();
            }
        });
        child.on("exit", (code) => {
            log(`worker exited with code ${code}`);
            worker = null;
            for (const [id, p] of pending) { pending.delete(id); p(); }
        });
        worker = child;
    });
    return ready;
}

async function speak(req) {
    await ensureWorker();
    const id = ++requestId;
    await new Promise((resolve) => {
        pending.set(id, resolve);
        worker.stdin.write(JSON.stringify({ type: "speak", ...req, id }) + "\n");
    });
}

// ── Spool loop ─────────────────────────────────────────────────────

const startedAt = Date.now();

function hasLiveSession() {
    if (Date.now() - startedAt < HEARTBEAT_TTL) return true;
    return readdirSync(homeDir).some((f) => f.startsWith("hb-") && ageMs(join(homeDir, f)) < HEARTBEAT_TTL);
}

ensureWorker().then(() => log("worker ready"));

for (;;) {
    if (!hasLiveSession()) {
        log("no live Claude session, exiting");
        worker?.kill();
        process.exit(0);
    }
    const jobs = readdirSync(SPOOL).filter((f) => f.endsWith(".json")).sort();
    for (const name of jobs) {
        const path = join(SPOOL, name);
        let req;
        try {
            req = JSON.parse(readFileSync(path, "utf-8"));
        } catch {
            continue; // still being written
        }
        try { unlinkSync(path); } catch {}
        if (!req.text) continue;
        log(`speaking ${name}: "${req.text.slice(0, 60)}"`);
        await speak({ text: req.text, speed: req.speed ?? 1, sid: req.sid ?? 0, swedish: !!req.swedish });
    }
    await new Promise((r) => setTimeout(r, 150));
}
