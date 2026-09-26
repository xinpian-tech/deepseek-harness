/**
 * `ctx.gitCheckpoint` — two-phase git archival (§7.1, §11 item 6).
 *
 * Phase 1 runs inside the turn. `agent/turn-stopping` stages the workspace and
 * commits it locally, once per turn, with no network access anywhere on that
 * path; a turn that changed nothing creates no commit, so history records work
 * rather than wall-clock time. The commit is recorded durably as a
 * `git/checkpoint` session event naming the session and turn that produced it.
 *
 * Phase 2 is the durable push queue. `enqueuePush` only appends a line and
 * returns; `drain` retries every queued ref with exponential backoff bounded by
 * `backoffBaseMs`, `backoffMaxMs`, and `maxAttempts`; `finalPush` is the one
 * path that blocks on the network, because the parent layer has to be able to
 * fetch the final commit of a task before it continues (§7.1).
 *
 * No listener here ever pushes. Putting the network round-trip inside the turn
 * loop would let one unreachable remote freeze every machine of a hundred-
 * machine fleet, so the failure is confined to the final push. A push that
 * fails is reported through the log and stays queued: the turn already
 * committed locally, and a remote fault must never surface as a turn failure.
 *
 * The queue file is the one `infra/scripts/push-queue.sh` maintains —
 * `<repository>\t<remote>\t<ref>`, one entry per line — so the shell tool and
 * this service read and drain each other's work instead of keeping two queues.
 *
 * @module @dsh-fleet/git-checkpoint
 */

import { statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { Session } from '@deepseek-ai/dsh-session'
import { GitCommandError, optionalGit, requireGit, runGit } from './git.ts'
import { enqueueEntry, readQueue, removeEntries } from './queue.ts'
import type { CheckpointCommit, PushDrainReport, PushQueueEntry } from './types.ts'

export type * from './types.ts'
export { GitCommandError } from './git.ts'
export { PushQueueError } from './queue.ts'

/** Commit message used when the deployment states none; it names both facts a checkpoint must identify. */
export const DEFAULT_COMMIT_MESSAGE_TEMPLATE = 'dsh checkpoint: session {session} turn {turn}'

/**
 * Configuration of two-phase git archival.
 *
 * Every field is either a deployment-reachable choice or has one documented
 * resolution order; none of them is a hidden default inside the operation.
 */
export interface Config {
  /**
   * Absolute path of the repository every checkpoint commits. Omission uses
   * the stopping turn's own workspace (`session.header.cwd`), which is the
   * repository the turn worked in.
   */
  repositoryRoot?: string
  /** Remote the asynchronous push targets (default `origin`). */
  remote?: string
  /**
   * Commit message template (default
   * {@link DEFAULT_COMMIT_MESSAGE_TEMPLATE}). `{session}`, `{turn}`, and
   * `{branch}` are replaced; the first two are required, so no checkpoint can
   * be anonymous.
   */
  commitMessageTemplate?: string
  /** First retry delay in milliseconds (default 2000), doubling per attempt. */
  backoffBaseMs?: number
  /** Ceiling on one retry delay in milliseconds (default 300000). */
  backoffMaxMs?: number
  /** Push attempts per ref before it stays queued (default 0, which retries forever). */
  maxAttempts?: number
  /**
   * Absolute path of the durable push queue. Omission uses
   * `<DSH_HOME>/push-queue/pending.tsv`, the file
   * `infra/scripts/push-queue.sh` reads when `DSH_HOME` is set.
   */
  queueFile?: string
  /**
   * Whether `agent/turn-stopping` checkpoints a turn (default true). A disabled
   * plugin registers no listener; the explicit push methods stay available,
   * because a caller that invokes them asked for that work by name.
   */
  enabled?: boolean
}

/** Configuration after schema defaults have been applied. */
export interface ResolvedConfig {
  /** Absolute repository, absent when each turn's own workspace decides it. */
  readonly repositoryRoot?: string
  /** Remote the asynchronous push targets. */
  readonly remote: string
  /** Commit message template. */
  readonly commitMessageTemplate: string
  /** First retry delay. */
  readonly backoffBaseMs: number
  /** Ceiling on one retry delay. */
  readonly backoffMaxMs: number
  /** Push attempts per ref before it stays queued; `0` retries forever. */
  readonly maxAttempts: number
  /** Absolute path of the durable push queue. */
  readonly queueFile: string
  /** Whether the turn hook is registered. */
  readonly enabled: boolean
}

/** The values a commit message template is rendered from. */
export interface CommitMessageFields {
  /** Session the checkpointed turn belongs to. */
  readonly session: string
  /** Turn the commit closes. */
  readonly turn: number
  /** Branch the commit advances, or `detached` on a detached HEAD. */
  readonly branch: string
}

/**
 * Render one commit message from the configured template.
 * @param template - template carrying `{session}`, `{turn}`, and `{branch}` placeholders.
 * @param fields - the values those placeholders are replaced with.
 * @returns the message, byte-identical every time the same turn is rendered.
 */
export function renderCommitMessage(template: string, fields: CommitMessageFields): string {
  return template
    .replaceAll('{session}', fields.session)
    .replaceAll('{turn}', String(fields.turn))
    .replaceAll('{branch}', fields.branch)
}

/**
 * Apply the schema defaults and validate everything this service depends on.
 *
 * A misconfigured fleet must fail here — at load, once — rather than at the
 * first stopping turn, where the failure would look like a worker fault.
 *
 * @param config - authored plugin configuration.
 * @returns the validated configuration with every default applied.
 * @throws {TypeError} when a path is relative or missing, a remote name is
 * empty, a delay or attempt bound is not a positive integer, or a commit
 * message template omits the session or the turn.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const resolved = FleetGitCheckpoint.Config(config)
  const { repositoryRoot } = resolved
  if (repositoryRoot !== undefined) {
    if (!isAbsolute(repositoryRoot)) {
      throw new TypeError(`@dsh-fleet/git-checkpoint repositoryRoot must be an absolute path: ${repositoryRoot}`)
    }
    if (!isDirectory(repositoryRoot)) {
      throw new TypeError(`@dsh-fleet/git-checkpoint repositoryRoot is not a directory: ${repositoryRoot}`)
    }
  }
  if (resolved.remote.trim() === '') {
    throw new TypeError('@dsh-fleet/git-checkpoint remote must be a non-empty remote name')
  }
  for (const placeholder of ['{session}', '{turn}']) {
    if (!resolved.commitMessageTemplate.includes(placeholder)) {
      throw new TypeError(
        `@dsh-fleet/git-checkpoint commitMessageTemplate must name the ${placeholder} it commits`,
      )
    }
  }
  const backoffBaseMs = positiveInteger(resolved.backoffBaseMs, 'backoffBaseMs')
  const backoffMaxMs = positiveInteger(resolved.backoffMaxMs, 'backoffMaxMs')
  if (backoffMaxMs < backoffBaseMs) {
    throw new TypeError(
      `@dsh-fleet/git-checkpoint backoffMaxMs (${backoffMaxMs}) must be at least backoffBaseMs (${backoffBaseMs})`,
    )
  }
  const attempts = resolved.maxAttempts
  if (!Number.isSafeInteger(attempts) || attempts < 0) {
    throw new TypeError(`@dsh-fleet/git-checkpoint maxAttempts must be a non-negative integer: ${String(attempts)}`)
  }
  const queueFile = resolved.queueFile ?? join(dshHomePath('push-queue'), 'pending.tsv')
  if (!isAbsolute(queueFile)) {
    throw new TypeError(`@dsh-fleet/git-checkpoint queueFile must be an absolute path: ${queueFile}`)
  }
  return {
    ...repositoryRoot === undefined ? {} : { repositoryRoot },
    remote: resolved.remote,
    commitMessageTemplate: resolved.commitMessageTemplate,
    backoffBaseMs,
    backoffMaxMs,
    maxAttempts: attempts,
    queueFile,
    enabled: resolved.enabled,
  }
}

/** A ref name this queue accepts: a full ref whose segments cannot escape the namespace. */
const REF_PATTERN = /^refs\/[A-Za-z0-9._/-]+$/

/** How far one `(session, turn)` checkpoint got in this process. */
type TurnState = 'running' | 'done'

declare module '@deepseek-ai/cordis' {
  interface Context {
    gitCheckpoint: FleetGitCheckpoint
  }
}

/** Raised when the final push could not put the ref on the remote. */
export class GitPushError extends Error {
  /**
   * @param entry - the queued push that did not reach the remote.
   * @param attempts - attempts made before giving up.
   * @param detail - what the last attempt reported.
   */
  constructor(
    readonly entry: PushQueueEntry,
    readonly attempts: number,
    detail: string,
  ) {
    super(
      `push of ${entry.ref} to ${entry.remote} in ${entry.repository} failed after ${attempts} attempt(s): ${detail}`,
    )
    this.name = 'GitPushError'
  }
}

/** Two-phase git archival: the turn's local commit, and the durable push queue behind it. */
export class FleetGitCheckpoint extends Service {
  static inject = ['subprocess']

  /** Authored configuration schema; the Loader validates every mounted row against it. */
  static Config: z<Config, ResolvedConfig> = z.object({
    repositoryRoot: z.string(),
    remote: z.string().default('origin'),
    commitMessageTemplate: z.string().default(DEFAULT_COMMIT_MESSAGE_TEMPLATE),
    backoffBaseMs: z.natural().min(1).default(2000),
    backoffMaxMs: z.natural().min(1).default(300_000),
    maxAttempts: z.natural().default(0),
    queueFile: z.string(),
    enabled: z.boolean().default(true),
  })

  private readonly config: ResolvedConfig
  private readonly lifetime = new AbortController()
  private readonly turns = new Map<string, Map<number, TurnState>>()

  /**
   * @param ctx - owning context; `subprocess` must be available.
   * @param config - authored plugin configuration, validated here so a
   * misconfigured deployment fails at load rather than at the first stopping turn.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'gitCheckpoint')
    this.config = resolveConfig(config)
    // Disposal stops in-flight git work; it is the only teardown this service
    // owns beyond the listener and the service registration themselves.
    ctx.effect(() => () => { this.lifetime.abort() })
    if (this.config.enabled) {
      ctx.on('agent/turn-stopping', async ({ agent, turn }) => {
        try {
          await this.checkpointTurn(agent.session, turn)
        } catch (error) {
          // A turn is never failed by archival: phase 1 committed what it could
          // and phase 2 retries from the queue, so the failure is reported and
          // the turn continues.
          this.ctx.logger.warn(
            `git-checkpoint: session ${agent.session.id} turn ${turn} was not checkpointed: ${describe(error)}`,
          )
        }
      })
    }
    ctx.on('session/disposed', (session) => {
      this.turns.delete(String(session.id))
    })
  }

  /**
   * Confirm the configured repository before the first turn depends on it.
   * @throws {TypeError} when the configured root is not inside a git working tree.
   */
  protected async [Service.init](): Promise<void> {
    const root = this.config.repositoryRoot
    if (root === undefined) return
    const inside = await runGit(this.ctx.subprocess, ['rev-parse', '--show-toplevel'], root, this.lifetime.signal)
    if (inside.code !== 0) {
      throw new TypeError(
        `@dsh-fleet/git-checkpoint repositoryRoot ${root} is not a git working tree: ${inside.stderr.trim()}`,
      )
    }
  }

  /** The absolute path of the push queue this service reads and writes. */
  get queueFile(): string {
    return this.config.queueFile
  }

  /** The remote every queued ref is pushed to. */
  get remote(): string {
    return this.config.remote
  }

  /**
   * Queue one ref for the asynchronous push.
   *
   * Durable before it returns and never blocks on the network: the entry is
   * written and synced, and only a later {@link drain} or {@link finalPush}
   * contacts the remote.
   *
   * @param ref - full ref name, e.g. `refs/heads/main`.
   * @param repository - absolute repository owning the ref; omission uses the
   * configured `repositoryRoot`.
   * @returns the durable queue entry.
   * @throws {TypeError} when no repository resolves or the ref is not a full ref name.
   */
  async enqueuePush(ref: string, repository?: string): Promise<PushQueueEntry> {
    const entry: PushQueueEntry = {
      repository: this.requireRepository(repository),
      remote: this.config.remote,
      ref: assertRefName(ref),
    }
    await enqueueEntry(this.config.queueFile, entry)
    return entry
  }

  /**
   * Retry every queued ref until it is pushed or its attempt budget runs out.
   *
   * Entries are dropped from the durable queue only after their push reached
   * the remote, so a drain interrupted by a crash, a disposal, or an exhausted
   * budget loses nothing. The report names both outcomes; a failed entry is
   * never an error here, because phase 2 is allowed to keep trying.
   *
   * @param signal - cancellation; omission uses the plugin's lifetime, so
   * disposal stops an in-flight drain.
   * @returns the pushed entries and the entries still queued.
   */
  async drain(signal?: AbortSignal): Promise<PushDrainReport> {
    const cancellation = signal ?? this.lifetime.signal
    const queued = await readQueue(this.config.queueFile)
    const pushed: PushQueueEntry[] = []
    const failed: PushQueueEntry[] = []
    for (const entry of queued) {
      if (await this.pushWithBackoff(entry, cancellation)) pushed.push(entry)
      else failed.push(entry)
    }
    if (pushed.length > 0) await removeEntries(this.config.queueFile, pushed)
    return { pushed, failed }
  }

  /**
   * Push one ref and block until the remote has it.
   *
   * This is the only network-blocking path in the package, and it exists
   * because the parent layer must be able to fetch the final commit of a task
   * before it continues (§7.1). With `maxAttempts` at its default `0` it
   * retries until the push succeeds; a finite budget that runs out throws,
   * rather than letting the parent continue against a ref the remote lacks.
   * The rest of the queue stays phase 2's work — run {@link drain} to push it.
   *
   * @param ref - full ref name that exists locally.
   * @param repository - absolute repository owning the ref; omission uses the
   * configured `repositoryRoot`.
   * @returns the entry the remote now has.
   * @throws {GitPushError} when a finite attempt budget ran out, or the plugin
   * was disposed while the push was in flight.
   */
  async finalPush(ref: string, repository?: string): Promise<PushQueueEntry> {
    const entry: PushQueueEntry = {
      repository: this.requireRepository(repository),
      remote: this.config.remote,
      ref: assertRefName(ref),
    }
    if (!(await this.pushWithBackoff(entry, this.lifetime.signal))) {
      throw new GitPushError(entry, Math.max(this.config.maxAttempts, 1), 'the remote did not accept the ref')
    }
    await removeEntries(this.config.queueFile, [entry])
    return entry
  }

  /**
   * Commit the workspace of one stopping turn, at most once per turn.
   *
   * @param session - session whose turn is stopping.
   * @param turn - turn that is about to close.
   * @throws {GitCommandError} when a local git command fails; the listener
   * reports it without failing the turn.
   */
  private async checkpointTurn(session: Session, turn: number): Promise<void> {
    const key = String(session.id)
    const seen = this.turns.get(key) ?? new Map<number, TurnState>()
    this.turns.set(key, seen)
    if (seen.has(turn)) return
    seen.set(turn, 'running')
    let checkpoint: CheckpointCommit | undefined
    try {
      checkpoint = await this.commitWorkspace(session, turn)
    } catch (error) {
      // A turn that could not be committed may be retried when its stopping
      // event fires again; a committed turn never is.
      seen.delete(turn)
      throw error
    }
    seen.set(turn, 'done')
    if (checkpoint === undefined) return
    session.append('git/checkpoint', {
      turn,
      commit: checkpoint.commit,
      repository: checkpoint.repository,
      ...checkpoint.branch === undefined ? {} : { branch: checkpoint.branch },
      ...checkpoint.ref === undefined ? {} : { ref: checkpoint.ref },
    })
    if (checkpoint.ref !== undefined) {
      try {
        await this.enqueuePush(checkpoint.ref, checkpoint.repository)
      } catch (error) {
        // Phase 1 is complete and recorded; a queue that cannot be written
        // leaves the commit unpushed rather than failing the turn.
        this.ctx.logger.warn(
          `git-checkpoint: ${checkpoint.commit} was committed but not queued: ${describe(error)}`,
        )
      }
    }
  }

  /**
   * Stage and commit one turn's workspace.
   *
   * @param session - session whose turn is stopping.
   * @param turn - turn that is about to close.
   * @returns the commit this turn produced, or undefined when the workspace
   * held no change (an unchanged turn never creates an empty commit).
   * @throws {GitCommandError} when a git command fails.
   */
  private async commitWorkspace(session: Session, turn: number): Promise<CheckpointCommit | undefined> {
    const repository = this.config.repositoryRoot ?? session.header.cwd
    if (repository === undefined) {
      this.ctx.logger.warn(
        `git-checkpoint: session ${session.id} has no workspace and no repositoryRoot is configured; nothing to commit`,
      )
      return undefined
    }
    const subprocess = this.ctx.subprocess
    const signal = this.lifetime.signal
    await requireGit(subprocess, ['add', '--all'], repository, signal)
    const staged = await runGit(subprocess, ['diff', '--cached', '--quiet'], repository, signal)
    // `--quiet` answers "are there staged changes?" through the exit code:
    // 0 means none, 1 means some, anything else is a real failure.
    if (staged.code === 0) return undefined
    if (staged.code !== 1) {
      throw new GitCommandError(repository, ['diff', '--cached', '--quiet'], staged.code, staged.stderr)
    }
    const branch = await optionalGit(subprocess, ['symbolic-ref', '--short', '--quiet', 'HEAD'], repository, signal)
    const message = renderCommitMessage(this.config.commitMessageTemplate, {
      session: String(session.id),
      turn,
      branch: branch ?? 'detached',
    })
    await requireGit(subprocess, ['commit', '--quiet', '--message', message], repository, signal)
    const commit = await requireGit(subprocess, ['rev-parse', 'HEAD'], repository, signal)
    return {
      commit,
      repository,
      ...branch === undefined ? {} : { branch, ref: `refs/heads/${branch}` },
    }
  }

  /**
   * Push one entry, retrying with exponential backoff bounded by the config.
   * @param entry - the queued push to attempt.
   * @param signal - cancellation checked before each retry delay.
   * @returns whether the remote accepted the ref.
   */
  private async pushWithBackoff(entry: PushQueueEntry, signal: AbortSignal): Promise<boolean> {
    let attempt = 1
    let backoffMs = this.config.backoffBaseMs
    for (;;) {
      const result = await runGit(
        this.ctx.subprocess,
        ['push', '--quiet', entry.remote, entry.ref],
        entry.repository,
        signal,
      )
      if (result.code === 0) return true
      const exhausted = this.config.maxAttempts > 0 && attempt >= this.config.maxAttempts
      if (exhausted || signal.aborted) {
        this.ctx.logger.warn(
          `git-checkpoint: ${entry.repository} could not push ${entry.ref} to ${entry.remote} after ${attempt} attempt(s): ${result.stderr.trim()}`,
        )
        return false
      }
      this.ctx.logger.warn(
        `git-checkpoint: pushing ${entry.ref} to ${entry.remote} failed (attempt ${attempt}); retrying in ${backoffMs} ms: ${result.stderr.trim()}`,
      )
      await delay(backoffMs, signal)
      attempt += 1
      backoffMs = Math.min(backoffMs * 2, this.config.backoffMaxMs)
    }
  }

  /**
   * Resolve the repository a queue entry belongs to.
   * @param repository - caller-supplied absolute path, if any.
   * @returns the absolute repository path.
   * @throws {TypeError} when no repository resolves, or the value is not absolute.
   */
  private requireRepository(repository?: string): string {
    const resolved = repository ?? this.config.repositoryRoot
    if (resolved === undefined) {
      throw new TypeError(
        '@dsh-fleet/git-checkpoint needs a repository for this ref: configure repositoryRoot or pass one to the call',
      )
    }
    if (!isAbsolute(resolved)) {
      throw new TypeError(`@dsh-fleet/git-checkpoint repository must be an absolute path: ${resolved}`)
    }
    return resolved
  }
}

/**
 * Validate one positive-integer tunable.
 * @param value - configured value.
 * @param field - field name, for the failure message.
 * @returns the value, unchanged.
 * @throws {TypeError} when the value is not a positive safe integer.
 */
function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`@dsh-fleet/git-checkpoint ${field} must be a positive integer: ${String(value)}`)
  }
  return value
}

/**
 * Reject a ref this queue cannot address.
 * @param ref - candidate full ref name.
 * @returns the ref, unchanged.
 * @throws {TypeError} when the ref is not a full, traversal-free ref name.
 */
function assertRefName(ref: string): string {
  if (!REF_PATTERN.test(ref) || ref.includes('..') || ref.includes('//') || ref.endsWith('/')) {
    throw new TypeError(`@dsh-fleet/git-checkpoint ref must be a full ref name: ${JSON.stringify(ref)}`)
  }
  return ref
}

/**
 * Whether a path names an existing directory.
 * @param path - absolute candidate path.
 * @returns true when the path exists and is a directory.
 */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    // An unreadable or absent path is not a repository this plugin can use.
    return false
  }
}

/**
 * Sleep for a bounded interval.
 * @param ms - milliseconds to wait.
 * @param signal - cancellation; settles the wait early.
 * @returns a promise settled after the delay or on abort.
 */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

/**
 * Describe a caught value for one log line.
 * @param error - the caught value.
 * @returns its message, or its string form when it is not an Error.
 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default FleetGitCheckpoint
