// Persistent TTS worker — stays alive, receives commands via stdin JSON lines.
// Adapted from copilot-cli-speak: generates speech via sherpa-onnx and streams PCM
// to a player (ffplay on Windows/macOS; paplay, pw-play, aplay or ffplay on Linux).
//
//   node tts-worker.mjs <claude-speak home>
//
// The home holds node_modules/sherpa-onnx-node and models/, both set up by bridge.mjs.
import { createRequire } from "node:module";
import { spawn, execSync } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { existsSync, mkdirSync, unlinkSync, statSync, appendFileSync } from "node:fs";
import { platform as osPlatform, availableParallelism } from "node:os";

const homeDir = process.argv[2];

const LOG_PATH = join(homeDir, "bridge.log");
function log(msg) {
    try {
        appendFileSync(LOG_PATH, `${new Date().toISOString()} [worker ${process.pid}] ${msg}\n`);
    } catch {}
}

// ── Load sherpa-onnx ───────────────────────────────────────────────

const require = createRequire(join(homeDir, "package.json"));

log("loading sherpa-onnx...");
const sherpa_onnx = require("sherpa-onnx-node");
log("sherpa-onnx loaded");

const MODEL_DIR = join(homeDir, "models", "kokoro-en-v0_19");
const SV_MODEL_DIR = join(homeDir, "models", "vits-piper-sv_SE-nst-medium");
const FFPLAY_DIR = join(homeDir, "ffplay");
const NUM_THREADS = Math.max(2, Math.min(8, availableParallelism()));

// ── Player ─────────────────────────────────────────────────────────

const FFPLAY_URLS = {
    "win32": "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip",
    "darwin": "https://ffmpeg.martin-riedl.de/releases/macos/arm64/snapshot/ffplay.zip",
};

function ensureFfplay() {
    const ffplayPath = join(FFPLAY_DIR, osPlatform() === "win32" ? "ffplay.exe" : "ffplay");
    if (existsSync(ffplayPath)) return ffplayPath;

    mkdirSync(FFPLAY_DIR, { recursive: true });
    const url = FFPLAY_URLS[osPlatform()];
    if (!url) throw new Error(`No ffplay download URL for platform: ${osPlatform()}`);

    log(`downloading ffplay from ${url}`);
    const zipPath = join(FFPLAY_DIR, "ffplay-download.zip");
    execSync(`curl -fSL -o "${zipPath}" "${url}"`, { stdio: "pipe", windowsHide: true });

    if (osPlatform() === "win32") {
        execSync(`tar -xf "${zipPath}" --strip-components=2 -C "${FFPLAY_DIR}" "*/bin/ffplay.exe"`, {
            stdio: "pipe", windowsHide: true,
        });
    } else {
        execSync(`unzip -o "${zipPath}" -d "${FFPLAY_DIR}"`, { stdio: "pipe" });
        execSync(`chmod +x "${ffplayPath}"`, { stdio: "pipe" });
    }

    unlinkSync(zipPath);
    log(`ffplay extracted: ${(statSync(ffplayPath).size / 1024 / 1024).toFixed(0)} MB`);
    return ffplayPath;
}

function hasCommand(cmd) {
    try {
        execSync(`command -v ${cmd}`, { stdio: "ignore", shell: "/bin/sh" });
        return true;
    } catch {
        return false;
    }
}

const ffplayArgs = (rate) => [
    "-f", "s16le", "-ar", String(rate), "-ch_layout", "mono",
    "-nodisp", "-autoexit", "-loglevel", "quiet", "-i", "pipe:0",
];

// Picks how raw 16-bit mono PCM at a sample rate is played: [command, args(rate)]
function choosePlayer() {
    if (osPlatform() !== "linux") return [ensureFfplay(), ffplayArgs];
    if (hasCommand("paplay")) {
        return ["paplay", (rate) => ["--raw", "--format=s16le", `--rate=${rate}`, "--channels=1"]];
    }
    if (hasCommand("pw-play")) {
        return ["pw-play", (rate) => ["--format=s16", `--rate=${rate}`, "--channels=1", "-"]];
    }
    if (hasCommand("aplay")) {
        return ["aplay", (rate) => ["-q", "-t", "raw", "-f", "S16_LE", `-r${rate}`, "-c1"]];
    }
    if (hasCommand("ffplay")) return ["ffplay", ffplayArgs];
    throw new Error("No audio player found: install pulseaudio-utils (paplay), pipewire, alsa-utils (aplay) or ffmpeg");
}

// ── Float32 → 16-bit PCM ──────────────────────────────────────────

function float32ToPcm16(samples) {
    const buf = Buffer.alloc(samples.length * 2);
    for (let i = 0; i < samples.length; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        buf.writeInt16LE(Math.round(s * 32767), i * 2);
    }
    return buf;
}

// ── Init TTS + player ──────────────────────────────────────────────

log("creating TTS instance...");
const ttsEn = new sherpa_onnx.OfflineTts({
    model: {
        kokoro: {
            model: join(MODEL_DIR, "model.onnx"),
            tokens: join(MODEL_DIR, "tokens.txt"),
            voices: join(MODEL_DIR, "voices.bin"),
            dataDir: join(MODEL_DIR, "espeak-ng-data"),
        },
        debug: false,
        numThreads: NUM_THREADS,
        provider: "cpu",
    },
    maxNumSentences: 1,
});
log("TTS instance created");

