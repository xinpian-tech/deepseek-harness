/**
 * `ctx.worktrees` — worktree isolation for candidate evaluation (§11 item 8,
 * §12). N candidates for one task are N git worktrees on N branches, so no two
 * candidates ever share a working tree.
 *
 * The service owns three things the rest of the fleet must not re-implement:
 * the branch naming that tells a candidate apart from the accepted commit, the
 * durable record of which candidate was selected, and the keep-or-prune rule
 * for swept-out candidates. A swept-out candidate's commit and branch are
 * evaluation evidence and reproduction material, so `keepLosers` (default
 * true) keeps them and `prune` becomes a no-op (§5.5).
 *
 * The durable state lives with the worktrees under `worktreeRoot`, so a later
 * process reads back the candidate set of a task instead of trusting the
 * memory of the process that created it; the session log additionally records
 * every outcome for replay.
 *
 * @module @dsh-fleet/worktree
 */

import { isAbsolute, join, resolve as resolvePath } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  GitCommandError,
  parseWorktreeList,
  requireGit,
  runGit,
} from './git.ts'
import type { GitResult, WorktreeRegistration } from './git.ts'
import {
  STATE_FILE,
  STATE_VERSION,
  candidateDirectory,
  readTaskState,
  taskDirectory,
  writeTaskState,
} from './store.ts'
import type { TaskSelection, TaskState } from './store.ts'
import type { Worktree, WorktreeRecordOptions } from './types.ts'

export type * from './types.ts'
export { GitCommandError } from './git.ts'
export { WorktreeStateError } from './store.ts'

/** Configuration of worktree isolation. */
export interface Config {
  /**
   * Absolute path of the repository candidates are worktrees of. Omission uses
   * the harness process's working directory, which is the session's workspace
   * when the harness was launched there.
   */
  repositoryRoot?: string
  /**
   * Absolute root holding each task's candidate worktrees; default
   * `<repositoryRoot>/.dsh-fleet/worktrees`.
   */
  worktreeRoot?: string
  /** Branch namespace candidates are created under (default `fleet/candidate`). */
  branchPrefix?: string
  /**
   * Whether a swept-out candidate's worktree and branch are kept (default
   * true). §5.5 keeps them as evaluation evidence and reproduction material,
   * and only an explicit `false` lets `prune` remove them.
   */
  keepLosers?: boolean
  /**
   * Ceiling on live candidates per task. The main agent chooses N per task, so
   * the deployment states the bound it is willing to pay for rather than
   * inheriting one; exceeding it refuses instead of creating another worktree.
   */
  maxCandidates?: number
  /** git executable (default `git`). */
  gitBin?: string
  /** Termination grace for git processes (default 2000 ms). */
  graceMs?: number
}

/** The configuration after schemastery applied its defaults. */
export interface ResolvedConfig {
  readonly repositoryRoot: string
  readonly worktreeRoot: string
  readonly branchPrefix: string
  readonly keepLosers: boolean
  readonly maxCandidates: number
  readonly gitBin: string
  readonly graceMs: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    worktrees: FleetWorktrees
  }
}

/** Raised when a worktree request is refused before or instead of a git command. */
export class WorktreeError extends Error {
  /**
   * @param message - operator-facing description of the refusal.
   * @param taskId - task the refusal belongs to; omitted when the fault predates any task.
   */
  constructor(
    message: string,
    readonly taskId?: string,
  ) {
    super(message)
    this.name = 'WorktreeError'
  }
}

/** Task ids reach both a directory name and a branch name without quoting. */
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

/** Branch prefixes git accepts without normalization. */
const BRANCH_PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/

/**
 * The branch one candidate's commits live on.
 * @param prefix - configured branch prefix.
 * @param taskId - validated task id.
 * @param index - non-negative candidate index.
 * @returns the candidate's branch name, stable for the candidate's lifetime.
 */
export function candidateBranch(prefix: string, taskId: string, index: number): string {
  return `${prefix}/${taskId}/c${index}`
}

/**
 * The branch a task's accepted commit is published under.
 *
 * The prefix's last segment becomes `selected` (`fleet/candidate` →
 * `fleet/selected`), so a branch name alone tells a swept-out candidate from
 * the selected commit (§5.5). The accepted candidate keeps its own candidate
 * branch as well; this branch is the one that names the decision.
 *
 * @param prefix - configured branch prefix.
 * @param taskId - validated task id.
 * @returns the branch name publishing the accepted commit.
 */
