import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import FleetTmux, { TmuxChannelError, resolveConfig } from '../src/index.ts'
import type { Config } from '../src/index.ts'
import { FrameLog, decodeFrame, runTmux } from '../src/panes.ts'

/**
 * A tmux stand-in: records every argv it is handed, reports that no session
 * exists yet, and reports a harness (not a shell) as the pane's foreground
 * command so placement can reach its readiness check.
 */
function fakeTmux(dir: string, log: string): string {
  const path = join(dir, 'tmux')
  writeFileSync(path, `#!/bin/sh
printf '%s\n' "$*" >> ${JSON.stringify(log)}
case "$1" in
  has-session) exit 1 ;;
  list-panes) printf 'dsh\n' ;;
esac
exit 0
`)
  chmodSync(path, 0o755)
  return path
}

/** A harness stand-in that completes one turn per prompt and reports idle. */
function fakeHarness(dir: string): string {
  const path = join(dir, 'fake-dsh')
  writeFileSync(path, `#!${process.execPath}\n${[
    "process.stdin.setEncoding('utf8')",
    "let buffer = ''",
    "process.stdin.on('data', (chunk) => {",
    '  buffer += chunk',
    '  let index = buffer.indexOf("\\n")',
    '  while (index >= 0) {',
    '    const line = buffer.slice(0, index)',
    '    buffer = buffer.slice(index + 1)',
    '    if (line.trim() !== "") {',
    '      const frame = JSON.parse(line)',
    '      // An unknown method is deliberately left unanswered: a real runtime',
    '      // answers only the methods it implements.',
    '      if (frame.method !== "initialize" && frame.method !== "session/prompt") {',
    '        index = buffer.indexOf("\\n")',
    '        continue',
    '      }',
    '      const reply = frame.method === "initialize"',
    '        ? { serverInfo: { name: "fake-runtime", version: "0" } }',
    '        : { messageId: "msg-1" }',
    '      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: reply }) + "\\n")',
    '      if (frame.method === "session/prompt") {',
    '        process.stdout.write(JSON.stringify({',
    '          jsonrpc: "2.0",',
    '          method: "session.status",',
    '          params: { sessionId: frame.params.sessionId, status: "idle" },',
    '        }) + "\\n")',
    '      }',
    '    }',
    '    index = buffer.indexOf("\\n")',
    '  }',
    '})',
    '',
  ].join('\n')}`)
  chmodSync(path, 0o755)
  return path
}

/**
 * A tmux server is started per test directory through `TMUX_TMPDIR`, so two
 * specs running concurrently in forked workers never share a server.
 */
