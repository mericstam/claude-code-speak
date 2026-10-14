# claude-speak

Text-to-speech for Claude Code: every reply is read aloud with [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M)
via [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx). A port of
[copilot-cli-speak](../copilot-cli-speak) as a Claude Code mod (plugin name `kokoro-speak`, as `claude-*` names are reserved).

## Requirements

- Claude Code under WSL, Windows `node.exe` on the PATH
- copilot-cli-speak installed at `%USERPROFILE%\.copilot\extensions\speak` with its model downloaded
  (run `/speak` there once). Its Kokoro model, Swedish model, ffplay and native addon are reused.

## Usage

```
/speak                 toggle speak mode
/speak on | off
/speak speed 1.4       0.5–2.0
/speak voice bm_george af, af_bella, af_nicole, af_sarah, af_sky, am_adam, am_michael, bf_emma, bf_isabella, bm_george, bm_lewis
/speak swedish on      read Swedish sentences with the Piper NST voice
/speak say <text>      speak a line now
```

Settings are kept across sessions. On first run the speed is taken from the Copilot extension's settings.
Replies are read the same way as in copilot-cli-speak: code blocks skipped (announced once), short inline code read
as the word, markdown stripped, capped at 1500 characters. Subagent turns and interrupted turns are not spoken.

## How it works

```
hooks/register.ts     the mod: /speak, and a turn.complete hook that spools each reply
bridge/bridge.mjs     runs under Windows node.exe; feeds spooled replies to the worker in order
bridge/tts-worker.mjs copied from copilot-cli-speak/src; Kokoro + ffplay playback
```

The mod copies `bridge/*.mjs` to `%USERPROFILE%\.claude-speak\` and starts the bridge there. Each reply becomes a
JSON file in `.claude-speak\spool\`. One bridge serves every open session; it exits once no session has written its
heartbeat (`hb-*`) for 45 s. Logs: `.claude-speak\bridge.log` and the Copilot extension's `.cache\debug.log`.

## Development

```bash
claude plugin validate .
claude plugin test .
claude --plugin-dir ~/claude-speak   # load it into a session
```