export function selectedBranch(prefix: string, taskId: string): string {
  const cut = prefix.lastIndexOf('/')
  const namespace = cut === -1 ? 'selected' : `${prefix.slice(0, cut)}/selected`
  return `${namespace}/${taskId}`
}

/** Worktree isolation service. */
export class FleetWorktrees extends Service {
  static inject = ['subprocess']

  /**
   * Config schema; every field has a deployment-reachable default or an
   * explicit requirement. A class plugin declares the schema here, because the
   * Loader resolves a class plugin's configuration through this static slot.
   */
  static Config: z<Config, ResolvedConfig> = z.object({
    repositoryRoot: z.string(),
    worktreeRoot: z.string(),
    branchPrefix: z.string().default('fleet/candidate'),
    keepLosers: z.boolean().default(true),
    maxCandidates: z.natural().min(1).required(),
    gitBin: z.string().default('git'),
    graceMs: z.natural().min(1).default(2000),
  })

  private readonly config: ResolvedConfig
  private root: string
  private tail: Promise<unknown> = Promise.resolve()

  /**
   * @param ctx - owning context; `subprocess` must be available.
   * @param config - plugin configuration, validated here so a misconfigured
   * deployment fails at load rather than at the first candidate.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'worktrees')
    this.config = resolveConfig(config)
    this.root = this.config.repositoryRoot
  }

  /**
   * Verify the configured root is a git working tree and adopt git's canonical
   * top level, so every later command runs in the repository rather than in a
   * subdirectory of it.
   * @throws {WorktreeError} when the root is not inside a git working tree.
   */
  protected async [Service.init](): Promise<void> {
    const result = await this.git(['rev-parse', '--show-toplevel'])
    if (result.code !== 0) {
      throw new WorktreeError(
        `repositoryRoot ${this.config.repositoryRoot} is not a git working tree: ${result.stderr.trim()}`,
      )
    }
    this.root = result.stdout.trim()
  }

  /** The canonical repository root every candidate is a worktree of. */
  get repositoryRoot(): string {
    return this.root
  }

  /** The absolute root under which each task's candidate worktrees live. */
  get worktreeRoot(): string {
    return this.config.worktreeRoot
  }

  /**
   * Create or reuse one candidate's worktree.
   *
   * Reuse is per `(taskId, index)`: a recorded worktree that git still reports
   * on its recorded branch is returned unchanged, so a retry never discards a
   * worker's checkout or commits. A recorded worktree git reports on another
   * branch refuses instead of repointing a checkout that is not this
   * candidate's, and a recorded worktree whose directory is gone is re-added on
   * its recorded branch so already-made commits stay reachable.
   *
   * @param taskId - task the candidate belongs to; a safe path and branch component.
   * @param index - candidate index within the task; a non-negative integer.
   * @param options - optional session receiving the durable `worktree/candidate` record.
   * @returns the candidate's worktree, durable before it is returned.
   * @throws {TypeError} when the task id or index cannot name a worktree.
   * @throws {WorktreeError} when the task already holds `maxCandidates` candidates, or the recorded worktree drifted.
   * @throws {GitCommandError} when a git command fails.
   */
  async createCandidate(taskId: string, index: number, options: WorktreeRecordOptions = {}): Promise<Worktree> {
    assertTaskId(taskId)
    assertIndex(index)
    const worktree = await this.exclusive(() => this.openCandidate(taskId, index))
    options.recordTo?.append('worktree/candidate', { ...worktree })
    return worktree
  }

  /**
   * The candidates recorded for one task.
   *
   * The answer comes from the durable state file, never from an in-memory map,
   * so a process that did not create the candidates still reports them.
   *
   * @param taskId - task to list candidates of.
   * @returns the live candidates ordered by index; empty for a task with none.
   * @throws {TypeError} when the task id cannot name a worktree.
   * @throws {WorktreeStateError} when the task's durable state is unreadable.
   */
  async list(taskId: string): Promise<readonly Worktree[]> {
    assertTaskId(taskId)
    const state = await this.readState(taskId)
    return state?.candidates ?? []
  }

