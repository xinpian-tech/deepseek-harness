import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import FleetTmux from '../../tmux/src/index.ts'
import * as SubagentTmux from '../src/index.ts'

/**
 * A child runtime stand-in for one pane. It answers the two requests the
 * provider sends, publishes the session events a real child would publish for
 * one completed turn, and reports the session idle — which is the only
 * completion signal the provider may act on.
 */
function fakeChild(dir: string): string {
  const path = join(dir, 'fake-child')
  writeFileSync(path, `#!${process.execPath}
process.stdin.setEncoding('utf8')
let buffer = ''
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index = buffer.indexOf('\\n')
  while (index >= 0) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (line.trim() !== '') {
      const frame = JSON.parse(line)
      if (frame.method === 'initialize') {
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0', id: frame.id, result: { serverInfo: { name: 'fake-runtime', version: '0' } },
        }) + '\\n')
      } else if (frame.method === 'session/prompt') {
        const sessionId = frame.params.sessionId
        const emit = (event) => process.stdout.write(JSON.stringify({
          jsonrpc: '2.0', method: 'session.event', params: { sessionId, event },
        }) + '\\n')
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0', id: frame.id, result: { messageId: 'msg-1' },
        }) + '\\n')
        emit({
          type: 'assistant/message',
          data: { message: { content: [{ type: 'text', text: 'child finished the work' }] }, stream: [] },
        })
        emit({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0', method: 'session.status', params: { sessionId, status: 'idle' },
        }) + '\\n')
      }
    }
    index = buffer.indexOf('\\n')
  }
})
`)
  chmodSync(path, 0o755)
  return path
}

/**
 * A child runtime that acknowledges the prompt and never reports the session
 * idle, modelling the failure mode §5.4 warns about: the response is not a
 * completion signal.
 */
function silentChild(dir: string): string {
  const path = join(dir, 'silent-child')
  writeFileSync(path, `#!${process.execPath}
process.stdin.setEncoding('utf8')
let buffer = ''
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index = buffer.indexOf('\\n')
  while (index >= 0) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (line.trim() !== '') {
      const frame = JSON.parse(line)
      if (frame.method === 'initialize' || frame.method === 'session/prompt') {
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0', id: frame.id, result: frame.method === 'initialize'
            ? { serverInfo: { name: 'silent-runtime', version: '0' } }
            : { messageId: 'msg-1' },
        }) + '\\n')
      }
    }
    index = buffer.indexOf('\\n')
  }
})
`)
  chmodSync(path, 0o755)
  return path
}

