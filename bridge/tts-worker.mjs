// Persistent TTS worker — stays alive, receives commands via stdin JSON lines.
// Adapted from copilot-cli-speak: generates speech via sherpa-onnx (Kokoro for English,
// a Piper voice per other enabled language, picked per sentence) and streams PCM
// to a player (ffplay on Windows/macOS; paplay, pw-play, aplay or ffplay on Linux).
//
//   node tts-worker.mjs <claude-speak home>
//
// The home holds node_modules (sherpa-onnx-node, franc-all) and models/, all set up by bridge.mjs.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { spawn, execSync } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { existsSync, mkdirSync, unlinkSync, statSync, appendFileSync, readdirSync } from "node:fs";
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
const { francAll } = await import(pathToFileURL(join(homeDir, "node_modules", "franc-all", "index.js")).href);

const MODEL_DIR = join(homeDir, "models", "kokoro-en-v0_19");
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

// Piper voices are loaded lazily, the first time a sentence in their language shows up
// (bridge.mjs downloads them; until one is there its language is read by Kokoro)
const piper = new Map(); // voice id → OfflineTts, or null when it failed to load
function getPiper(voice) {
    if (piper.has(voice)) return piper.get(voice);
    const dir = join(homeDir, "models", `vits-piper-${voice}`);
    const model = join(dir, `${voice}.onnx`);
    if (!existsSync(model)) return null;
    let tts = null;
    try {
        log(`loading Piper voice ${voice}...`);
        const has = (f) => existsSync(join(dir, f));
        // Most voices phonemize with espeak-ng; the Chinese ones use a lexicon and rule FSTs
        const ruleFsts = readdirSync(dir).filter((f) => f.endsWith(".fst")).map((f) => join(dir, f)).join(",");
        tts = new sherpa_onnx.OfflineTts({
            model: {
                vits: {
                    model,
                    tokens: join(dir, "tokens.txt"),
                    ...(has("espeak-ng-data") && { dataDir: join(dir, "espeak-ng-data") }),
                    ...(has("lexicon.txt") && { lexicon: join(dir, "lexicon.txt") }),
                },
                debug: false,
                numThreads: NUM_THREADS,
                provider: "cpu",
            },
            ...(ruleFsts && { ruleFsts }),
            maxNumSentences: 1,
        });
        log(`Piper voice ${voice} loaded`);
    } catch (err) {
        log(`Piper voice ${voice} failed to load: ${err.message}`);
    }
    piper.set(voice, tts);
    return tts;
}

// ── Language detection ─────────────────────────────────────────────

// Replies are mostly English, and franc alone often takes a short English sentence for another
// language ("Run npm test now." reads as French). So a Latin-script sentence leaves English only
// on clear evidence: franc's pick beats English by a margin, and few words are common English.
// One-word sentences ("Done.", "Hej!") take a neighbour's language.
const EN_WORDS = new Set(("the and of to it for with you this are on as be not have can but was will your i we they he " +
    "she if or at by from all so what how about would there been which when do yes my just here now then them these " +
    "those its it's i'm don't you're i'll let's that want should could please thanks done works fixed run passed " +
    "failed ok okay").split(" "));
const NON_LATIN = /[^\u0000-\u024f\u1e00-\u1eff\s\d\p{P}\p{S}]/u;

function detectLang(sentence, only) {
    if (NON_LATIN.test(sentence)) return francAll(sentence, { only, minLength: 1 })[0][0];
    const words = sentence.toLowerCase().match(/[\p{L}']+/gu) || [];
    if (words.length < 2) return null;
    const [[top], ...rest] = francAll(sentence, { only, minLength: 1 });
    if (top === "eng" || top === "und") return "eng";
    const eng = rest.find(([lang]) => lang === "eng")?.[1] ?? 0;
    const enShare = words.filter((w) => EN_WORDS.has(w)).length / words.length;
    return eng >= 0.9 || enShare >= 0.25 ? "eng" : top;
}

// Split into sentences, detect each one, let undetectable ones inherit a neighbour, merge same-language runs
function splitByLanguage(text, only) {
    const sentences = text.split(/(?<=[.!?…])\s+|(?<=[。！？])/).filter((s) => s.trim());
    const langs = sentences.map((s) => detectLang(s, only));
    let prev = langs.find(Boolean) || "eng";
    const filled = langs.map((l) => (prev = l || prev));
    const segments = [];
    sentences.forEach((s, i) => {
        const last = segments[segments.length - 1];
        if (last && last.lang === filled[i]) last.text += " " + s;
        else segments.push({ lang: filled[i], text: s });
    });
    return segments;
}

// languages: [{ franc, voice }], the Piper voice for each enabled language
function getVoice(lang, sid, languages) {
    const voice = languages.find((l) => l.franc === lang)?.voice;
    const tts = voice && getPiper(voice);
    if (tts) return { tts, sid: 0, name: voice };
    return { tts: ttsEn, sid, name: `kokoro sid ${sid}` };
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
        const { text, speed = 1.0, sid = 0, languages = [], id } = req;
        log(`speak request: id=${id}, text="${text.slice(0, 80)}"`);

        try {
            const only = ["eng", ...languages.map((l) => l.franc)];
            const segments = languages.length ? splitByLanguage(text, only) : [{ lang: "eng", text }];
            for (const seg of segments) {
                await speakSegment(getVoice(seg.lang, sid, languages), seg.text, speed);
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
