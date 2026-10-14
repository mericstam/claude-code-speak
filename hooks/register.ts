/*---------------------------------------------------------------------------------------------
 *  Claude Speak — reads each Claude Code reply aloud with Kokoro TTS.
 *  A port of copilot-cli-speak. Speech runs in bridge/bridge.mjs + tts-worker.mjs, copied to
 *  a home of their own and started under one of two backends:
 *    native   Linux (or macOS) node in ~/.claude-speak; on WSL it plays through WSLg
 *    windows  from WSL only: Windows node.exe in %USERPROFILE%\.claude-speak, Windows audio
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

type Backend = 'native' | 'windows'
type Settings = { enabled: boolean; speed: number; voice: number; swedish: boolean; backend: Backend | 'auto' }
const DEFAULTS: Settings = {
  enabled: true, speed: 1.0, voice: VOICES.indexOf('bm_george'), swedish: false, backend: 'auto',
}
const USAGE =
  'Usage: /speak [on|off|speed <0.5-2>|voice <name>|swedish on|off|backend auto|native|windows|say <text>]'

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
let isWsl = false
let backend: Backend = 'native'
let home = '' // the active backend's claude-speak home, as a path of this machine
let seq = 0

// ── Backend + bridge ───────────────────────────────────────────────

// Picks the backend, lays the bridge files in its home and writes this session's heartbeat.
// Returns why it cannot run, or undefined.
async function setupBackend($: Engine): Promise<string | undefined> {
  const wanted = settings.backend === 'auto' ? (isWsl ? 'windows' : 'native') : settings.backend
  if (wanted === 'windows' && !isWsl) return 'the windows backend runs from WSL only'

  let nextHome: string
  if (wanted === 'windows') {
    const profile = await $.process.run(['cmd.exe', '/c', 'echo %USERPROFILE%'], { cwd: '/mnt/c' })
    const wslHome = (await $.process.run(['wslpath', '-u', profile.stdout.trim()])).stdout.trim()
    nextHome = `${wslHome}/.claude-speak`
  } else {
    nextHome = `${await $.env.get('HOME')}/.claude-speak`
  }

  for (const file of ['bridge.mjs', 'tts-worker.mjs']) {
    await $.fs.write(`${nextHome}/${file}`, await $.fs.read(`${$.plugin.root}/bridge/${file}`))
  }
  backend = wanted
  home = nextHome
  await heartbeat($)
  return undefined
}

// Keeps the active home's bridge alive while this session is open
async function heartbeat($: Engine) {
  if (home) await $.fs.write(`${home}/hb-${sessionTag}`, String(Date.now()))
}

async function ensureBridge($: Engine) {
  try {
    const alive = (await $.fs.list(home)).find(f => f.name === 'bridge.alive')
    if (alive && Date.now() - alive.mtimeMs < 5_000) return
  } catch {}
  const argv =
    backend === 'windows'
      ? ['node.exe', toWindowsPath(`${home}/bridge.mjs`), toWindowsPath(home)]
      : ['node', `${home}/bridge.mjs`, home]
  void (async () => {
    const bridge = $.process.spawn({ argv, cwd: backend === 'windows' ? '/mnt/c' : home })
    for await (const _ of bridge) {
      // drain; the bridge logs to bridge.log
    }
  })().catch(err => $.ui.log(`kokoro-speak: bridge failed: ${err}`, { to: 'debug' }))
}

// Toasts first-use setup progress or a failed setup, as the bridge reports it
async function reportStatus($: Engine) {
  const text = await $.fs.read(`${home}/status.txt`).catch(() => 'setup: starting…')
  if (text.startsWith('setup:')) $.ui.toast(`🔊 kokoro-speak ${text} (first use; replies queue until ready)`)
  else if (text.startsWith('error:')) $.ui.toast(`🔊 kokoro-speak ${text} (see ${home}/bridge.log)`)
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
  await reportStatus($)
}

function describe(): string {
  return (
    `🔊 Speak mode ${settings.enabled ? 'on' : 'off'} · voice ${VOICES[settings.voice]} · ` +
    `speed ${settings.speed} · Swedish ${settings.swedish ? 'on' : 'off'} · ` +
    `backend ${backend}${settings.backend === 'auto' ? ' (auto)' : ''}`
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)

    const stored = (await $.store.get('settings')) as Partial<Settings> | undefined
    settings = { ...DEFAULTS, ...stored }
    isWsl = (await $.env.get('WSL_DISTRO_NAME')) !== undefined

    await $.command.register({
      name: 'speak',
      description: 'Speak mode: on | off | speed | voice | swedish | backend | say <text>',
      argumentHint: '[on|off|speed|voice|swedish|backend|say]',
    })

    const problem = await setupBackend($)
    if (problem) {
      $.ui.toast(`🔊 kokoro-speak: ${problem}; use /speak backend native`)
      return started
    }
    $.clock.every(15_000, () => void heartbeat($).catch(() => {}))

    if (settings.enabled) {
      await ensureBridge($)
      await reportStatus($)
    }
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
      case 'backend': {
        if (value !== 'auto' && value !== 'native' && value !== 'windows') return { text: USAGE }
        const previous = settings.backend
        settings.backend = value
        const problem = await setupBackend($)
        if (problem) {
          settings.backend = previous
          return { text: `🔊 Cannot switch: ${problem}.` }
        }
        break
      }
      case 'say':
        await enqueue($, value)
        return { text: '🔊 Queued.' }
      default:
        return { text: USAGE }
    }
    await $.store.set('settings', settings)
    if (settings.enabled && home) {
      await ensureBridge($)
      await reportStatus($)
    }
    $.ui.status(settings.enabled ? '🔊' : undefined)
    return { text: describe() }
  })
}