function hasTmux(): boolean {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const tmuxAvailable = hasTmux()

describe('frame decoding', () => {
  it('accepts a JSON-RPC request and notification', () => {
    expect(decodeFrame('{"jsonrpc":"2.0","id":3,"method":"session/prompt"}')).toEqual({
      jsonrpc: '2.0',
      id: 3,
      method: 'session/prompt',
    })
    expect(decodeFrame('{"jsonrpc":"2.0","method":"session.status","params":{}}')).toEqual({
      jsonrpc: '2.0',
      method: 'session.status',
      params: {},
    })
  })

  it.each([
    ['plain output', 'hello world'],
    ['malformed JSON', '{"jsonrpc":'],
    ['a JSON array', '[1,2,3]'],
    ['a non-JSON-RPC object', '{"id":1,"result":{}}'],
    ['a bare scalar', '42'],
  ])('rejects %s', (_label, line) => {
    expect(decodeFrame(line)).toBeUndefined()
  })
})

describe('FrameLog', () => {
  let dir: string
  let logPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fleet-frames-'))
    logPath = join(dir, 'out.ndjson')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('reports nothing until the log exists', async () => {
    const log = new FrameLog(logPath)
    await expect(log.poll()).resolves.toEqual({ frames: [], malformed: [] })
  })

  it('reads only complete lines and delivers a partial write later', async () => {
    const log = new FrameLog(logPath)
    writeFileSync(logPath, '{"jsonrpc":"2.0","id":1,"result":{}}\n{"jsonrpc":"2.0","id":')
    await expect(log.poll()).resolves.toEqual({
      frames: [{ jsonrpc: '2.0', id: 1, result: {} }],
      malformed: [],
    })
    writeFileSync(logPath, '{"jsonrpc":"2.0","id":1,"result":{}}\n{"jsonrpc":"2.0","id":2,"result":{"ok":true}}\n')
    await expect(log.poll()).resolves.toEqual({
      frames: [{ jsonrpc: '2.0', id: 2, result: { ok: true } }],
      malformed: [],
    })
  })

  it('never repeats a frame across polls', async () => {
    const log = new FrameLog(logPath)
    writeFileSync(logPath, '{"jsonrpc":"2.0","id":7,"result":{}}\n')
    await log.poll()
    await expect(log.poll()).resolves.toEqual({ frames: [], malformed: [] })
  })

  it('resumes from the start when the log is replaced by a fresh pane', async () => {
    const log = new FrameLog(logPath)
    writeFileSync(logPath, '{"jsonrpc":"2.0","id":1,"result":{"first":true}}\n')
    await log.poll()
    // A replacement log is shorter than the offset already consumed; the only
    // observable signal of a replaced file is that it shrank.
    writeFileSync(logPath, '{"jsonrpc":"2.0","id":2,"result":{"b":2}}\n')
    await expect(log.poll()).resolves.toEqual({
      frames: [{ jsonrpc: '2.0', id: 2, result: { b: 2 } }],
      malformed: [],
    })
  })

  it('reports a non-JSON line instead of throwing', async () => {
    const log = new FrameLog(logPath)
    writeFileSync(logPath, 'echoed noise\n{"jsonrpc":"2.0","id":3,"result":{}}\n')
    const read = await log.poll()
    expect(read.malformed).toEqual(['echoed noise'])
    expect(read.frames).toHaveLength(1)
  })
})

describe('resolveConfig', () => {
  const base: Config = {
    dshHome: '/tmp/dsh-home',
    machineId: 'machine-1',
  }

  it('derives the frame root under the harness home', () => {
    expect(resolveConfig(base).frameRoot).toBe('/tmp/dsh-home/fleet/frames')
  })

  it('resolves a relative frame root against the launch directory', () => {
    expect(resolveConfig({ ...base, frameRoot: '.frames' }).frameRoot).toBe(join(process.cwd(), '.frames'))
  })

  it.each([
    ['a relative dshHome', { dshHome: 'relative/home' }],
    ['an empty machineId', { machineId: '' }],
    ['a relative patch', { patches: ['patches/fleet.yml'] }],
    ['a nonpositive poll interval', { pollIntervalMs: 0 }],
    ['a nonpositive start bound', { startTimeoutMs: 0 }],
    ['a nonpositive grace', { graceMs: -1 }],
  ])('rejects %s', (_label, override) => {
    expect(() => resolveConfig({ ...base, ...override })).toThrow(TypeError)
  })
})

describe('FleetTmux command construction', () => {
  let dir: string
  let argvLog: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fleet-tmux-'))
    argvLog = join(dir, 'argv.log')
    writeFileSync(argvLog, '')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  async function service(tmuxBin: string): Promise<{ ctx: Context; tmux: FleetTmux }> {
    const ctx = new Context()
    await ctx.plugin(SubprocessLocal)
    await ctx.plugin(FleetTmux, {
      tmuxBin,
      dshBin: '/opt/harness/bin/dsh',
      profile: 'sdk',
      patches: ['/etc/fleet/no-messaging.cordis.patch.yml'],
      dshHome: dir,
      machineId: 'machine-1',
      credentialEnv: [],
    })
    const tmux = ctx.get('tmux')
    if (tmux === undefined) throw new Error('ctx.tmux was not registered')
    return { ctx, tmux }
  }

  it('names the pane from the key and launches the harness with its profile and patches', async () => {
    const { ctx, tmux } = await service(fakeTmux(dir, argvLog))
    try {
      const placement = await tmux.place('worker-abc', { cwd: dir, mode: 'fresh' })
      expect(placement.target).toBe('dsh-fleet:w-worker-abc')
      expect(placement.machine).toBe('machine-1')
      const issued = execFileSync('cat', [argvLog], { encoding: 'utf8' })
      expect(issued).toContain(`new-window -d -t dsh-fleet -n w-worker-abc -c ${dir}`)
      expect(issued).toContain(
        `pipe-pane -t dsh-fleet:w-worker-abc -o cat >>'${dir}/fleet/frames/worker-abc/out.ndjson'`,
      )
      // The tty setup and the harness launch are one command handed to tmux at
      // window creation, so no interactive shell ever owns the pane's stdin.
      expect(issued).toContain(
        'new-window -d -t dsh-fleet -n w-worker-abc -c '
        + `${dir} -e DSH_HOME=${dir} `
        + "stty -echo -icanon; exec '/opt/harness/bin/dsh' --profile 'sdk' --patch "
        + "'/etc/fleet/no-messaging.cordis.patch.yml'",
      )
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects a key that cannot name a tmux window', async () => {
    const { ctx, tmux } = await service(fakeTmux(dir, argvLog))
    try {
      await expect(tmux.place('bad key', { cwd: dir, mode: 'fresh' })).rejects.toThrow(TypeError)
      await expect(tmux.place('bad:key', { cwd: dir, mode: 'fresh' })).rejects.toThrow(TypeError)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('requires a placed pane before a frame can be sent', async () => {
    const { ctx, tmux } = await service(fakeTmux(dir, argvLog))
    try {
      await expect(tmux.send('never-placed', { jsonrpc: '2.0', id: 1, method: 'x' }))
        .rejects.toThrow(TmuxChannelError)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('passes only present credentials into the pane', async () => {
    const { ctx } = await service(fakeTmux(dir, argvLog))
    process.env['DSH_FLEET_TEST_KEY'] = 'secret-value'
    try {
      await ctx.fiber.dispose()
      const second = new Context()
      await second.plugin(SubprocessLocal)
      await second.plugin(FleetTmux, {
        tmuxBin: fakeTmux(dir, argvLog),
        dshHome: dir,
        machineId: 'machine-1',
        credentialEnv: ['DSH_FLEET_TEST_KEY', 'DSH_FLEET_ABSENT_KEY'],
      })
      const channel = second.get('tmux')
      if (channel === undefined) throw new Error('ctx.tmux was not registered')
      await channel.place('worker-env', { cwd: dir, mode: 'fresh' })
      const issued = execFileSync('cat', [argvLog], { encoding: 'utf8' })
      expect(issued).toContain('-e DSH_FLEET_TEST_KEY=secret-value')
      expect(issued).not.toContain('DSH_FLEET_ABSENT_KEY')
      await second.fiber.dispose()
    } finally {
      delete process.env['DSH_FLEET_TEST_KEY']
      await ctx.fiber.dispose()
    }
  })
})

describe.skipIf(!tmuxAvailable)('FleetTmux over a real tmux server', () => {
  let dir: string
  let ctx: Context
  let channel: FleetTmux
  const socketDir = mkdtempSync(join(tmpdir(), 'fleet-tmux-socket-'))

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fleet-real-'))
    process.env['TMUX_TMPDIR'] = socketDir
    ctx = new Context()
    await ctx.plugin(SubprocessLocal)
    await ctx.plugin(FleetTmux, {
      tmuxBin: 'tmux',
      sessionPrefix: `fleet${String(process.pid)}`,
      dshBin: fakeHarness(dir),
      dshHome: dir,
      machineId: 'machine-1',
      credentialEnv: [],
      pollIntervalMs: 20,
      startTimeoutMs: 30000,
    })
    const registered = ctx.get('tmux')
    if (registered === undefined) throw new Error('ctx.tmux was not registered')
    channel = registered
  })

  afterEach(async () => {
    try {
      execFileSync('tmux', ['kill-server'], { stdio: 'ignore', env: { ...process.env } })
    } catch {
      // The server is already gone when the window was the only one.
    }
    await ctx.fiber.dispose()
    rmSync(dir, { recursive: true, force: true })
    delete process.env['TMUX_TMPDIR']
  })

  it('places a pane and completes a request/response exchange', async () => {
    const placement = await channel.place('worker-1', { cwd: dir, mode: 'fresh' })
    expect(placement.reused).toBe(false)
    expect(await channel.alive('worker-1')).toBe(true)

    const initialized = await channel.request<{ serverInfo: { name: string } }>(
      'worker-1',
      'initialize',
      { cwd: dir, provider: 'fake', model: 'fake' },
      { completion: 'response', timeoutMs: 20000 },
    )
    expect(initialized.serverInfo.name).toBe('fake-runtime')

    const prompted = await channel.request<{ messageId: string }>(
      'worker-1',
      'session/prompt',
      { sessionId: 'session-1', contentBlocks: [{ type: 'text', text: 'do the work' }] },
      { sessionId: 'session-1', completion: 'session-idle', timeoutMs: 20000 },
    )
    // The receipt proves the response frame arrived, and the idle wait proves
    // the completion rule is the notification rather than the response.
    expect(prompted.messageId).toBe('msg-1')
  })

  it('reuses a resident pane and replaces a fresh one', async () => {
    const first = await channel.place('worker-2', { cwd: dir, mode: 'resident' })
    const second = await channel.place('worker-2', { cwd: dir, mode: 'resident' })
    expect(second.reused).toBe(true)
    expect(second.target).toBe(first.target)

    await channel.place('worker-2', { cwd: dir, mode: 'fresh' })
    const afterFresh = channel.placement('worker-2')
    expect(afterFresh?.reused).toBe(false)
  })

  it('releases a pane and reports it gone', async () => {
    await channel.place('worker-3', { cwd: dir, mode: 'fresh' })
    await channel.release('worker-3')
    expect(await channel.alive('worker-3')).toBe(false)
  })

  it('adopts a pane that outlived the process that placed it', async () => {
    const session = `fleet${String(process.pid)}`
    await channel.place('worker-6', { cwd: dir, mode: 'resident' })

    // A second service instance stands for a restarted harness process: it has
    // no in-memory placement for the key, but the pane is still there.
    const restarted = new Context()
    await restarted.plugin(SubprocessLocal)
    await restarted.plugin(FleetTmux, {
      tmuxBin: 'tmux',
      sessionPrefix: session,
      dshBin: fakeHarness(dir),
      dshHome: dir,
      machineId: 'machine-1',
      credentialEnv: [],
      pollIntervalMs: 20,
      startTimeoutMs: 30000,
    })
    const reopened = restarted.get('tmux')
    if (reopened === undefined) throw new Error('ctx.tmux was not registered')
    try {
      const adopted = await reopened.place('worker-6', { cwd: dir, mode: 'resident' })
      expect(adopted.reused).toBe(true)
      // Adoption must not create a second window with the same name.
      const windows = execFileSync('tmux', ['list-windows', '-t', session, '-F', '#{window_name}'], {
        encoding: 'utf8',
        env: { ...process.env },
      })
      expect(windows.split('\n').filter(name => name === 'w-worker-6')).toHaveLength(1)
      // The adopted channel carries frames: the surviving harness answers.
      const address = Buffer.from('{"jsonrpc":"2.0","id":99,"method":"initialize","params":{}}\n')
      await reopened.send('worker-6', JSON.parse(address.toString('utf8')) as never)
      expect(await reopened.alive('worker-6')).toBe(true)
    } finally {
      await restarted.fiber.dispose()
    }
  })

  it('replaces a surviving pane when the caller asks for a fresh one', async () => {
    await channel.place('worker-7', { cwd: dir, mode: 'resident' })
    const replacement = await channel.place('worker-7', { cwd: dir, mode: 'fresh' })
    expect(replacement.reused).toBe(false)
    expect(await channel.alive('worker-7')).toBe(true)
  })

  it('fails a call whose pane disappeared instead of waiting forever', async () => {
    await channel.place('worker-4', { cwd: dir, mode: 'fresh' })
    await channel.release('worker-4')
    await expect(
      channel.request('worker-4', 'initialize', {}, { completion: 'response', timeoutMs: 5000 }),
    ).rejects.toThrow(TmuxChannelError)
  })

  it('times out with a descriptive error when the pane never answers', async () => {
    await channel.place('worker-5', { cwd: dir, mode: 'fresh' })
    await expect(
      channel.request('worker-5', 'no-such-method', {}, { completion: 'response', timeoutMs: 300 }),
    ).rejects.toThrow(/timed out/)
  })
})

describe('runTmux', () => {
  it('returns the exit code and captured streams', async () => {
    const ctx = new Context()
    await ctx.plugin(SubprocessLocal)
    try {
      const result = await runTmux(
        ctx.subprocess,
        '/bin/sh',
        ['-c', 'printf out; printf err >&2; exit 3'],
        process.cwd(),
        2000,
      )
      expect(result.code).toBe(3)
      expect(result.stdout).toBe('out')
      expect(result.stderr).toBe('err')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