function hasTmux(): boolean {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const tmuxAvailable = hasTmux()
const socketDir = mkdtempSync(join(tmpdir(), 'fleet-subagent-socket-'))

describe('subagent-tmux plugin shape', () => {
  it('keeps named function-plugin exports with no default export', () => {
    expect(SubagentTmux.name).toBe('subagent-tmux')
    expect(SubagentTmux.inject).toEqual(['subagents', 'tmux'])
    expect(typeof SubagentTmux.apply).toBe('function')
    expect((SubagentTmux as Record<string, unknown>)['default']).toBeUndefined()
  })
})

describe.skipIf(!tmuxAvailable)('subagent-tmux over a real tmux server', () => {
  let dir: string
  let ctx: Context

  beforeEach(() => {
    process.env['TMUX_TMPDIR'] = socketDir
  })

  afterEach(async () => {
    try {
      execFileSync('tmux', ['kill-server'], { stdio: 'ignore', env: { ...process.env } })
    } catch {
      // No server is left when the window was the only one.
    }
    await ctx.fiber.dispose()
    rmSync(dir, { recursive: true, force: true })
    delete process.env['TMUX_TMPDIR']
  })

  /** Mount the loop, the subagent seam, the tmux channel, and the provider. */
  async function mount(child: string, sessionMode: 'fresh' | 'resident', turnTimeoutMs = 0) {
    dir = mkdtempSync(join(tmpdir(), 'fleet-provider-'))
    ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    const driver = await mountAgentLoopTestHarness(ctx)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(SubprocessLocal)
    await ctx.plugin(FleetTmux, {
      sessionPrefix: `provider${String(process.pid)}`,
      dshBin: child,
      dshHome: dir,
      machineId: 'machine-1',
      credentialEnv: [],
      pollIntervalMs: 20,
      startTimeoutMs: 30_000,
    })
    await ctx.plugin(SubagentTmux, { providerName: 'tmux', sessionMode, turnTimeoutMs, cwd: dir })
    return driver
  }

  it('runs a child in a pane and reports its final assistant message', async () => {
    const driver = await mount(fakeChild(mkdtempSync(join(tmpdir(), 'child-'))), 'fresh')
    const parent = await driver.create(SessionId('session-parent-1'), { provider: 'mock', model: 'mock' })

    const run = await ctx.subagents.start('tmux', {
      label: 'task-1',
      prompt: [{ type: 'text', text: 'do the work' }],
      parent,
      signal: new AbortController().signal,
    })
    const result = await run.result
    expect(result.stopReason).toBe('completed')
    expect(result.output).toEqual([{ type: 'text', text: 'child finished the work' }])

    // The placement is durable data on the delegating session, not just
    // in-memory state in the process that created the pane (§11 item 2).
    const placements = parent.session.snapshotEvents().filter(event => event.type === 'tmux/placement')
    expect(placements).toHaveLength(1)
    await run.dispose()
  })

  it('waits for the child session to go idle rather than for the enqueue receipt', async () => {
    const driver = await mount(silentChild(mkdtempSync(join(tmpdir(), 'child-'))), 'fresh', 400)
    const parent = await driver.create(SessionId('session-parent-2'), { provider: 'mock', model: 'mock' })
    const run = await ctx.subagents.start('tmux', {
      label: 'task-2',
      prompt: [{ type: 'text', text: 'never finishes' }],
      parent,
      signal: new AbortController().signal,
    })
    const result = await run.result
    // The receipt arrived, the turn never completed: the seam reports a
    // child-level error rather than a silent success.
    expect(result.stopReason).toBe('error')
    expect(result.diagnostic).toBeTruthy()
    await run.dispose()
  })
})

describe.skipIf(!tmuxAvailable)('resident sessions', () => {
  let dir: string
  let ctx: Context

  beforeEach(() => {
    process.env['TMUX_TMPDIR'] = socketDir
  })

  afterEach(async () => {
    try {
      execFileSync('tmux', ['kill-server'], { stdio: 'ignore', env: { ...process.env } })
    } catch {
      // No server is left when the window was the only one.
    }
    await ctx.fiber.dispose()
    delete process.env['TMUX_TMPDIR']
  })

  it('reuses one pane and one child session across correction rounds', async () => {
    dir = mkdtempSync(join(tmpdir(), 'fleet-resident-'))
    ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    const driver = await mountAgentLoopTestHarness(ctx)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(SubprocessLocal)
    await ctx.plugin(FleetTmux, {
      sessionPrefix: `resident${String(process.pid)}`,
      dshBin: fakeChild(mkdtempSync(join(tmpdir(), 'child-'))),
      dshHome: dir,
      machineId: 'machine-1',
      credentialEnv: [],
      pollIntervalMs: 20,
      startTimeoutMs: 30_000,
    })
    await ctx.plugin(SubagentTmux, { providerName: 'tmux', sessionMode: 'resident', cwd: dir })
    const parent = await driver.create(SessionId('session-parent-3'), { provider: 'mock', model: 'mock' })
    const request = {
      label: 'rework-me',
      prompt: [{ type: 'text' as const, text: 'first attempt' }],
      parent,
      signal: new AbortController().signal,
    }

    const first = await ctx.subagents.start('tmux', request)
    await first.result
    const pane = ctx.tmux.placementsList()[0]
    expect(pane).toBeDefined()
    await first.dispose()
    // A resident pane survives its run, so the correction round continues the
    // same conversation instead of restarting it (§4 invariant R-4).
    expect(await ctx.tmux.alive(pane?.key ?? '')).toBe(true)

    const second = await ctx.subagents.start('tmux', request)
    await second.result
    // One pane, two placements: the second round reused the channel rather
    // than placing a new one, and both records are durable.
    expect(ctx.tmux.placementsList()).toHaveLength(1)
    const placements = parent.session.snapshotEvents().filter(event => event.type === 'tmux/placement')
    expect(placements).toHaveLength(2)
    expect(placements[1]?.data.key).toBe(placements[0]?.data.key)
    await second.dispose()
  })
})
