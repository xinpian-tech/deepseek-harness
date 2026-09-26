/** Per-turn archival into per-machine refs, and the grouping view read back from archived headers. */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import FleetSessionArchive from '../src/index.ts'
import type { Config } from '../src/index.ts'

// The shipped JSONL backend takes its cross-process write lease through the
// native system addon, which is not built in every checkout. This suite is
// single-process, so the lease is stubbed to immediate success exactly as the
// browser worker stubs it (see the backend's lease module): the in-process
// write claim still excludes every writer this suite can have, and every other
// part of the backend — artifact layout, batching, reads — stays real.
vi.mock('@deepseek-ai/node-addon-system/flock', () => ({
  tryLockExclusive: () => Promise.resolve(),
}))

/** Every temporary path this file created and every hook it installed. */
const cleanups: Array<() => unknown> = []

afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})

/** One turn-stopping dispatch carries this signal in the real loop. */
const signal = new AbortController().signal

/**
 * Ceiling for one spec that drives real git processes.
 *
 * Every plumbing step spawns a real git client, and a loaded host pays seconds
 * per spawn; the ceiling is generous because a genuine hang is the only thing
 * it should ever cut off.
 */
const SLOW_TEST_TIMEOUT_MS = 180_000

/**
 * Create a temporary directory this file owns.
 * @param prefix - directory name prefix.
 * @returns the absolute path of the new directory.
 */
async function scratch(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return root
}

/**
 * Run git inside a fixture repository with an identity, so no fixture depends
 * on the host's global git configuration.
 * @param cwd - directory git runs in.
 * @param args - git arguments after the executable.
 * @returns the command's stdout.
 */
function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.email=fleet@example.com', '-c', 'user.name=fleet', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
}

/**
 * Create a real repository with one commit, which is the parent an archive
 * commit descends from.
 * @returns the absolute repository root.
 */
async function repository(): Promise<string> {
  const root = await scratch('dsh-session-archive-repo-')
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.email', 'fleet@example.com')
  git(root, 'config', 'user.name', 'fleet')
  await writeFile(join(root, 'seed.txt'), 'seed\n', 'utf8')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'init')
  return root
}

/**
 * Mount the service over a real subprocess provider, session store, and JSONL
 * persistence backend — the composition whose log the archiver reads.
 * @param config - authored plugin configuration; the schema fills every default.
 * @returns the context and the fiber that mounted the plugin.
 */
async function boot(config: Partial<Config> & Pick<Config, 'repositoryRoot' | 'archiveRoot' | 'machineId'>) {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, { root: await scratch('dsh-session-archive-logs-'), compression: 'none' })
  await ctx.plugin(LocalSubprocessRuntime)
  const fiber = await ctx.plugin(FleetSessionArchive, config)
  return { ctx, fiber }
}

/**
 * Create a session whose events the persistence backend routes durably, the
 * way the agent loop owns its write handle.
 * @param ctx - context carrying the session store and persistence backend.
 * @param id - session id.
 * @param meta - session metadata (workspace, fork lineage).
 * @returns the live session.
 */
async function persistedSession(
  ctx: Context,
  id: string,
  meta: { cwd?: string; parentSession?: SessionId } = {},
): Promise<Session> {
  const session = ctx.sessions.create(SessionId(id), { ...Object.keys(meta).length === 0 ? {} : { meta } })
  const handle = await ctx.sessionPersistence.create(session.header)
  cleanups.push(() => handle.close())
  return session
}

/**
 * Append one complete turn's events without waiting for the durability barrier.
 * @param session - session to append to.
 * @param turn - turn number.
 */
