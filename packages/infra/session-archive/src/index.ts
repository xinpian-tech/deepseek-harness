/**
 * `ctx.sessionArchive` — the bypass session archiver (§7.2, §7.3, §11 item 7).
 *
 * Every stopping turn copies the session's durable JSONL into the archive
 * tree, commits it, and publishes the commit under
 * `refs/dsh/machines/<machine-id>/sessions/<session-id>`. Each machine owns its
 * own ref namespace, so two machines never write one ref and no push has to be
 * serialized across the fleet (§7.2).
 *
 * This is NOT a `SessionPersistence` backend and must never become one. JSONL
 * is dsh's only persistence provider, it sits on the hot path in front of every
 * model request, and its checkpoints are fail-closed; replacing or wrapping it
 * would put archival between the model and its own history. The archiver is a
 * bypass consumer instead: it reads the log the provider already persisted
 * through the persistence seam, and it never writes to that log, never fabricates
 * events, and never changes what a resume replays (§7.3).
 *
 * Grouping is reconstructed from content, not from the ref layout: a session
 * header carries `parentSession`, so `family(sessionId)` reads archived headers
 * and builds the parent/child tree even though the sessions of one family are
 * normally archived on different machines (§7.2).
 *
 * @module @dsh-fleet/session-archive
 */

import { statSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type {} from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import {
  ARCHIVE_SUFFIX,
  archiveFileName,
  archiveSegment,
  buildFamily,
  parseArchivedHeader,
  renderArchiveLog,
  SessionArchiveError,
} from './archive.ts'
import { gitOptional, type GitTarget } from './git.ts'
import { commitFile, listRefs, resolveRef, updateRef } from './plumbing.ts'
import type { ArchivedRef, ArchivedSession, SessionFamily } from './types.ts'

export type * from './types.ts'
export { ARCHIVE_SUFFIX, archiveFileName, archiveSegment, SessionArchiveError } from './archive.ts'
export { GitPlumbingError } from './git.ts'

/** Permission bits of one archived log: session history is the operator's to read. */
const ARCHIVE_FILE_MODE = 0o600

/** Permission bits of the directories the archive tree owns. */
const ARCHIVE_DIR_MODE = 0o700

/**
 * Configuration of the bypass session archiver.
 *
 * Every field is either a deployment-reachable choice or has one documented
 * default; none of them is a hidden default inside the operation.
 */
export interface Config {
  /** Absolute path of the repository archives are committed into (the team state repository). */
  repositoryRoot: string
  /**
   * MachineId this process archives under. It is the ref namespace shard
   * (§7.2), so an empty value is a load failure: an archive without an owning
   * machine cannot be sharded, fetched, or audited.
   */
  machineId: string
  /** Ref namespace archives are published under (default `refs/dsh/machines`). */
  refPrefix?: string
  /**
   * Absolute path of the archive tree. It must be inside `repositoryRoot`,
   * because the committed path is derived from it.
   */
  archiveRoot: string
  /**
   * Whether `agent/turn-stopping` archives a session (default true). A disabled
   * plugin registers no listener; the explicit methods stay available, because
   * a caller that invokes them asked for that work by name.
   */
  enabled?: boolean
}

/** Configuration after schema defaults have been applied. */
export interface ResolvedConfig {
  /** Absolute repository archives are committed into. */
  readonly repositoryRoot: string
  /** MachineId every ref of this process is sharded by. */
  readonly machineId: string
  /** Ref namespace archives are published under, without a trailing slash. */
  readonly refPrefix: string
  /** Absolute archive tree inside the repository. */
  readonly archiveRoot: string
  /** Whether the turn hook is registered. */
  readonly enabled: boolean
}

/** A machine id names a git ref path segment and a directory, so its alphabet and length are fixed. */
const MACHINE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** A ref namespace this package accepts: a full ref prefix with no traversal. */
const REF_PREFIX_PATTERN = /^refs\/[A-Za-z0-9._/-]+$/

/**
 * Apply the schema defaults and validate everything this service depends on.
 *
 * A misconfigured machine must fail here — at load, once — rather than at the
 * first stopping turn, where an archive that never happens looks like a worker
 * that never ran.
 *
 * @param config - authored plugin configuration.
 * @returns the validated configuration with every default applied.
 * @throws {TypeError} when a path is relative, the repository is missing, the
 * archive tree is outside it, the machine id cannot name a ref segment, or the
 * ref prefix is not a full ref namespace.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const resolved = FleetSessionArchive.Config(config)
  const { repositoryRoot } = resolved
  if (!isAbsolute(repositoryRoot)) {
    throw new TypeError(`@dsh-fleet/session-archive repositoryRoot must be an absolute path: ${repositoryRoot}`)
  }
  if (!isDirectory(repositoryRoot)) {
    throw new TypeError(`@dsh-fleet/session-archive repositoryRoot is not a directory: ${repositoryRoot}`)
  }
  const { archiveRoot } = resolved
  if (!isAbsolute(archiveRoot)) {
    throw new TypeError(`@dsh-fleet/session-archive archiveRoot must be an absolute path: ${archiveRoot}`)
  }
  const inside = relative(repositoryRoot, archiveRoot)
  if (inside === '' || inside.startsWith(`..${sep}`) || inside === '..' || isAbsolute(inside)) {
    throw new TypeError(
      `@dsh-fleet/session-archive archiveRoot must be a directory inside repositoryRoot: ${archiveRoot}`,
    )
  }
  if (!MACHINE_ID_PATTERN.test(resolved.machineId)) {
    throw new TypeError(
      `@dsh-fleet/session-archive machineId must match ${MACHINE_ID_PATTERN.source}: ${JSON.stringify(resolved.machineId)}`,
    )
  }
  const { refPrefix } = resolved
  if (
    !REF_PREFIX_PATTERN.test(refPrefix)
    || refPrefix.includes('..')
    || refPrefix.includes('//')
    || refPrefix.endsWith('/')
  ) {
    throw new TypeError(`@dsh-fleet/session-archive refPrefix must be a full ref namespace: ${refPrefix}`)
  }
  return {
    repositoryRoot,
    machineId: resolved.machineId,
    refPrefix,
    archiveRoot,
    enabled: resolved.enabled,
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionArchive: FleetSessionArchive
  }
}

/** The bypass session archiver: durable per-turn copies of session logs behind per-machine refs. */
export class FleetSessionArchive extends Service {
  static inject = ['subprocess', 'sessionPersistence']

  /** Authored configuration schema; the Loader validates every mounted row against it. */
  static Config: z<Config, ResolvedConfig> = z.object({
    repositoryRoot: z.string().required(),
    machineId: z.string().required(),
    refPrefix: z.string().default('refs/dsh/machines'),
    archiveRoot: z.string().required(),
    enabled: z.boolean().default(true),
  })

  private readonly config: ResolvedConfig
  private readonly lifetime = new AbortController()

  /**
   * @param ctx - owning context; `subprocess` and `sessionPersistence` must be available.
   * @param config - authored plugin configuration, validated here so a
   * misconfigured machine fails at load rather than at the first turn.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'sessionArchive')
    this.config = resolveConfig(config)
    // Disposal stops in-flight plumbing; the archiver owns no other state.
    ctx.effect(() => () => { this.lifetime.abort() })
    if (this.config.enabled) {
      ctx.on('agent/turn-stopping', async ({ agent }) => {
        try {
          await this.archiveSession(agent.session)
        } catch (error) {
          // A turn is never failed by archival. The durable log is the source
          // of truth and stays complete, so the next turn archives it again.
          this.ctx.logger.warn(
            `session-archive: session ${agent.session.id} was not archived: ${describe(error)}`,
          )
        }
      })
    }
  }

  /**
   * Confirm the configured repository before the first turn depends on it.
   * @throws {TypeError} when the configured root is not inside a git working tree.
   */
  protected async [Service.init](): Promise<void> {
    const top = await gitOptional(this.gitTarget(), ['rev-parse', '--show-toplevel'])
    if (top === undefined) {
      throw new TypeError(
        `@dsh-fleet/session-archive repositoryRoot ${this.config.repositoryRoot} is not a git working tree`,
      )
    }
  }

  /** The ref namespace every archived session of this process is published under. */
  get refPrefix(): string {
    return this.config.refPrefix
  }

  /** The absolute archive tree this process writes into. */
  get archiveRoot(): string {
    return this.config.archiveRoot
  }

  /** The machine shard this process owns. */
  get machineId(): string {
    return this.config.machineId
  }

  /**
   * Copy one session's durable log into the archive and publish its commit.
   *
   * The content is read through the persistence seam, which is the only
   * durable log this harness has: the archiver never reads the live Session's
   * in-memory events, so it cannot archive a turn the provider has not
   * accepted. When the durable log still holds no event — a session created but
   * not yet flushed — nothing is written and nothing is committed, because an
   * archive built from anything else would fabricate history that no resume
   * would ever replay.
   *
   * @param session - the session to archive; its id selects the log to read.
   * @returns the ref and the commit carrying this session's archived log.
   * @throws {SessionArchiveError} when the durable log holds no event yet, or a session id cannot name an archive path.
   * @throws {GitPlumbingError} when git refuses a plumbing step.
   */
  async archiveSession(session: Session): Promise<ArchivedRef> {
    const id = String(session.id)
    const target = this.gitTarget()
    const handle = await this.ctx.sessionPersistence.open(session.id, 'read', { signal: this.lifetime.signal })
    let header: SessionHeader
    let events: readonly SessionEvent[]
    try {
      header = handle.header
      events = (await handle.read(undefined, undefined, { signal: this.lifetime.signal })).events
    } finally {
      await handle.close()
    }
    if (events.length === 0) {
      throw new SessionArchiveError(
        `session "${id}" holds no durable event to archive: its log is not flushed, and an archive is never built from anything but the persisted log`,
        id,
      )
    }

    const content = renderArchiveLog(header, events)
    const file = join(this.config.archiveRoot, this.config.machineId, archiveFileName(id))
    await writeFileAtomic(file, content, { mode: ARCHIVE_FILE_MODE, dirMode: ARCHIVE_DIR_MODE })

    // The archive file lives inside the repository, so this is the path the
    // commit carries; it is also the only path this commit changes.
    const segments = relative(this.config.repositoryRoot, file).split(sep)
    const ref = this.refFor(id)
    // A session's ref descends from its own previous archive when one exists,
    // so its history is that session's history; the first archive descends
    // from HEAD, so the commit carries the repository state it was built on.
    const parent = await resolveRef(target, ref) ?? await resolveRef(target, 'HEAD')
    const commit = await commitFile(
      target,
      segments,
      content,
      parent,
      `dsh archive: session ${id} on machine ${this.config.machineId}`,
    )
    await updateRef(target, ref, commit)
    return { ref, commit }
  }

  /**
   * List the archived session refs one machine owns.
   *
   * Read-only: a caller listing another machine's shard sees exactly what that
   * machine published and nothing is created for a machine that published none.
   *
   * @param machineId - machine whose shard is listed.
   * @returns the full ref names under the machine's session namespace.
   * @throws {TypeError} when the machine id cannot name a ref segment.
   * @throws {GitPlumbingError} when git refuses the listing.
   */
  async refs(machineId: string): Promise<readonly string[]> {
    if (!MACHINE_ID_PATTERN.test(machineId)) {
      throw new TypeError(
        `@dsh-fleet/session-archive machineId must match ${MACHINE_ID_PATTERN.source}: ${JSON.stringify(machineId)}`,
      )
    }
    return await listRefs(this.gitTarget(), `${this.config.refPrefix}/${machineId}/sessions/`)
  }

  /**
   * Reconstruct one session's family from the archived headers in this checkout.
   *
   * @param sessionId - the session to answer for.
   * @returns its parent/child tree, or undefined when this checkout holds no
   * archive of that session.
   * @throws {SessionArchiveError} when an archived header cannot be read.
   */
  async family(sessionId: string): Promise<SessionFamily | undefined> {
    return buildFamily(await this.readArchivedSessions(), sessionId)
  }

  /** The ref one session's archive is published under, inside this machine's shard. */
  private refFor(sessionId: string): string {
    return `${this.config.refPrefix}/${this.config.machineId}/sessions/${archiveSegment(sessionId)}`
  }

  /** The plumbing target every command of this service runs against. */
  private gitTarget(): GitTarget {
    return {
      subprocess: this.ctx.subprocess,
      repository: this.config.repositoryRoot,
      signal: this.lifetime.signal,
    }
  }

  /**
   * Read the header of every archived session in this checkout.
   * @returns one source per archived log, ordered by id.
   * @throws {SessionArchiveError} when an archived log has no readable header.
   */
  private async readArchivedSessions(): Promise<ArchivedSession[]> {
    const machines = await childDirectories(this.config.archiveRoot)
    const sessions: ArchivedSession[] = []
    for (const machine of machines) {
      const directory = join(this.config.archiveRoot, machine)
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(ARCHIVE_SUFFIX)) continue
        const path = join(directory, entry.name)
        const header = parseArchivedHeader(firstLine(await readFile(path, 'utf8')), path)
        sessions.push({
          id: header.id,
          ...header.parentSession === undefined ? {} : { parentSession: header.parentSession },
          createdAt: header.createdAt,
          machine,
          archivePath: path,
          children: [],
        })
      }
    }
    return sessions.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
  }
}

/**
 * List the machine shards an archive tree holds.
 * @param archiveRoot - absolute archive tree.
 * @returns the directory names inside it; an archive tree that does not exist yet holds none.
 */
async function childDirectories(archiveRoot: string): Promise<string[]> {
  try {
    const entries = await readdir(archiveRoot, { withFileTypes: true })
    return entries.filter(entry => entry.isDirectory()).map(entry => entry.name)
  } catch (error) {
    // No turn has archived yet, so the tree does not exist: an empty view is
    // the truth. Every other failure is a real fault and is rethrown.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/**
 * Read the first line of a file's text.
 * @param text - complete file content.
 * @returns the first line, or the whole text when it holds no newline.
 */
function firstLine(text: string): string {
  const cut = text.indexOf('\n')
  return cut === -1 ? text : text.slice(0, cut)
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
 * Describe a caught value for one log line.
 * @param error - the caught value.
 * @returns its message, or its string form when it is not an Error.
 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default FleetSessionArchive
