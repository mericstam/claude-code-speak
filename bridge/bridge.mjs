// Claude Speak bridge — started by the kokoro-speak mod, under Linux node or Windows node.exe.
// Sets up its home on first use (sherpa-onnx-node and franc-all from npm, the Kokoro model),
// then feeds tts-worker.mjs from a spool folder: the mod drops <time>-<n>.json files
// ({ text, speed, sid, languages }) and this speaks them in order. A Piper voice for each of
// `languages` ([{ franc, voice }]) is downloaded in the background the first time it is asked
// for; a { prepare: true, languages } file only starts those downloads. One bridge per home; it
// exits once no Claude session has written a heartbeat (hb-*) for a while.
//
//   node bridge.mjs <claude-speak home>

import { fork, execFile } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync, unlinkSync, statSync, mkdirSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const homeDir = process.argv[2];
const SPOOL = join(homeDir, "spool");
const MODELS = join(homeDir, "models");
const ALIVE = join(homeDir, "bridge.alive");
const STATUS = join(homeDir, "status.txt");
const LOG_PATH = join(homeDir, "bridge.log");
const HEARTBEAT_TTL = 45_000;
const STALE_HEARTBEAT = 3_600_000;
const PACKAGES = ["sherpa-onnx-node@1.12.40", "franc-all@7.2.0"];

const MODEL = {
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-en-v0_19.tar.bz2",
    dir: join(MODELS, "kokoro-en-v0_19"),
    marker: "model.onnx",
    label: "Kokoro model (~305MB)",
    key: "kokoro-en-v0_19",
};
const piperModel = (voice) => ({
    url: `https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-${voice}.tar.bz2`,
    dir: join(MODELS, `vits-piper-${voice}`),
    marker: `${voice}.onnx`,
    label: `Piper voice ${voice}`,
    key: voice,
});

mkdirSync(SPOOL, { recursive: true });

function log(msg) {
    try { appendFileSync(LOG_PATH, `${new Date().toISOString()} [bridge ${process.pid}] ${msg}\n`); } catch {}
}

// What the mod shows: "setup: …" while installing, "ready", or "error: …"
function status(text) {
    log(text);
    try { writeFileSync(STATUS, text); } catch {}
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

// ── Setup ──────────────────────────────────────────────────────────

function run(cmd, args, options = {}) {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, { timeout: 600_000, windowsHide: true, ...options }, (err, _out, stderr) =>
            err ? reject(new Error(`${cmd} failed: ${stderr || err.message}`)) : resolve());
    });
}

async function ensurePackages() {
    const missing = PACKAGES.filter((p) => !existsSync(join(homeDir, "node_modules", p.slice(0, p.lastIndexOf("@")))));
    if (!missing.length) return;
    status(`setup: installing ${missing.join(", ")}…`);
    if (process.platform === "win32") {
        // npm is a .cmd script on Windows, which only a shell runs
        await run(`npm.cmd install --prefix "${homeDir}" ${missing.join(" ")} --no-audit --no-fund`, [], { shell: true });
    } else {
        await run("npm", ["install", "--prefix", homeDir, ...missing, "--no-audit", "--no-fund"]);
    }
}

// Downloads a .tar.bz2 into models/ (the archive's top-level folder is the model's dir).
// While it runs, models/.download-<key>.tar.bz2 exists: the mod reads that as "downloading".
// Resolves true when it downloaded, false when the model was already there.
async function ensureModel({ url, dir, marker, label, key }, report = status) {
    if (existsSync(join(dir, marker))) return false;
    report(`setup: downloading ${label}…`);
    mkdirSync(MODELS, { recursive: true });
    const tarPath = join(MODELS, `.download-${key}.tar.bz2`);
    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
        writeFileSync(tarPath, Buffer.from(await response.arrayBuffer()));
        await run("tar", ["-xf", tarPath, "-C", MODELS]);
    } finally {
        try { unlinkSync(tarPath); } catch {}
    }
    return true;
}

const voiceDownloads = new Map(); // voice id → its download, while it runs
function ensureVoices(languages = []) {
    for (const { voice } of languages) {
        if (!voice || voiceDownloads.has(voice)) continue;
        const download = ensureModel(piperModel(voice), log)
            .then((downloaded) => downloaded && log(`Piper voice ${voice} ready`))
            .catch((err) => log(`Piper voice ${voice} download failed: ${err.message}`))
            .finally(() => voiceDownloads.delete(voice));
        voiceDownloads.set(voice, download);
    }
}

// ── Worker ─────────────────────────────────────────────────────────

let worker = null;
let ready = null;
let requestId = 0;
const pending = new Map();

function ensureWorker() {
    if (worker) return ready;
    log("spawning tts-worker");
    ready = new Promise((resolve, reject) => {
        const child = fork(join(homeDir, "tts-worker.mjs"), [homeDir], {
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
            reject(new Error(`worker exited with code ${code} (see bridge.log)`));
            for (const [id, p] of pending) { pending.delete(id); p(); }
        });
        worker = child;
    });
    return ready;
}

async function speak(req) {
    // A language's sentences are read by Kokoro until its voice is downloaded
    ensureVoices(req.languages);
    await ensureWorker();
    const id = ++requestId;
    await new Promise((resolve) => {
        pending.set(id, resolve);
        worker.stdin.write(JSON.stringify({ type: "speak", ...req, id }) + "\n");
    });
}

// ── Spool loop ─────────────────────────────────────────────────────

let readyAt = Date.now();

// Also removes the heartbeats of sessions that ended over an hour ago
function hasLiveSession() {
    let live = Date.now() - readyAt < HEARTBEAT_TTL;
    for (const f of readdirSync(homeDir)) {
        if (!f.startsWith("hb-")) continue;
        const age = ageMs(join(homeDir, f));
        if (age < HEARTBEAT_TTL) live = true;
        else if (age > STALE_HEARTBEAT) try { unlinkSync(join(homeDir, f)); } catch {}
    }
    return live;
}

try {
    await ensurePackages();
    await ensureModel(MODEL);
    await ensureWorker();
    status("ready");
    readyAt = Date.now(); // a long first-run setup does not count against the sessions' heartbeats
} catch (err) {
    status(`error: ${err.message}`);
    process.exit(1);
}

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
        if (req.prepare) {
            ensureVoices(req.languages);
            continue;
        }
        if (!req.text) continue;
        log(`speaking ${name}: "${req.text.slice(0, 60)}"`);
        try {
            await speak({ text: req.text, speed: req.speed ?? 1, sid: req.sid ?? 0, languages: req.languages ?? [] });
        } catch (err) {
            log(`speak failed: ${err.message}`);
        }
    }
    await new Promise((r) => setTimeout(r, 150));
}
