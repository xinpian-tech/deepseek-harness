/**
 * Worktree isolation over a real temporary repository: creation, reuse, the
 * candidate bound, selection that keeps swept-out candidates, prune under both
 * `keepLosers` values, read-back from durable state, the session records of
 * every outcome, and disposal of the registration.
 *
 * Every fixture is a real git repository under `os.tmpdir()` with a real base
 * commit, and git runs through the local subprocess provider, so the tests
 * exercise the same seam a deployment uses.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import FleetWorktrees, {
  WorktreeError,
  candidateBranch,
  resolveConfig,
  selectedBranch,
} from '../src/index.ts'
import type { Config } from '../src/index.ts'

/** Temp directories created by the running test, removed with all their worktrees in afterEach. */
const temporary: string[] = []

/** Root contexts created by the running test, disposed in afterEach. */
const contexts: Context[] = []

/**
 * Bound for one test whose service calls run real git through the local
 * subprocess provider. One candidate round trip spawns several git processes,
 * and the provider re-checks its platform containment prerequisites per spawn,
 * so a machine shared with other builds inflates the wall clock well past the
 * default per-test bound.
 */
const GIT_TEST_TIMEOUT_MS = 60_000

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true })
})

/**
 * Run one git command in a directory and return its stdout.
 * @param cwd - directory to run in.
 * @param argv - arguments after the git executable.
 * @returns trimmed stdout.
 */