function appendTurn(session: Session, turn: number): void {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

/**
 * Append one complete turn and wait for the persistence durability barrier.
 *
 * The barrier is what makes a turn's events part of the log the archiver
 * reads: routed live events are buffered for up to 200 ms, and an archiver
 * that read earlier would be archiving a prefix rather than this turn.
 * @param ctx - context carrying the persistence backend.
 * @param session - session to append to.
 * @param turn - turn number.
 */
async function logTurn(ctx: Context, session: Session, turn: number): Promise<void> {
  appendTurn(session, turn)
  await ctx.sessionPersistence.flush()
}

/**
 * Capture the warnings a context's logger emits, restoring the method afterwards.
 * @param ctx - context whose logger is observed.
 * @returns the warning messages in emission order.
 */
function captureWarnings(ctx: Context): string[] {
  const warnings: string[] = []
  const original = ctx.logger.warn
  ctx.logger.warn = (message: string) => { warnings.push(message) }
  cleanups.push(() => { ctx.logger.warn = original })
  return warnings
}

/**
 * Dispatch the turn-stopping event the agent loop dispatches.
 * @param ctx - context carrying the plugin.
 * @param session - session whose turn is stopping.
 * @param turn - turn that is about to close.
 */
async function stopTurn(ctx: Context, session: Session, turn: number): Promise<void> {
  await ctx.serial('agent/turn-stopping', { agent: { session } as never, turn, signal })
}

/** The archived file of one session inside one machine shard. */
function archiveFile(archiveRoot: string, machineId: string, sessionId: string): string {
  return join(archiveRoot, machineId, `${sessionId}.jsonl`)
}

describe('per-turn archival', () => {
  it('copies the durable log, commits it, and publishes it under the machine shard', async () => {
    const repositoryRoot = await repository()
    const archiveRoot = join(repositoryRoot, 'sessions')
    const { ctx, fiber } = await boot({ repositoryRoot, archiveRoot, machineId: 'machine-a' })
    const session = await persistedSession(ctx, 's1', { cwd: repositoryRoot })
    await logTurn(ctx, session, 1)

    const archived = await ctx.sessionArchive.archiveSession(session)
    expect(archived.ref).toBe('refs/dsh/machines/machine-a/sessions/s1')
    expect(git(repositoryRoot, 'rev-parse', archived.ref).trim()).toBe(archived.commit)

    const content = await readFile(archiveFile(archiveRoot, 'machine-a', 's1'), 'utf8')
    const lines = content.split('\n')
    expect(lines.at(-1)).toBe('')
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ type: 'session', id: 's1', cwd: repositoryRoot })
    expect(lines.slice(1, -1).map(line => JSON.parse(line).type))
      .toEqual(['turn/start', 'step/start', 'step/end', 'turn/end'])

    // The commit carries exactly that file, built from objects rather than a checkout.
    expect(git(repositoryRoot, 'show', `${archived.ref}:sessions/machine-a/s1.jsonl`)).toBe(content)
    // Archiving never writes to the session log it reads.
    expect(session.snapshotEvents()).toHaveLength(4)

    await fiber.dispose()
  }, SLOW_TEST_TIMEOUT_MS)

  it('archives on every stopping turn and advances the session ref', async () => {
    const repositoryRoot = await repository()
    const archiveRoot = join(repositoryRoot, 'sessions')
    const { ctx, fiber } = await boot({ repositoryRoot, archiveRoot, machineId: 'machine-a' })
    const session = await persistedSession(ctx, 's1', { cwd: repositoryRoot })
    await logTurn(ctx, session, 1)

    await stopTurn(ctx, session, 1)
    const refs = await ctx.sessionArchive.refs('machine-a')
    expect(refs).toEqual(['refs/dsh/machines/machine-a/sessions/s1'])
    const firstCommit = git(repositoryRoot, 'rev-parse', refs[0] ?? '').trim()

    await logTurn(ctx, session, 2)
    await stopTurn(ctx, session, 2)
    const secondCommit = git(repositoryRoot, 'rev-parse', refs[0] ?? '').trim()
    expect(secondCommit).not.toBe(firstCommit)
    // The session's ref descends from its own previous archive.
    expect(git(repositoryRoot, 'rev-parse', `${secondCommit}^`).trim()).toBe(firstCommit)

    const content = await readFile(archiveFile(archiveRoot, 'machine-a', 's1'), 'utf8')
    expect(content.split('\n').filter(line => line !== '')).toHaveLength(9)

    await fiber.dispose()
  }, SLOW_TEST_TIMEOUT_MS)

  it('refuses to archive a log that holds no durable event yet', async () => {
    const repositoryRoot = await repository()
    const archiveRoot = join(repositoryRoot, 'sessions')
    const { ctx, fiber } = await boot({ repositoryRoot, archiveRoot, machineId: 'machine-a' })
    const warnings = captureWarnings(ctx)
    const session = await persistedSession(ctx, 'unflushed', { cwd: repositoryRoot })

    // The log is materialized but holds no event: this is the state an
    // archiver must refuse rather than fill in from live memory.
    await expect(ctx.sessionArchive.archiveSession(session)).rejects.toThrow(/holds no durable event to archive/)
    expect(existsSync(archiveFile(archiveRoot, 'machine-a', 'unflushed'))).toBe(false)
    expect(await ctx.sessionArchive.refs('machine-a')).toEqual([])

    // The turn that could not be archived is reported, not failed.
    await expect(stopTurn(ctx, session, 1)).resolves.toBeUndefined()
    expect(warnings.join('\n')).toMatch(/was not archived/)

    // Once the log holds durable events, the next turn archives the whole prefix.
    await logTurn(ctx, session, 1)
    await stopTurn(ctx, session, 2)
    expect(await ctx.sessionArchive.refs('machine-a')).toEqual(['refs/dsh/machines/machine-a/sessions/unflushed'])

    await fiber.dispose()
  }, SLOW_TEST_TIMEOUT_MS)
})

