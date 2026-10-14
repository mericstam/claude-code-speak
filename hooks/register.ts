/*---------------------------------------------------------------------------------------------
 *  Claude Speak — reads each Claude Code reply aloud with Kokoro TTS.
 *  A port of copilot-cli-speak: the model, ffplay and tts-worker.mjs of that extension's
 *  Windows install are reused through bridge/bridge.mjs, run under Windows node.exe.
 *--------------------------------------------------------------------------------------------*/

import type { EngineInterface as Engine, Register } from 'claude-code'

const MAX_CHARS = 1500

// Speaker ids of the kokoro-en-v0_19 model, in order
const VOICES = [
  'af', 'af_bella', 'af_nicole', 'af_sarah', 'af_sky',
  'am_adam', 'am_michael',
  'bf_emma', 'bf_isabella',
  'bm_george', 'bm_lewis',
]

type Settings = { enabled: boolean; speed: number; voice: number; swedish: boolean }
const DEFAULTS: Settings = { enabled: true, speed: 1.0, voice: VOICES.indexOf('bm_george'), swedish: false }

// ── Text sanitization (same rules as copilot-cli-speak) ────────────

function sanitizeText(text: string): string {
  let hasBlocks = false
  const body = text
    // Code blocks are skipped silently; the reply is announced once instead
    .replace(/```[\s\S]*?```/g, () => {
      hasBlocks = true
      return ' '
    })
    // Short inline code is read as the word itself, long snippets are summarized
    .replace(/`([^`]+)`/g, (_, inline: string) => (inline.length <= 30 ? ` ${inline} ` : ' a code snippet '))
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[#*_~>|]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return hasBlocks ? `This response includes code blocks, I won't read them out loud. ${body}` : body
}

// /mnt/c/Users/x → C:\Users\x
function toWindowsPath(path: string): string {
  const m = /^\/mnt\/([a-z])(\/.*)?$/.exec(path)
  return m?.[1] ? `${m[1].toUpperCase()}:${(m[2] ?? '\\').replaceAll('/', '\\')}` : path
}

// ── State (module variables start over on a reload; settings live in $.store) ──

const sessionTag = Math.random().toString(36).slice(2, 10)
let settings: Settings = { ...DEFAULTS }
let home = '' // claude-speak home on the Windows drive, as a WSL path
let speakDir = '' // the copilot-cli-speak extension install, as a WSL path
let seq = 0

// ── Bridge + spool ─────────────────────────────────────────────────

async function ensureBridge($: Engine) {
  try {
    const alive = (await $.fs.list(home)).find(f => f.name === 'bridge.alive')
    if (alive && Date.now() - alive.mtimeMs < 5_000) return
  } catch {}
  void (async () => {
    const bridge = $.process.spawn({
      argv: ['node.exe', toWindowsPath(`${home}/bridge.mjs`), toWindowsPath(speakDir), toWindowsPath(home)],
      cwd: '/mnt/c',
    })
    for await (const _ of bridge) {
      // drain; the bridge logs to bridge.log
    }
  })().catch(err => $.ui.log(`kokoro-speak: bridge failed: ${err}`, { to: 'debug' }))
}

async function enqueue($: Engine, text: string) {
  const sanitized = sanitizeText(text).slice(0, MAX_CHARS)
  if (!sanitized || !home) return
  await ensureBridge($)
  const name = `${Date.now()}-${sessionTag}-${String(++seq).padStart(4, '0')}.json`
  await $.fs.write(
    `${home}/spool/${name}`,
    JSON.stringify({ text: sanitized, speed: settings.speed, sid: settings.voice, swedish: settings.swedish }),
  )
}

export const register: Register = on => {

  on('session.start', async ($, e, next) => {
    const started = await next(e)

    const stored = (await $.store.get('settings')) as Partial<Settings> | undefined
    settings = { ...DEFAULTS, ...stored }

    await $.command.register({
      name: 'speak',
      description: 'Speak mode: on | off | speed <0.5-2> | voice <name> | swedish on|off | say <text>',
      argumentHint: '[on|off|speed|voice|swedish|say]',
    })

    // Locate the Windows home and the Copilot speak install the worker lives in
    const profile = await $.process.run(['cmd.exe', '/c', 'echo %USERPROFILE%'], { cwd: '/mnt/c' })
    const winHome = profile.stdout.trim()
    const wslHome = (await $.process.run(['wslpath', '-u', winHome])).stdout.trim()
    home = `${wslHome}/.claude-speak`
    speakDir = `${wslHome}/.copilot/extensions/speak`

    if (!(await $.fs.exists(`${speakDir}/.cache/kokoro-en-v0_19/model.onnx`))) {
      $.ui.toast(`🔊 kokoro-speak: no Kokoro model under ${speakDir}; run /speak once in Copilot CLI first`)
      return started
    }

    for (const file of ['bridge.mjs', 'tts-worker.mjs']) {
      await $.fs.write(`${home}/${file}`, await $.fs.read(`${$.plugin.root}/bridge/${file}`))
    }

    // First run: take the speed the Copilot extension was set to
    if (stored === undefined) {
      try {
        const copilot = JSON.parse(await $.fs.read(`${speakDir}/.cache/settings.json`))
        if (typeof copilot.speed === 'number') settings.speed = copilot.speed
      } catch {}
    }

    // Heartbeat keeps the bridge alive while this session is open
    const beat = () => void $.fs.write(`${home}/hb-${sessionTag}`, String(Date.now())).catch(() => {})
    beat()
    $.clock.every(15_000, beat)

    if (settings.enabled) await ensureBridge($)
    $.ui.status(settings.enabled ? '🔊' : undefined)
    return started
  })


  // Auto-speak: read every main-loop answer aloud
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (settings.enabled && !e.agentId && e.reason === 'answer' && e.answer.trim()) {
      await enqueue($, e.answer).catch(err => $.ui.log(`kokoro-speak: ${err}`, { to: 'debug' }))
    }
    return result
  })

  on('command.run', { command: 'speak' }, async ($, e) => {
    const [sub = '', ...rest] = e.args.trim().split(/\s+/)
    const value = rest.join(' ')
    switch (sub.toLowerCase()) {
      case '':
        settings.enabled = !settings.enabled
        break
      case 'on':
        settings.enabled = true
        break
      case 'off':
        settings.enabled = false
        break
      case 'speed': {
        const n = Number(value)
        if (!(n >= 0.5 && n <= 2)) return { text: 'Speed must be between 0.5 and 2.0.' }
        settings.speed = n
        break
      }
      case 'voice': {
        const i = VOICES.indexOf(value)
        if (i < 0) return { text: `Voices: ${VOICES.join(', ')}` }
        settings.voice = i
        break
      }
      case 'swedish':
        settings.swedish = value === 'on'
        break
      case 'say':
        await enqueue($, value)
        return { text: '🔊 Queued.' }
      default:
        return { text: 'Usage: /speak [on|off|speed <0.5-2>|voice <name>|swedish on|off|say <text>]' }
    }
    await $.store.set('settings', settings)
    if (settings.enabled) await ensureBridge($)
    $.ui.status(settings.enabled ? '🔊' : undefined)
    return {
      text:
        `🔊 Speak mode ${settings.enabled ? 'on' : 'off'} · voice ${VOICES[settings.voice]} · ` +
        `speed ${settings.speed} · Swedish ${settings.swedish ? 'on' : 'off'}`,
    }
  })
}
