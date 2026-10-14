# claude-speak

Text-to-speech for Claude Code: every reply is read aloud with [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M)
via [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx). A port of
copilot-cli-speak as a Claude Code mod (plugin name `kokoro-speak`, as `claude-*` names are reserved).

## Backends

Speech runs in a small bridge process, under one of two backends. Each sets itself up on first use in a home of
its own: it installs `sherpa-onnx-node` with npm and downloads the Kokoro model (~305 MB), plus the Swedish
model (~64 MB) the first time Swedish is turned on. Replies queue until setup is done.

| Backend | Where it runs | Home | Audio |
| --- | --- | --- | --- |
| `native` | Linux node (also macOS) | `~/.claude-speak` | `paplay`, `pw-play`, `aplay` or `ffplay` on Linux (WSLg works); ffplay on macOS |
| `windows` | WSL only: Windows `node.exe` | `%USERPROFILE%\.claude-speak` | ffplay on Windows (downloaded) |

`/speak backend auto` (the default) picks `windows` on WSL and `native` everywhere else.
On WSL, `/speak backend native` keeps everything inside the distro.

Requirements: `node` and `npm` on the PATH (Node 20+), plus `tar` and `curl`. On native Linux, an audio player
from the list above (`pulseaudio-utils` or `pipewire` on most desktops). For `windows`, Node for Windows with
`node.exe` reachable from WSL.

## Usage

```
/speak                  toggle speak mode
/speak on | off
/speak speed 1.4        0.5–2.0
/speak voice bm_george  af, af_bella, af_nicole, af_sarah, af_sky, am_adam, am_michael, bf_emma, bf_isabella, bm_george, bm_lewis
/speak swedish on       read Swedish sentences with the Piper NST voice
/speak backend native   auto | native | windows
/speak say <text>       speak a line now
```

Settings are kept across sessions. Replies are read as in copilot-cli-speak: code blocks skipped (announced once),
short inline code read as the word, markdown stripped, capped at 1500 characters. Subagent turns and interrupted
turns are not spoken.

## How it works

```
hooks/register.ts      the mod: /speak, and a turn.complete hook that spools each reply
bridge/bridge.mjs      first-run setup, then feeds spooled replies to the worker in order
bridge/tts-worker.mjs  adapted from copilot-cli-speak/src: Kokoro via sherpa-onnx, PCM streamed to the player
```

The mod copies `bridge/*.mjs` into the backend's home and starts the bridge there. Each reply becomes a JSON file
in `<home>/spool/`. One bridge serves every open session; it exits once no session has written its heartbeat
(`hb-*`) for 45 s. `<home>/status.txt` says `setup: …`, `ready` or `error: …`; `<home>/bridge.log` has the details.

## Development

```bash
claude plugin validate .
claude plugin test .
claude --plugin-dir ~/claude-speak   # load it into a session
```
