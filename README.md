# claude-code-speak

Hear Claude Code's replies. **kokoro-speak** is a Claude Code plugin that reads every reply aloud with local
text-to-speech: English with [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M), and 41 more languages with
[Piper](https://github.com/rhasspy/piper) voices, all run on your CPU through
[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx). Nothing is sent to a speech service.

- **Automatic**: each finished reply is read aloud; code blocks are skipped and markdown is stripped
- **Multilingual**: the language is picked per sentence, so a reply mixing English and Swedish is read by two voices
- **Linux and WSL**: runs natively on Linux, and on WSL either inside the distro or through Windows audio
- **Self-installing**: the first run installs its packages and downloads the voices it needs

## Install

At the prompt of a Claude Code session in a terminal:

```
/plugin install kokoro-speak --marketplace mericstam/claude-code-speak
```

Answer `y` to add the marketplace, then pick the scope (user, the first one, makes it speak in every session).
It is active right away. The first reply starts a one-time setup of a few minutes: it installs two npm packages
and downloads the Kokoro model (~305 MB). Replies queue until it is done; a toast says so while it runs.

### Requirements

- Claude Code 2.1.275 or later
- Node.js 20+ with `npm`, plus `tar` and `curl`
- **Linux**: an audio player: `paplay` (`pulseaudio-utils`), `pw-play` (PipeWire), `aplay` (`alsa-utils`) or `ffplay`
- **WSL**: either of the above through WSLg, or Node.js for Windows with `node.exe` reachable from WSL (see Backends)

## Usage

Speak mode is on once installed. Everything is set with `/speak`, and settings are kept across sessions:

```
/speak                    toggle speak mode (also: /speak on, /speak off)
/speak speed 1.4          0.5 (slow) to 2.0 (fast)
/speak voice bm_george    the English voice
/speak say Hello there    speak a line now
/speak help               all commands
```

English voices: `af`, `af_bella`, `af_nicole`, `af_sarah`, `af_sky`, `am_adam`, `am_michael` (American),
`bf_emma`, `bf_isabella`, `bm_george`, `bm_lewis` (British). `f` is female, `m` male; `bm_george` is the default.

### What is read

- Code blocks are skipped; a reply that has them starts with "This response includes code blocks, I won't read them out loud."
- Short inline code (up to 30 characters) is read as the word itself, longer snippets as "a code snippet"
- Markdown symbols are removed, and each reply is capped at 1500 characters
- Replies of subagents and interrupted turns are not read

## Languages

English is always read, by Kokoro. Swedish is on by default; add or remove any other language:

```
/speak lang                 your languages, their download state, and all available ones
/speak lang add german      by code, English name or own name: de, german, Deutsch
/speak lang add sv alma     with a voice of your choice
/speak lang voices de       a language's voices and their sizes
/speak lang remove de
```

A language's voice (25–115 MB) downloads in the background when you add it; until it is there, that language
is read by the English voice. Available:

Albanian, Arabic, Basque, Catalan, Chinese, Czech, Danish, Dutch, Finnish, French, Georgian, German, Greek, Hindi,
Hungarian, Icelandic, Indonesian, Italian, Kazakh, Kurdish, Latvian, Luxembourgish, Malayalam, Nepali, Norwegian,
Persian, Polish, Portuguese, Romanian, Russian, Serbian, Slovak, Slovenian, Spanish, Swahili, Swedish, Turkish,
Ukrainian, Urdu, Vietnamese, Welsh (130 voices in all).

Each sentence is identified with [franc](https://github.com/wooorm/franc), limited to English and the languages
you added. Replies are mostly English, so a sentence leaves English only on clear evidence, and a one-word
sentence ("Done.", "Hej!") takes its neighbour's language. With several close relatives added at once (Swedish,
Danish, Norwegian), short sentences can be read by the wrong one of them; full sentences are reliable.

## Backends

Speech runs in a small background process, the bridge, under one of two backends:

| Backend | Runs | Files | Audio |
| --- | --- | --- | --- |
| `native` | Linux `node` (also macOS) | `~/.claude-speak` | `paplay`, `pw-play`, `aplay` or `ffplay` on Linux, WSLg included; ffplay on macOS |
| `windows` | WSL only: Windows `node.exe` | `%USERPROFILE%\.claude-speak` | ffplay on Windows, downloaded on first use |

`auto`, the default, picks `windows` on WSL and `native` everywhere else. Switch with `/speak backend native`,
`/speak backend windows` or `/speak backend auto`. Each backend sets itself up and downloads its voices separately.

On WSL, `windows` plays straight through Windows audio, so it follows your Windows output device and Bluetooth
headsets; `native` keeps everything inside the distro but goes through WSLg's audio, which can add latency or
crackle.

## Troubleshooting

Everything the bridge does is logged in `bridge.log` in the backend's folder (`~/.claude-speak` or
`%USERPROFILE%\.claude-speak`), and `status.txt` there says `setup: …`, `ready` or `error: …`.

- **Nothing is heard**: run `/speak` to check speak mode is on, then `/speak say test`, and read `bridge.log`
- **"No audio player found"** (native): install `pulseaudio-utils`, `pipewire`, `alsa-utils` or `ffmpeg`
- **Setup failed**: often a network or npm error, shown in the toast and in `bridge.log`; the next reply retries it
- **A language is read by the English voice**: its voice is still downloading; `/speak lang` shows its state
- **Disk space**: voices stay in `<folder>/models` after `/speak lang remove`; delete them there to free the space

## How it works

```
hooks/register.ts      the plugin: /speak, and a hook that queues each finished reply
hooks/piper-voices.ts  the Piper voice catalog, generated by make-catalog.py
bridge/bridge.mjs      first-run setup, voice downloads, and feeding queued replies to the worker in order
bridge/tts-worker.mjs  picks the language of each sentence, synthesizes it with Kokoro or Piper, streams it to the player
```

The plugin copies `bridge/*.mjs` into the backend's folder and starts the bridge there. Each reply becomes a JSON
file in `spool/`, which the bridge speaks in order. One bridge serves every open session; it exits once no
session has signalled for 45 seconds.

Inspired by [copilot-cli-speak](https://github.com/MRayermannMSFT/copilot-cli-speak), the same idea for GitHub
Copilot CLI; the speech worker builds on its code.

## Development

```bash
git clone https://github.com/mericstam/claude-code-speak
claude --plugin-dir ./claude-code-speak   # a session with the plugin loaded from the folder
claude plugin validate ./claude-code-speak
claude plugin test ./claude-code-speak
python3 make-catalog.py                   # refresh the Piper voice catalog
```

## License

[MIT](LICENSE)