  /**
   * Record which candidate the main agent accepted.
   *
   * The accepted candidate's commit is published on the task's selected branch;
   * no other candidate's worktree or branch is touched, so selection keeps the
   * swept-out candidates either way `keepLosers` is configured.
   *
   * @param taskId - task the candidate belongs to.
   * @param index - index of the accepted candidate.
   * @param options - optional session receiving the durable `worktree/select` record.
   * @throws {TypeError} when the task id or index cannot name a worktree.
   * @throws {WorktreeError} when the task holds no such candidate.
   * @throws {GitCommandError} when a git command fails.
   */
  async select(taskId: string, index: number, options: WorktreeRecordOptions = {}): Promise<void> {
    assertTaskId(taskId)
    assertIndex(index)
    const accepted = await this.exclusive(() => this.acceptCandidate(taskId, index))
    options.recordTo?.append('worktree/select', {
      taskId,
      index,
      branch: accepted.candidate.branch,
      commit: accepted.selection.commit,
      selectedBranch: accepted.selection.branch,
    })
  }

  /**
   * Remove the worktrees and branches of the candidates that were not selected.
   *
   * This is a no-op returning an empty list while `keepLosers` is true, which
   * is the default: a swept-out candidate's commit and branch are evaluation
   * evidence and reproduction material (§5.5). With `keepLosers` false it
   * refuses a task that has no selection, because that would destroy every
   * candidate, and it removes each swept-out worktree before deleting its
   * branch so git never sees the branch as checked out.
   *
   * @param taskId - task to prune.
   * @param options - optional session receiving the durable `worktree/prune` record.
   * @returns the branch names removed, in candidate order.
   * @throws {TypeError} when the task id cannot name a worktree.
   * @throws {WorktreeError} when pruning is enabled and the task has no selected candidate.
   * @throws {GitCommandError} when a git command fails.
   */
  async prune(taskId: string, options: WorktreeRecordOptions = {}): Promise<string[]> {
    assertTaskId(taskId)
    const removedBranches = this.config.keepLosers
      ? []
      : await this.exclusive(() => this.removeSweptOut(taskId))
    options.recordTo?.append('worktree/prune', { taskId, removedBranches })
    return removedBranches
  }

  /**
   * Resolve one candidate against git and the durable state, creating it when
   * the record does not exist yet.
   * @param taskId - validated task id.
   * @param index - validated candidate index.
   * @returns the candidate's worktree.
   */
  private async openCandidate(taskId: string, index: number): Promise<Worktree> {
    const state = await this.readState(taskId)
    const recorded = state?.candidates.find(candidate => candidate.index === index)
    if (recorded !== undefined) {
      const registration = await this.registration(recorded.path)
      if (registration === undefined) {
        // The checkout is gone but the record is not: drop any stale
        // registration of its path and re-add the recorded branch, so commits
        // the candidate already made stay reachable.
        return await this.addWorktree(taskId, index, recorded.branch, recorded.baseCommit, recorded.createdAt, state, true)
      }
      if (registration.branch !== recorded.branch) {
        const found = registration.branch ?? 'a detached HEAD'
        throw new WorktreeError(
          `worktree ${recorded.path} is on ${found}, not on its recorded branch ${recorded.branch}`,
          taskId,
        )
      }
      return recorded
    }
    const candidates = state?.candidates ?? []
    if (candidates.length >= this.config.maxCandidates) {
      throw new WorktreeError(
        `task ${taskId} already holds ${candidates.length} candidates; maxCandidates is ${this.config.maxCandidates}`,
        taskId,
      )
    }
    const branch = candidateBranch(this.config.branchPrefix, taskId, index)
    const base = (await this.require(['rev-parse', 'HEAD'])).stdout.trim()
    return await this.addWorktree(taskId, index, branch, base, Date.now(), state, false)
  }

  /**
   * Add one worktree on an existing or fresh branch and record it durably.
   * @param taskId - validated task id.
   * @param index - validated candidate index.
   * @param branch - branch the candidate is checked out on.
   * @param baseCommit - commit recorded as the candidate's base.
   * @param createdAt - creation time recorded for the candidate.
   * @param state - the task's state before this candidate, when it had one.
   * @param dropStaleRegistration - whether to prune a registration whose directory is gone before adding.
   * @returns the recorded candidate.
   */
  private async addWorktree(
    taskId: string,
    index: number,
    branch: string,
    baseCommit: string,
    createdAt: number,
    state: TaskState | undefined,
    dropStaleRegistration: boolean,
  ): Promise<Worktree> {
    const path = this.candidatePath(taskId, index)
    if (dropStaleRegistration) await this.require(['worktree', 'prune'])
    const attach = await this.branchExists(branch) ? ['worktree', 'add', path, branch] : ['worktree', 'add', '-b', branch, path, baseCommit]
    await this.require(attach)
    const worktree: Worktree = { taskId, index, path, branch, baseCommit, createdAt }
    const kept = (state?.candidates ?? []).filter(candidate => candidate.index !== index)
    await this.writeState(taskId, {
      version: STATE_VERSION,
      taskId,
      branchPrefix: this.config.branchPrefix,
      candidates: [...kept, worktree].sort((left, right) => left.index - right.index),
      selection: state?.selection ?? null,
    })
    return worktree
  }