function git(cwd: string, argv: readonly string[]): string {
  return execFileSync('git', [...argv], { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim()
}

/**
 * Create a real repository with one base commit.
 * @param root - temp directory to create it in.
 * @returns the repository path.
 */
function createRepository(root: string): string {
  const repository = join(root, 'repository')
  mkdirSync(repository)
  git(repository, ['init', '-b', 'main'])
  writeFileSync(join(repository, 'README.md'), '# candidate fixture\n')
  git(repository, ['add', 'README.md'])
  git(repository, ['-c', 'user.email=dsh@example.test', '-c', 'user.name=dsh', 'commit', '-m', 'base'])
  return repository
}

/**
 * Whether a local branch exists in a repository.
 * @param repository - repository to inspect.
 * @param branch - branch name without the `refs/heads/` prefix.
 * @returns true when the ref resolves.
 */
function branchExists(repository: string, branch: string): boolean {
  try {
    git(repository, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
    return true
  } catch {
    // The ref does not resolve, which is what "the branch is gone" means here.
    return false
  }
}

/** One worktree service over a fresh repository. */
interface Harness {
  /** Context owning the service and the subprocess provider. */
  readonly ctx: Context
  /** The mounted service. */
  readonly worktrees: FleetWorktrees
  /** The fixture repository. */
  readonly repository: string
  /** The configured worktree root. */
  readonly worktreeRoot: string
  /** The configuration the service was mounted with. */
  readonly config: Config
}

/**
 * Mount the service over a fresh repository.
 * @param overrides - configuration fields the test wants to change.
 * @returns the mounted harness.
 */
async function createHarness(overrides: Partial<Config> = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-worktree-'))
  temporary.push(root)
  const repository = createRepository(root)
  const worktreeRoot = join(root, 'worktrees')
  const config: Config = { repositoryRoot: repository, worktreeRoot, maxCandidates: 2, ...overrides }
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LocalSubprocess)
  await ctx.plugin(FleetWorktrees, config)
  return { ctx, worktrees: ctx.worktrees, repository, worktreeRoot, config }
}

describe('worktree isolation', () => {
  it('creates a candidate on its own branch and lists it from durable state', { timeout: GIT_TEST_TIMEOUT_MS }, async () => {
    const { worktrees, repository, worktreeRoot } = await createHarness()
    const base = git(repository, ['rev-parse', 'HEAD'])

    const candidate = await worktrees.createCandidate('task-1', 0)

    expect(candidate).toEqual({
      taskId: 'task-1',
      index: 0,
      path: join(worktreeRoot, 'task-1', 'c0'),
      branch: 'fleet/candidate/task-1/c0',
      baseCommit: base,
      createdAt: expect.any(Number),
    })
    expect(existsSync(join(candidate.path, 'README.md'))).toBe(true)
    expect(git(candidate.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('fleet/candidate/task-1/c0')
    expect(git(candidate.path, ['rev-parse', 'HEAD'])).toBe(base)
    await expect(worktrees.list('task-1')).resolves.toEqual([candidate])
    await expect(worktrees.list('task-2')).resolves.toEqual([])
  })

  it('reuses a recorded candidate and keeps the commits it already made', { timeout: GIT_TEST_TIMEOUT_MS }, async () => {
    const { worktrees } = await createHarness()
    const first = await worktrees.createCandidate('task-1', 0)
    writeFileSync(join(first.path, 'candidate.txt'), 'candidate work\n')
    git(first.path, ['add', 'candidate.txt'])
    git(first.path, ['-c', 'user.email=dsh@example.test', '-c', 'user.name=dsh', 'commit', '-m', 'candidate work'])

    const second = await worktrees.createCandidate('task-1', 0)

    expect(second).toEqual(first)
    expect(git(first.path, ['rev-list', '--count', 'HEAD'])).toBe('2')
    await expect(worktrees.list('task-1')).resolves.toEqual([first])
  })

  it('refuses a candidate beyond the configured maxCandidates', { timeout: GIT_TEST_TIMEOUT_MS }, async () => {
    const { worktrees } = await createHarness({ maxCandidates: 2 })
    await worktrees.createCandidate('task-1', 0)
    await worktrees.createCandidate('task-1', 1)

    await expect(worktrees.createCandidate('task-1', 2)).rejects.toThrow(/maxCandidates is 2/)
    await expect(worktrees.createCandidate('task-1', 1)).resolves.toMatchObject({ index: 1 })
  })

  it('records the selection on a separate branch and keeps every swept-out candidate', { timeout: GIT_TEST_TIMEOUT_MS }, async () => {
    const { worktrees, repository } = await createHarness({ keepLosers: true })
    const accepted = await worktrees.createCandidate('task-1', 0)
    const sweptOut = await worktrees.createCandidate('task-1', 1)

    await worktrees.select('task-1', 0)

    expect(git(repository, ['rev-parse', 'refs/heads/fleet/selected/task-1']))
      .toBe(git(repository, ['rev-parse', `refs/heads/${accepted.branch}`]))
    // The two namespaces are what tells the accepted commit from a candidate (§5.5).
    expect(branchExists(repository, 'fleet/candidate/task-1/c1')).toBe(true)
    expect(existsSync(sweptOut.path)).toBe(true)
    await expect(worktrees.prune('task-1')).resolves.toEqual([])
    expect(existsSync(sweptOut.path)).toBe(true)
    expect(branchExists(repository, sweptOut.branch)).toBe(true)
    await expect(worktrees.list('task-1')).resolves.toEqual([accepted, sweptOut])
  })

  it('removes swept-out worktrees and branches when keepLosers is false', { timeout: GIT_TEST_TIMEOUT_MS }, async () => {
    const { worktrees, repository } = await createHarness({ keepLosers: false })
    const accepted = await worktrees.createCandidate('task-1', 0)
    const sweptOut = await worktrees.createCandidate('task-1', 1)
    await worktrees.select('task-1', 0)

    const removed = await worktrees.prune('task-1')

    expect(removed).toEqual([sweptOut.branch])
    expect(existsSync(sweptOut.path)).toBe(false)
    expect(branchExists(repository, sweptOut.branch)).toBe(false)
    expect(existsSync(accepted.path)).toBe(true)
    expect(branchExists(repository, accepted.branch)).toBe(true)
    expect(git(repository, ['rev-parse', 'refs/heads/fleet/selected/task-1']))
      .toBe(git(repository, ['rev-parse', `refs/heads/${accepted.branch}`]))
    await expect(worktrees.list('task-1')).resolves.toEqual([accepted])
    await expect(worktrees.prune('task-1')).resolves.toEqual([])
  })

  it('refuses to prune when no candidate was selected', { timeout: GIT_TEST_TIMEOUT_MS }, async () => {
    const { worktrees } = await createHarness({ keepLosers: false })
    await worktrees.createCandidate('task-1', 0)

    await expect(worktrees.prune('task-1')).rejects.toThrow(WorktreeError)
    await expect(worktrees.select('task-1', 3)).rejects.toThrow(/holds no candidate 3/)
  })

  it('reads a candidate set recorded by an earlier service instance', { timeout: GIT_TEST_TIMEOUT_MS }, async () => {
    const first = await createHarness()
    const candidate = await first.worktrees.createCandidate('task-1', 0)
    await first.ctx.fiber.dispose()

    const second = await createHarness({
      repositoryRoot: first.repository,
      worktreeRoot: first.worktreeRoot,
    })

    await expect(second.worktrees.list('task-1')).resolves.toEqual([candidate])
  })

  it('records every outcome as a durable session event', { timeout: GIT_TEST_TIMEOUT_MS }, async () => {
    const { ctx, worktrees } = await createHarness({ keepLosers: false })
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('worktree-events'))

    const accepted = await worktrees.createCandidate('task-1', 0, { recordTo: session })
    const sweptOut = await worktrees.createCandidate('task-1', 1, { recordTo: session })
    await worktrees.select('task-1', 0, { recordTo: session })
    await worktrees.prune('task-1', { recordTo: session })

    expect(session.ownEvents().map(event => event.type)).toEqual([
      'worktree/candidate',
      'worktree/candidate',
      'worktree/select',
      'worktree/prune',
    ])
    expect(session.ownEvents()[0]?.data).toEqual({ ...accepted })
    expect(session.ownEvents()[2]?.data).toEqual({
      taskId: 'task-1',
      index: 0,
      branch: accepted.branch,
      commit: git(accepted.path, ['rev-parse', 'HEAD']),
      selectedBranch: 'fleet/selected/task-1',
    })
    expect(session.ownEvents()[3]?.data).toEqual({ taskId: 'task-1', removedBranches: [sweptOut.branch] })
  })

  it('removes the ctx.worktrees registration when the plugin is disposed', { timeout: GIT_TEST_TIMEOUT_MS }, async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const root = await mkdtemp(join(tmpdir(), 'dsh-worktree-'))
    temporary.push(root)
    const repository = createRepository(root)
    await ctx.plugin(LocalSubprocess)
    const fiber: Fiber = await ctx.plugin(FleetWorktrees, {
      repositoryRoot: repository,
      worktreeRoot: join(root, 'worktrees'),
      maxCandidates: 1,
    })

    expect(ctx.get('worktrees')).toBeInstanceOf(FleetWorktrees)
    await fiber.dispose()
    expect(ctx.get('worktrees')).toBeUndefined()
  })

  it('refuses a task id or index that cannot name a worktree', async () => {
    const { worktrees } = await createHarness()

    await expect(worktrees.createCandidate('../escape', 0)).rejects.toThrow(/taskId must match/)
    await expect(worktrees.createCandidate('', 0)).rejects.toThrow(TypeError)
    await expect(worktrees.createCandidate('task/1', 0)).rejects.toThrow(TypeError)
    await expect(worktrees.createCandidate('task-1', -1)).rejects.toThrow(/non-negative integer/)
    await expect(worktrees.createCandidate('task-1', 1.5)).rejects.toThrow(/non-negative integer/)
    await expect(worktrees.list('task 1')).rejects.toThrow(TypeError)
    await expect(worktrees.select('task-1', -1)).rejects.toThrow(TypeError)
  })

  it('fails load when the repository root is not a git working tree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-worktree-'))
    temporary.push(root)
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LocalSubprocess)

    await expect(ctx.plugin(FleetWorktrees, {
      repositoryRoot: root,
      worktreeRoot: join(root, 'worktrees'),
      maxCandidates: 1,
    })).rejects.toThrow(WorktreeError)
  })
})

