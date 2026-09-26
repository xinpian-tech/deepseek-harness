/** Two-phase archival over real repositories: one local commit per turn, and a durable push queue behind it. */
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import FleetGitCheckpoint from '../src/index.ts'
import type { Config } from '../src/index.ts'

/** Every temporary path this file created and every warning hook it installed. */
const cleanups: Array<() => unknown> = []

afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})

/** One turn-stopping dispatch carries this signal in the real loop. */
const signal = new AbortController().signal

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
 * Create a real repository with one commit, which is what a checkpoint needs
 * to have a HEAD to advance.
 * @returns the absolute repository root.
 */
async function repository(): Promise<string> {
  const root = await scratch('dsh-git-checkpoint-repo-')
  git(root, 'init', '-q', '-b', 'main')
  // The plugin commits through the deployment's own git, not through this
  // file's `-c` overrides, so the fixture repository must carry an identity.
  git(root, 'config', 'user.email', 'fleet@example.com')
  git(root, 'config', 'user.name', 'fleet')
  await writeFile(join(root, 'seed.txt'), 'seed\n', 'utf8')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'init')
  return root
}

/**
 * Create a bare repository at an exact path, so a test decides when a remote appears.
 * @param path - absolute path of the bare repository.
 * @returns the same path.
 */
async function bareAt(path: string): Promise<string> {
  await mkdir(path, { recursive: true })
  git(path, 'init', '-q', '--bare', '-b', 'main')
  return path
}

/**
 * Mount the service over a real subprocess provider and session store.
 * @param config - authored plugin configuration; the schema fills every default.
 * @returns the context and the fiber that mounted the plugin.
 */