  /**
   * Publish the accepted candidate's commit on the task's selected branch and
   * record the selection.
   * @param taskId - validated task id.
   * @param index - validated candidate index.
   * @returns the accepted candidate and the recorded selection.
   */
  private async acceptCandidate(taskId: string, index: number): Promise<{ candidate: Worktree; selection: TaskSelection }> {
    const state = await this.readState(taskId)
    const candidate = state?.candidates.find(entry => entry.index === index)
    if (state === undefined || candidate === undefined) {
      throw new WorktreeError(`task ${taskId} holds no candidate ${index}`, taskId)
    }
    const commit = (await this.require(['rev-parse', '--verify', `refs/heads/${candidate.branch}`])).stdout.trim()
    const branch = selectedBranch(this.config.branchPrefix, taskId)
    await this.require(['update-ref', `refs/heads/${branch}`, commit])
    const selection: TaskSelection = { index, branch, commit }
    await this.writeState(taskId, { ...state, selection })
    return { candidate, selection }
  }

  /**
   * Remove every candidate's worktree and branch except the accepted one.
   * @param taskId - validated task id.
   * @returns the branch names removed.
   */
  private async removeSweptOut(taskId: string): Promise<string[]> {
    const state = await this.readState(taskId)
    if (state === undefined || state.selection === null) {
      throw new WorktreeError(
        `task ${taskId} has no selected candidate; pruning would remove every candidate`,
        taskId,
      )
    }
    const selection = state.selection
    const registrations = parseWorktreeList((await this.require(['worktree', 'list', '--porcelain'])).stdout)
    const kept: Worktree[] = []
    const removed: string[] = []
    for (const candidate of state.candidates) {
      if (candidate.index === selection.index) {
        kept.push(candidate)
        continue
      }
      if (registrations.some(entry => entry.path === candidate.path && !entry.prunable)) {
        await this.require(['worktree', 'remove', '--force', candidate.path])
      }
      if (await this.branchExists(candidate.branch)) {
        await this.require(['branch', '-D', candidate.branch])
        removed.push(candidate.branch)
      }
    }
    await this.writeState(taskId, { ...state, candidates: kept })
    return removed
  }

  /**
   * Read one task's durable state and refuse a branch prefix that no longer
   * matches the configuration, which would otherwise silently address
   * different branches than the recorded candidates.
   * @param taskId - validated task id.
   * @returns the recorded state, or undefined for a task with no candidates yet.
   */
  private async readState(taskId: string): Promise<TaskState | undefined> {
    const state = await readTaskState(this.statePath(taskId))
    if (state !== undefined && state.branchPrefix !== this.config.branchPrefix) {
      throw new WorktreeError(
        `task ${taskId} was recorded under branch prefix ${state.branchPrefix}; branchPrefix is ${this.config.branchPrefix}`,
        taskId,
      )
    }
    return state
  }

  /**
   * Replace one task's durable state. Callers hold the write slot, so the
   * candidate list a write replaces is the one they read.
   * @param taskId - validated task id.
   * @param state - the complete new state.
   */
  private async writeState(taskId: string, state: TaskState): Promise<void> {
    await writeTaskState(this.statePath(taskId), state)
  }

  /**
   * The live git registration of one worktree path.
   * @param path - absolute worktree path.
   * @returns the registration, or undefined when git knows no live worktree there.
   */
  private async registration(path: string): Promise<WorktreeRegistration | undefined> {
    const listing = await this.require(['worktree', 'list', '--porcelain'])
    return parseWorktreeList(listing.stdout).find(entry => entry.path === path && !entry.prunable)
  }