describe('ref sharding', () => {
  it('keeps each machine in its own ref namespace', async () => {
    const repositoryRoot = await repository()
    const archiveRoot = join(repositoryRoot, 'sessions')
    const first = await boot({ repositoryRoot, archiveRoot, machineId: 'machine-a' })
    const second = await boot({ repositoryRoot, archiveRoot, machineId: 'machine-b' })
    const one = await persistedSession(first.ctx, 's1', { cwd: repositoryRoot })
    const two = await persistedSession(second.ctx, 's2', { cwd: repositoryRoot })
    await logTurn(first.ctx, one, 1)
    await logTurn(second.ctx, two, 1)

    const archivedOne = await first.ctx.sessionArchive.archiveSession(one)
    const archivedTwo = await second.ctx.sessionArchive.archiveSession(two)
    expect(archivedOne.ref).toBe('refs/dsh/machines/machine-a/sessions/s1')
    expect(archivedTwo.ref).toBe('refs/dsh/machines/machine-b/sessions/s2')
    expect(await first.ctx.sessionArchive.refs('machine-a')).toEqual([archivedOne.ref])
    expect(await first.ctx.sessionArchive.refs('machine-b')).toEqual([archivedTwo.ref])
    expect(await first.ctx.sessionArchive.refs('machine-c')).toEqual([])
    await expect(first.ctx.sessionArchive.refs('bad/../id')).rejects.toThrow(/machineId must match/)

    await first.fiber.dispose()
    await second.fiber.dispose()
  }, SLOW_TEST_TIMEOUT_MS)

  it('encodes a session id that cannot name a path or ref segment', async () => {
    const repositoryRoot = await repository()
    const archiveRoot = join(repositoryRoot, 'sessions')
    const { ctx, fiber } = await boot({ repositoryRoot, archiveRoot, machineId: 'machine-a' })
    const session = await persistedSession(ctx, '../escape', { cwd: repositoryRoot })
    await logTurn(ctx, session, 1)

    const archived = await ctx.sessionArchive.archiveSession(session)
    expect(archived.ref).toBe('refs/dsh/machines/machine-a/sessions/_002E_002E_002Fescape')
    expect(git(repositoryRoot, 'check-ref-format', archived.ref)).toBe('')
    expect(existsSync(join(archiveRoot, 'machine-a', '_002E_002E_002Fescape.jsonl'))).toBe(true)

    await fiber.dispose()
  }, SLOW_TEST_TIMEOUT_MS)
})

describe('grouping from content', () => {
  it('rebuilds a two-level family from archived headers across machine shards', async () => {
    const repositoryRoot = await repository()
    const archiveRoot = join(repositoryRoot, 'sessions')
    const parent = await boot({ repositoryRoot, archiveRoot, machineId: 'machine-a' })
    const child = await boot({ repositoryRoot, archiveRoot, machineId: 'machine-b' })

    const root = await persistedSession(parent.ctx, 'root-session', { cwd: repositoryRoot })
    await logTurn(parent.ctx, root, 1)
    await parent.ctx.sessionArchive.archiveSession(root)
    const descendant = await persistedSession(child.ctx, 'child-session', {
      cwd: repositoryRoot,
      parentSession: root.id,
    })
    await logTurn(child.ctx, descendant, 1)
    await child.ctx.sessionArchive.archiveSession(descendant)

    const family = await child.ctx.sessionArchive.family('child-session')
    expect(family?.root.id).toBe('root-session')
    expect(family?.session.id).toBe('child-session')
    expect(family?.ancestors.map(ancestor => ancestor.id)).toEqual(['root-session'])
    expect(family?.root.children.map(member => member.id)).toEqual(['child-session'])
    expect(family?.root.machine).toBe('machine-a')
    expect(family?.session.machine).toBe('machine-b')

    const rootFamily = await child.ctx.sessionArchive.family('root-session')
    expect(rootFamily?.root.id).toBe('root-session')
    expect(rootFamily?.session.children.map(member => member.id)).toEqual(['child-session'])
    expect(rootFamily?.ancestors).toEqual([])
    expect(await child.ctx.sessionArchive.family('never-archived')).toBeUndefined()

    await parent.fiber.dispose()
    await child.fiber.dispose()
  }, SLOW_TEST_TIMEOUT_MS)
})

