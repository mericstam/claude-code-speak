import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const HOME = '/mnt/c/Users/me'
const SPOOL = `${HOME}/.claude-speak/spool/`

// A fake host beneath the mod: the Windows profile, the Copilot install, a filesystem
function host(on: On) {
  mock.store(on)
  mock.clock(on)
  const files = new Map<string, string>([
    [`${HOME}/.copilot/extensions/speak/.cache/settings.json`, '{"speed":1.4}'],
  ])
  on('process.run', async (_$, e) => {
    const stdout = e.argv[0] === 'cmd.exe' ? 'C:\\Users\\me\r\n' : `${HOME}\n`
    return { value: { exitCode: 0, stdout, stderr: '' } } as never
  })
  on('process.spawn', async function* () {
    return { value: { code: 0, signal: null } } as never
  })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }) as never)
  on('command.register', async (_$, e) => ({ value: { command: e.name } }) as never)
  on('ui.status', async () => ({ value: undefined }) as never)
  on('ui.toast', async () => ({ value: undefined }) as never)
  on('fs.exists', async () => ({ value: true }) as never)
  on('fs.list', async () => ({ value: [] }) as never)
  on('fs.read', async (_$, e) => ({ value: files.get(e.path) ?? 'source' }) as never)
  on('fs.write', async (_$, e) => {
    files.set(e.path, e.text)
    return { value: undefined } as never
  })
  const spooled = () =>
    [...files].filter(([path]) => path.startsWith(SPOOL)).map(([, text]) => JSON.parse(text))
  return { spooled }
}

async function start($: Engine) {
  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: true } as never)
}

const reply = (answer: string) =>
  ({ answer, reason: 'answer', durationMs: 1, isAborted: false, turnId: 't1' }) as never

test('a reply is sanitized and spooled with the Copilot speed', async ($, on) => {
  const { spooled } = host(on)
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  await start($)

  await $.turn.complete(reply('**Done.** Run `npm test` now.\n```js\nx()\n```'))

  expect(spooled()).toEqual([
    {
      text: "This response includes code blocks, I won't read them out loud. Done. Run npm test now.",
      speed: 1.4,
      sid: 9,
      swedish: false,
    },
  ])
})

test('/speak off stops speaking replies; subagent turns are never spoken', async ($, on) => {
  const { spooled } = host(on)
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  on('command.run', async () => ({ text: '' }) as never)
  await start($)

  await $.turn.complete({ ...(reply('From a subagent.') as object), agentId: 'a1' } as never)
  const off = await $.command.run({ command: 'speak', args: 'off' } as never)
  await $.turn.complete(reply('Not spoken.'))

  expect(off.text).toContain('Speak mode off')
  expect(spooled()).toEqual([])
})
