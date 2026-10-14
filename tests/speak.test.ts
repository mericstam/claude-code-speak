import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

// A fake host beneath the mod: a Linux home, optionally WSL with a Windows profile, a filesystem
function host(on: On, { wsl }: { wsl: boolean }) {
  mock.store(on)
  mock.clock(on)
  mock.env(on, wsl ? { HOME: '/home/me', WSL_DISTRO_NAME: 'Ubuntu' } : { HOME: '/home/me' })
  const files = new Map<string, string>()
  const spawned: (readonly string[])[] = []
  on('process.run', async (_$, e) => {
    const stdout = e.argv[0] === 'cmd.exe' ? 'C:\\Users\\me\r\n' : '/mnt/c/Users/me\n'
    return { value: { exitCode: 0, stdout, stderr: '' } } as never
  })
  on('process.spawn', async function* (_$, e) {
    spawned.push(e.argv)
    return { value: { code: 0, signal: null } } as never
  })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }) as never)
  on('command.register', async (_$, e) => ({ value: { command: e.name } }) as never)
  on('ui.status', async () => ({ value: undefined }) as never)
  on('ui.toast', async () => ({ value: undefined }) as never)
  on('fs.exists', async () => ({ value: true }) as never)
  on('fs.list', async () => ({ value: [] }) as never)
  on('fs.read', async (_$, e) => ({ value: files.get(e.path) ?? 'ready' }) as never)
  on('fs.write', async (_$, e) => {
    files.set(e.path, e.text)
    return { value: undefined } as never
  })
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  on('command.run', async () => ({ text: '' }) as never)
  const spooled = (home: string) =>
    [...files].filter(([path]) => path.startsWith(`${home}/spool/`)).map(([, text]) => JSON.parse(text))
  return { files, spawned, spooled }
}

async function start($: Engine) {
  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: true } as never)
}

const reply = (answer: string) =>
  ({ answer, reason: 'answer', durationMs: 1, isAborted: false, turnId: 't1' }) as never

test('native Linux: replies are sanitized and spooled under ~/.claude-speak', async ($, on) => {
  const { files, spawned, spooled } = host(on, { wsl: false })
  await start($)

  await $.turn.complete(reply('**Done.** Run `npm test` now.\n```js\nx()\n```'))

  expect(files.has('/home/me/.claude-speak/bridge.mjs')).toBe(true)
  expect(spawned[0]).toEqual(['node', '/home/me/.claude-speak/bridge.mjs', '/home/me/.claude-speak'])
  expect(spooled('/home/me/.claude-speak')).toEqual([
    {
      text: "This response includes code blocks, I won't read them out loud. Done. Run npm test now.",
      speed: 1,
      sid: 9,
      swedish: false,
    },
  ])
})

test('WSL: the windows backend is the default and runs node.exe on Windows paths', async ($, on) => {
  const { spawned, spooled } = host(on, { wsl: true })
  await start($)

  await $.turn.complete(reply('Hello.'))

  expect(spawned[0]).toEqual(['node.exe', 'C:\\Users\\me\\.claude-speak\\bridge.mjs', 'C:\\Users\\me\\.claude-speak'])
  expect(spooled('/mnt/c/Users/me/.claude-speak')).toHaveLength(1)
})

test('WSL: /speak backend native moves speech to the Linux home', async ($, on) => {
  const { spooled } = host(on, { wsl: true })
  await start($)

  const switched = await $.command.run({ command: 'speak', args: 'backend native' } as never)
  await $.turn.complete(reply('Hello.'))

  expect(switched.text).toContain('backend native')
  expect(spooled('/home/me/.claude-speak')).toHaveLength(1)
  expect(spooled('/mnt/c/Users/me/.claude-speak')).toHaveLength(0)
})

test('native Linux: the windows backend is refused', async ($, on) => {
  host(on, { wsl: false })
  await start($)

  const refused = await $.command.run({ command: 'speak', args: 'backend windows' } as never)

  expect(refused.text).toContain('runs from WSL only')
})

test('/speak off stops speaking replies; subagent turns are never spoken', async ($, on) => {
  const { spooled } = host(on, { wsl: false })
  await start($)

  await $.turn.complete({ ...(reply('From a subagent.') as object), agentId: 'a1' } as never)
  const off = await $.command.run({ command: 'speak', args: 'off' } as never)
  await $.turn.complete(reply('Not spoken.'))

  expect(off.text).toContain('Speak mode off')
  expect(spooled('/home/me/.claude-speak')).toEqual([])
})