async function boot(config: Config) {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(LocalSubprocessRuntime)
  const fiber = await ctx.plugin(FleetGitCheckpoint, config)
  return { ctx, fiber }
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

/** The commit ids the recorded checkpoints name, in log order. */
function checkpoints(session: Session) {
  return session.snapshotEvents().filter(event => event.type === 'git/checkpoint').map(event => event.data)
}

/** The commit HEAD points at. */
function head(cwd: string): string {
  return git(cwd, 'rev-parse', 'HEAD').trim()
}

/** How many commits the repository's history holds. */
function commits(cwd: string): number {
  return Number(git(cwd, 'rev-list', '--count', 'HEAD').trim())
}

/** The refs one bare repository holds. */
function remoteRefs(cwd: string): string[] {
  return git(cwd, 'for-each-ref', '--format=%(refname)').split('\n').filter(line => line !== '')
}

describe('turn checkpoints', () => {
  it('commits the workspace once per turn and never for an unchanged turn', async () => {
    const repositoryRoot = await repository()
    const queueFile = join(await scratch('dsh-git-checkpoint-queue-'), 'pending.tsv')
    const { ctx, fiber } = await boot({ repositoryRoot, queueFile })
    const warnings = captureWarnings(ctx)
    const session = ctx.sessions.create(SessionId('s1'), { meta: { cwd: repositoryRoot } })
    const before = commits(repositoryRoot)

    await writeFile(join(repositoryRoot, 'one.txt'), '1\n', 'utf8')
    await stopTurn(ctx, session, 1)
    expect(commits(repositoryRoot)).toBe(before + 1)
    expect(checkpoints(session)).toEqual([
      { turn: 1, commit: head(repositoryRoot), repository: repositoryRoot, branch: 'main', ref: 'refs/heads/main' },
    ])
    expect(git(repositoryRoot, 'log', '-1', '--format=%s').trim()).toBe('dsh checkpoint: session s1 turn 1')

    // Phase 1 is local: the ref is queued durably and no push was attempted.
    expect(await readFile(queueFile, 'utf8')).toBe(`${repositoryRoot}\torigin\trefs/heads/main\n`)
    expect(warnings).toEqual([])

    // A turn that changed nothing creates no empty commit and no record.
    await stopTurn(ctx, session, 2)
    expect(commits(repositoryRoot)).toBe(before + 1)
    expect(checkpoints(session)).toHaveLength(1)

    // A repeated stopping event for an already committed turn commits nothing,
    // so what it left behind is carried by the next turn's checkpoint.
    await writeFile(join(repositoryRoot, 'two.txt'), '2\n', 'utf8')
    await stopTurn(ctx, session, 1)
    expect(commits(repositoryRoot)).toBe(before + 1)
    expect(checkpoints(session)).toHaveLength(1)
    await stopTurn(ctx, session, 3)
    expect(commits(repositoryRoot)).toBe(before + 2)
    expect(checkpoints(session).map(entry => entry.turn)).toEqual([1, 3])
    expect(git(repositoryRoot, 'show', '--name-only', '--format=', 'HEAD').trim()).toBe('two.txt')

    await fiber.dispose()
  })

  it('records nothing and keeps the turn alive when the workspace cannot be committed', async () => {
    const workspace = await scratch('dsh-git-checkpoint-plain-')
    const queueFile = join(await scratch('dsh-git-checkpoint-queue-'), 'pending.tsv')
    const { ctx, fiber } = await boot({ queueFile })
    const warnings = captureWarnings(ctx)
    const session = ctx.sessions.create(SessionId('s-plain'), { meta: { cwd: workspace } })

    await writeFile(join(workspace, 'one.txt'), '1\n', 'utf8')
    await expect(stopTurn(ctx, session, 1)).resolves.toBeUndefined()
    expect(checkpoints(session)).toEqual([])
    expect(warnings.join('\n')).toMatch(/was not checkpointed/)
    expect(await readFile(queueFile, 'utf8').catch(() => '')).toBe('')

    await fiber.dispose()
  })
})

describe('the push queue', () => {
  it('drains a ref queued by a process that is already gone', async () => {
    const repositoryRoot = await repository()
    const remote = await bareAt(join(await scratch('dsh-git-checkpoint-remote-'), 'origin.git'))
    git(repositoryRoot, 'remote', 'add', 'origin', remote)
    const queueFile = join(await scratch('dsh-git-checkpoint-queue-'), 'pending.tsv')

    const first = await boot({ repositoryRoot, queueFile })
    await first.ctx.gitCheckpoint.enqueuePush('refs/heads/main', repositoryRoot)
    expect(remoteRefs(remote)).toEqual([])
    await first.fiber.dispose()

    // A second instance reads the same durable queue file and pushes what the
    // first one queued before it exited.
    const second = await boot({ repositoryRoot, queueFile })
    const report = await second.ctx.gitCheckpoint.drain()
    expect(report.pushed.map(entry => entry.ref)).toEqual(['refs/heads/main'])
    expect(report.failed).toEqual([])
    expect(git(remote, 'rev-parse', 'refs/heads/main').trim()).toBe(head(repositoryRoot))
    expect(await readFile(queueFile, 'utf8')).toBe('')

    await second.fiber.dispose()
  })

  it('returns from enqueuePush without a round trip and blocks in finalPush until the remote has the ref', async () => {
    const repositoryRoot = await repository()
    const held = join(await scratch('dsh-git-checkpoint-remote-'), 'origin.git')
    git(repositoryRoot, 'remote', 'add', 'origin', held)
    const queueFile = join(await scratch('dsh-git-checkpoint-queue-'), 'pending.tsv')
    const { ctx, fiber } = await boot({ repositoryRoot, queueFile, backoffBaseMs: 5, backoffMaxMs: 10 })
    const warnings = captureWarnings(ctx)

    await ctx.gitCheckpoint.enqueuePush('refs/heads/main', repositoryRoot)
    expect(await readFile(queueFile, 'utf8')).toBe(`${repositoryRoot}\torigin\trefs/heads/main\n`)
    expect(warnings).toEqual([])

    let settled = false
    const blocking = ctx.gitCheckpoint.finalPush('refs/heads/main', repositoryRoot)
      .then((entry) => { settled = true; return entry })
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(settled).toBe(false)

    // The remote appears; the retrying final push is the only path that waited.
    await bareAt(held)
    await expect(blocking).resolves.toMatchObject({ ref: 'refs/heads/main', remote: 'origin' })
    expect(settled).toBe(true)
    expect(git(held, 'rev-parse', 'refs/heads/main').trim()).toBe(head(repositoryRoot))
    expect(await readFile(queueFile, 'utf8')).toBe('')

    await fiber.dispose()
  })

  it('reports a failed push through the log and leaves the ref queued', async () => {
    const repositoryRoot = await repository()
    const absent = join(await scratch('dsh-git-checkpoint-absent-'), 'nowhere.git')
    git(repositoryRoot, 'remote', 'add', 'origin', absent)
    const queueFile = join(await scratch('dsh-git-checkpoint-queue-'), 'pending.tsv')
    const { ctx, fiber } = await boot({
      repositoryRoot, queueFile, maxAttempts: 1, backoffBaseMs: 5, backoffMaxMs: 10,
    })
    const warnings = captureWarnings(ctx)
    const session = ctx.sessions.create(SessionId('s1'), { meta: { cwd: repositoryRoot } })

    await writeFile(join(repositoryRoot, 'one.txt'), '1\n', 'utf8')
    await expect(stopTurn(ctx, session, 1)).resolves.toBeUndefined()
    expect(checkpoints(session)).toHaveLength(1)

    const report = await ctx.gitCheckpoint.drain()
    expect(report.pushed).toEqual([])
    expect(report.failed.map(entry => entry.ref)).toEqual(['refs/heads/main'])
    expect(warnings.join('\n')).toMatch(/could not push refs\/heads\/main/)
    // The ref survives the failure: the next drain retries it.
    expect(await readFile(queueFile, 'utf8')).toBe(`${repositoryRoot}\torigin\trefs\/heads\/main\n`.replace('\\', ''))

    await fiber.dispose()
  })
})

describe('registration and configuration', () => {
  it('unregisters the service and stops committing when its fiber is disposed', async () => {
    const repositoryRoot = await repository()
    const queueFile = join(await scratch('dsh-git-checkpoint-queue-'), 'pending.tsv')
    const { ctx, fiber } = await boot({ repositoryRoot, queueFile })
    const session = ctx.sessions.create(SessionId('s1'), { meta: { cwd: repositoryRoot } })

    await writeFile(join(repositoryRoot, 'one.txt'), '1\n', 'utf8')
    await stopTurn(ctx, session, 1)
    const committed = commits(repositoryRoot)

    await fiber.dispose()
    expect(ctx.get('gitCheckpoint')).toBeUndefined()
    await writeFile(join(repositoryRoot, 'two.txt'), '2\n', 'utf8')
    await stopTurn(ctx, session, 2)
    expect(commits(repositoryRoot)).toBe(committed)
    expect(checkpoints(session)).toHaveLength(1)
  })

  it('registers no turn hook when it is disabled', async () => {
    const repositoryRoot = await repository()
    const queueFile = join(await scratch('dsh-git-checkpoint-queue-'), 'pending.tsv')
    const { ctx, fiber } = await boot({ repositoryRoot, queueFile, enabled: false })
    const session = ctx.sessions.create(SessionId('s1'), { meta: { cwd: repositoryRoot } })

    await writeFile(join(repositoryRoot, 'one.txt'), '1\n', 'utf8')
    await stopTurn(ctx, session, 1)
    expect(checkpoints(session)).toEqual([])
    expect(commits(repositoryRoot)).toBe(1)

    // The explicit push API is what a caller asked for by name.
    await expect(ctx.gitCheckpoint.enqueuePush('refs/heads/main', repositoryRoot)).resolves.toMatchObject({
      ref: 'refs/heads/main',
    })
    await fiber.dispose()
  })
})

describe('configuration failures', () => {
  const rejected: readonly { readonly name: string; readonly config: Config; readonly pattern: RegExp }[] = [
    {
      name: 'a relative repository root',
      config: { repositoryRoot: 'relative/repo' },
      pattern: /repositoryRoot must be an absolute path/,
    },
    {
      name: 'a missing repository',
      config: { repositoryRoot: join(tmpdir(), 'dsh-git-checkpoint-absent-root') },
      pattern: /repositoryRoot is not a directory/,
    },
    {
      name: 'a relative queue file',
      config: { queueFile: 'pending.tsv' },
      pattern: /queueFile must be an absolute path/,
    },
    { name: 'an empty remote', config: { remote: '  ' }, pattern: /remote must be a non-empty remote name/ },
    {
      name: 'a commit message that does not name the turn',
      config: { commitMessageTemplate: 'checkpoint {session}' },
      pattern: /must name the \{turn\}/,
    },
    {
      name: 'a retry ceiling below the first delay',
      config: { backoffBaseMs: 500, backoffMaxMs: 100 },
      pattern: /must be at least backoffBaseMs/,
    },
  ]

  it.each(rejected)('fails at load on $name', async ({ config, pattern }) => {
    const ctx = new Context()
    await ctx.plugin(LocalSubprocessRuntime)
    await expect(ctx.plugin(FleetGitCheckpoint, config)).rejects.toThrow(pattern)
  })

  it('fails at load when the configured root is not a git working tree', async () => {
    const plain = await scratch('dsh-git-checkpoint-plain-')
    const ctx = new Context()
    await ctx.plugin(LocalSubprocessRuntime)
    await expect(ctx.plugin(FleetGitCheckpoint, { repositoryRoot: plain }))
      .rejects.toThrow(/is not a git working tree/)
  })
})