describe('worktree configuration', () => {
  it('applies the documented defaults and validates every bound at load', () => {
    const resolved = resolveConfig({ repositoryRoot: '/repository', maxCandidates: 3 })

    expect(resolved).toEqual({
      repositoryRoot: '/repository',
      worktreeRoot: '/repository/.dsh-fleet/worktrees',
      branchPrefix: 'fleet/candidate',
      keepLosers: true,
      maxCandidates: 3,
      gitBin: 'git',
      graceMs: 2000,
    })
    expect(() => resolveConfig({ maxCandidates: 0 })).toThrow(/maxCandidates/)
    expect(() => resolveConfig({ maxCandidates: 1.5 })).toThrow(/maxCandidates/)
    expect(() => resolveConfig({ maxCandidates: 2, repositoryRoot: 'relative' })).toThrow(/absolute/)
    expect(() => resolveConfig({ maxCandidates: 2, worktreeRoot: 'relative' })).toThrow(/absolute/)
    expect(() => resolveConfig({ maxCandidates: 2, branchPrefix: 'fleet/../escape' })).toThrow(/branchPrefix/)
    expect(() => resolveConfig({ maxCandidates: 2, branchPrefix: 'fleet/' })).toThrow(/branchPrefix/)
    expect(() => resolveConfig({ maxCandidates: 2, graceMs: 0 })).toThrow(/graceMs/)
  })

  it('keeps a candidate branch distinguishable from the selected branch', () => {
    expect(candidateBranch('fleet/candidate', 'task-1', 2)).toBe('fleet/candidate/task-1/c2')
    expect(selectedBranch('fleet/candidate', 'task-1')).toBe('fleet/selected/task-1')
    expect(selectedBranch('fleet', 'task-1')).toBe('selected/task-1')
  })
})