describe('registration and configuration', () => {
  it('unregisters the service and stops archiving when its fiber is disposed', async () => {
    const repositoryRoot = await repository()
    const archiveRoot = join(repositoryRoot, 'sessions')
    const { ctx, fiber } = await boot({ repositoryRoot, archiveRoot, machineId: 'machine-a' })
    const session = await persistedSession(ctx, 's1', { cwd: repositoryRoot })

    await logTurn(ctx, session, 1)
    await stopTurn(ctx, session, 1)
    const ref = 'refs/dsh/machines/machine-a/sessions/s1'
    const committed = git(repositoryRoot, 'rev-parse', ref).trim()

    await fiber.dispose()
    expect(ctx.get('sessionArchive')).toBeUndefined()
    await logTurn(ctx, session, 2)
    await stopTurn(ctx, session, 2)
    expect(git(repositoryRoot, 'rev-parse', ref).trim()).toBe(committed)
  }, SLOW_TEST_TIMEOUT_MS)

  it('registers no turn hook when it is disabled', async () => {
    const repositoryRoot = await repository()
    const archiveRoot = join(repositoryRoot, 'sessions')
    const { ctx, fiber } = await boot({ repositoryRoot, archiveRoot, machineId: 'machine-a', enabled: false })
    const session = await persistedSession(ctx, 's1', { cwd: repositoryRoot })

    await logTurn(ctx, session, 1)
    await stopTurn(ctx, session, 1)
    expect(await ctx.sessionArchive.refs('machine-a')).toEqual([])

    // The explicit call is what a caller asked for by name.
    await expect(ctx.sessionArchive.archiveSession(session)).resolves.toMatchObject({
      ref: 'refs/dsh/machines/machine-a/sessions/s1',
    })
    await fiber.dispose()
  }, SLOW_TEST_TIMEOUT_MS)
})

describe('configuration failures', () => {
  const rejected: readonly {
    readonly name: string
    readonly config: Config
    readonly pattern: RegExp
  }[] = [
    {
      name: 'a relative repository root',
      config: { repositoryRoot: 'repo', archiveRoot: '/tmp/archive', machineId: 'machine-a' },
      pattern: /repositoryRoot must be an absolute path/,
    },
    {
      name: 'a relative archive root',
      config: { repositoryRoot: '/tmp', archiveRoot: 'sessions', machineId: 'machine-a' },
      pattern: /archiveRoot must be an absolute path/,
    },
    {
      name: 'an archive root outside the repository',
      config: { repositoryRoot: '/tmp', archiveRoot: '/var/lib/sessions', machineId: 'machine-a' },
      pattern: /archiveRoot must be a directory inside repositoryRoot/,
    },
    {
      name: 'an empty machine id',
      config: { repositoryRoot: '/tmp', archiveRoot: '/tmp/sessions', machineId: '' },
      pattern: /machineId must match/,
    },
    {
      name: 'a machine id that cannot name a ref segment',
      config: { repositoryRoot: '/tmp', archiveRoot: '/tmp/sessions', machineId: 'a/b' },
      pattern: /machineId must match/,
    },
    {
      name: 'a ref prefix that is not a namespace',
      config: { repositoryRoot: '/tmp', archiveRoot: '/tmp/sessions', machineId: 'machine-a', refPrefix: 'machines' },
      pattern: /refPrefix must be a full ref namespace/,
    },
  ]

  it.each(rejected)('fails at load on $name', async ({ config, pattern }) => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root: await scratch('dsh-session-archive-logs-'), compression: 'none' })
    await ctx.plugin(LocalSubprocessRuntime)
    await expect(ctx.plugin(FleetSessionArchive, config)).rejects.toThrow(pattern)
  })

  it('fails at load on a missing repository or a directory outside a git working tree', async () => {
    const plain = await scratch('dsh-session-archive-plain-')
    const mount = async (repositoryRoot: string, archiveRoot: string) => {
      const ctx = new Context()
      await ctx.plugin(SessionStore)
      await ctx.plugin(JsonlSessionPersistence, {
        root: await scratch('dsh-session-archive-logs-'),
        compression: 'none',
      })
      await ctx.plugin(LocalSubprocessRuntime)
      await ctx.plugin(FleetSessionArchive, { repositoryRoot, archiveRoot, machineId: 'machine-a' })
    }
    await expect(mount(join(plain, 'absent'), join(plain, 'absent', 'sessions')))
      .rejects.toThrow(/repositoryRoot is not a directory/)
    await expect(mount(plain, join(plain, 'sessions'))).rejects.toThrow(/is not a git working tree/)
  })
})