  /**
   * Whether a local branch exists.
   * @param branch - branch name without the `refs/heads/` prefix.
   * @returns true when the branch exists.
   * @throws {GitCommandError} when git fails for a reason other than a missing ref.
   */
  private async branchExists(branch: string): Promise<boolean> {
    const argv = ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]
    const result = await this.git(argv)
    if (result.code === 0) return true
    // `--quiet` makes a missing ref exit 1 with no output; anything else is a fault.
    if (result.code === 1) return false
    throw new GitCommandError(argv, result.code, result.stderr)
  }

  /**
   * Run one git subcommand that must succeed.
   * @param argv - arguments after the git executable.
   * @returns the successful invocation's captured output.
   */
  private require(argv: readonly string[]): Promise<GitResult> {
    return requireGit(this.ctx.subprocess, this.config.gitBin, argv, this.root, this.config.graceMs)
  }

  /**
   * Run one git subcommand whose non-zero exit the caller handles.
   * @param argv - arguments after the git executable.
   * @returns the exit code and both captured streams.
   */
  private git(argv: readonly string[]): Promise<GitResult> {
    return runGit(this.ctx.subprocess, this.config.gitBin, argv, this.root, this.config.graceMs)
  }

  /**
   * The absolute path of one candidate's worktree.
   * @param taskId - validated task id.
   * @param index - validated candidate index.
   * @returns the absolute worktree path.
   */
  private candidatePath(taskId: string, index: number): string {
    return join(taskDirectory(this.config.worktreeRoot, taskId), candidateDirectory(index))
  }

  /**
   * The absolute path of one task's durable state file.
   * @param taskId - validated task id.
   * @returns the absolute state file path.
   */
  private statePath(taskId: string): string {
    return join(taskDirectory(this.config.worktreeRoot, taskId), STATE_FILE)
  }

  /**
   * Serialize one read-modify-write of the durable state against this
   * service's other writers, so a candidate list is never written from a state
   * another call already replaced.
   * @param operation - the state exchange to run.
   * @returns the operation's result.
   */
  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(operation)
    this.tail = run.then(() => undefined, () => undefined)
    return run
  }
}

/**
 * Reject a task id that cannot name a worktree directory and branch.
 * @param taskId - candidate task id.
 * @throws {TypeError} when the id is empty or contains unsupported characters.
 */
function assertTaskId(taskId: string): void {
  if (!TASK_ID_PATTERN.test(taskId)) {
    throw new TypeError(`taskId must match ${TASK_ID_PATTERN.source}: ${JSON.stringify(taskId)}`)
  }
}

/**
 * Reject a candidate index that cannot name a worktree directory.
 * @param index - candidate index.
 * @throws {TypeError} when the index is not a non-negative safe integer.
 */
function assertIndex(index: number): void {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new TypeError(`candidate index must be a non-negative integer: ${String(index)}`)
  }
}

/**
 * Apply defaults and validate everything this service depends on.
 *
 * A misconfigured fleet must fail here — at load, once — rather than at the
 * first candidate, when the failure would look like a worker fault. The schema
 * supplies every default and rejects a `maxCandidates` or `graceMs` that is not
 * a positive integer; this function adds the checks a schema cannot express.
 *
 * @param config - authored plugin configuration.
 * @returns the validated configuration.
 * @throws {TypeError} when a path is relative or the branch prefix is unusable.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const resolved = FleetWorktrees.Config(config)
  const repositoryRoot = resolved.repositoryRoot
  if (repositoryRoot !== undefined && !isAbsolute(repositoryRoot)) {
    throw new TypeError('@dsh-fleet/worktree repositoryRoot must be an absolute path')
  }
  const worktreeRoot = resolved.worktreeRoot
  if (worktreeRoot !== undefined && !isAbsolute(worktreeRoot)) {
    throw new TypeError('@dsh-fleet/worktree worktreeRoot must be an absolute path')
  }
  const root = resolvePath(repositoryRoot ?? process.cwd())
  // An explicit root stays where the deployment put it; the default is derived
  // from the repository so one deployment never scatters worktrees.
  const branchPrefix = resolved.branchPrefix
  if (!BRANCH_PREFIX_PATTERN.test(branchPrefix) || branchPrefix.includes('..') || /[/.]$/.test(branchPrefix)) {
    throw new TypeError(`@dsh-fleet/worktree branchPrefix must be a usable branch namespace: ${JSON.stringify(branchPrefix)}`)
  }
  if (resolved.gitBin.trim().length === 0) {
    throw new TypeError('@dsh-fleet/worktree gitBin must be a non-empty executable name')
  }
  return {
    repositoryRoot: root,
    worktreeRoot: resolvePath(worktreeRoot ?? join(root, '.dsh-fleet', 'worktrees')),
    branchPrefix,
    keepLosers: resolved.keepLosers,
    maxCandidates: resolved.maxCandidates,
    gitBin: resolved.gitBin,
    graceMs: resolved.graceMs,
  }
}

export default FleetWorktrees