// Swedish voice (Piper NST) is loaded lazily the first time Swedish text shows up
let ttsSv = null;
let svLoadFailed = false;
function getSvTts() {
    if (ttsSv || svLoadFailed) return ttsSv;
    const model = join(SV_MODEL_DIR, "sv_SE-nst-medium.onnx");
    if (!existsSync(model)) return null;
    try {
        log("loading Swedish TTS...");
        ttsSv = new sherpa_onnx.OfflineTts({
            model: {
                vits: {
                    model,
                    tokens: join(SV_MODEL_DIR, "tokens.txt"),
                    dataDir: join(SV_MODEL_DIR, "espeak-ng-data"),
                },
                debug: false,
                numThreads: NUM_THREADS,
                provider: "cpu",
            },
            maxNumSentences: 1,
        });
        log("Swedish TTS loaded");
    } catch (err) {
        svLoadFailed = true;
        log(`Swedish TTS load failed: ${err.message}`);
    }
    return ttsSv;
}

// ── Language detection (English vs Swedish) ────────────────────────

const SV_WORDS = new Set(("och att det som är på av för med inte har jag du vi den till om men så ett kan från " +
    "de här när ska vara mig dig också eller sig vid hej tack ja nej vad hur var vill kommer får bara mycket dem " +
    "deras vår din min mitt denna dessa alla efter över under sedan utan genom mot hos lite igen nu då själv ingen " +
    "något någon där oss er ni hon han").split(" "));
const EN_WORDS = new Set(("the and of to is a in that it for with you this are on as be not have can but was " +
    "will your i we they he she if or at by from an all so what how about would there been which when do no yes " +
    "my me just here now then them these those its it's i'm don't you're i'll let's").split(" "));

function detectLang(text) {
    const words = text.toLowerCase().match(/[a-zåäöéü']+/g) || [];
    let sv = 0, en = 0;
    for (const w of words) {
        if (SV_WORDS.has(w)) sv++;
        else if (EN_WORDS.has(w)) en++;
    }
    const diacritics = Math.min((text.match(/[åäöÅÄÖ]/g) || []).length, 2);
    if (sv + en + diacritics === 0) return null;
    return sv + diacritics > en ? "sv" : "en";
}

// Split into sentences, detect each one, let undetectable ones inherit a neighbour, merge same-language runs
function splitByLanguage(text) {
    const sentences = text.split(/(?<=[.!?…])\s+/).filter(Boolean);
    const langs = sentences.map(detectLang);
    let prev = langs.find(Boolean) || "en";
    const filled = langs.map((l) => (prev = l || prev));
    const segments = [];
    sentences.forEach((s, i) => {
        const last = segments[segments.length - 1];
        if (last && last.lang === filled[i]) last.text += " " + s;
        else segments.push({ lang: filled[i], text: s });
    });
    return segments;
}

function getVoice(lang, sid) {
    if (lang === "sv") {
        const tts = getSvTts();
        if (tts) return { tts, sid: 0, name: "sv nst" };
    }
    return { tts: ttsEn, sid, name: `en sid ${sid}` };
}

const [playerCmd, playerArgs] = choosePlayer();
log(`player: ${playerCmd}`);

// Signal ready to parent
process.send?.({ type: "ready" });

// ── Handle requests via stdin JSON lines ───────────────────────────

const rl = createInterface({ input: process.stdin });

async function speakSegment({ tts, sid, name }, text, speed) {
    const config = new sherpa_onnx.GenerationConfig({ sid, speed });

    const player = spawn(playerCmd, playerArgs(tts.sampleRate), {
        stdio: ["pipe", "ignore", "ignore"],
        windowsHide: true,
    });

    let playerError = null;
    player.on("error", (err) => { playerError = err; });
    player.stdin.on("error", (err) => { playerError = err; });

    const t0 = Date.now();
    const audio = await tts.generateAsync({
        text,
        generationConfig: config,
        onProgress: (info) => {
            if (!playerError && player.stdin.writable) {
                try { player.stdin.write(float32ToPcm16(info.samples)); } catch {}
            }
            return 1;
        },
    });
    log(`generated [${name}] in ${Date.now() - t0}ms, ${audio.samples.length} samples @${tts.sampleRate}Hz`);

    player.stdin.end();

    await new Promise((resolve) => {
        player.on("close", resolve);
        setTimeout(resolve, 60000);
    });
    if (playerError) throw playerError;
}

rl.on("line", async (line) => {
    let req;
    try {
        req = JSON.parse(line);
    } catch {
        return;
    }

    if (req.type === "speak") {
        const { text, speed = 1.0, sid = 0, swedish = false, id } = req;
        log(`speak request: id=${id}, text="${text.slice(0, 80)}"`);

        try {
            const segments = swedish ? splitByLanguage(text) : [{ lang: "en", text }];
            for (const seg of segments) {
                await speakSegment(getVoice(seg.lang, sid), seg.text, speed);
            }

            log(`playback done for id=${id}`);
            process.send?.({ type: "done", id });
        } catch (err) {
            log(`error: ${err.message}`);
            process.send?.({ type: "error", id, error: err.message });
        }
    }
});

rl.on("close", () => {
    log("stdin closed, exiting");
    process.exit(0);
});
