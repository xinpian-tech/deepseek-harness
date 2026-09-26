/**
 * The archive artifact: the canonical JSONL copy of one session's durable log,
 * the names one archived session is addressed by, and the grouping view
 * reconstructed from archived headers.
 *
 * The copy is not a byte copy of the provider's file. The persistence seam
 * exposes a session's log, not the path of the artifact holding it, and a
 * backend may compress that artifact; one JSON object per line, header first,
 * is therefore what the archive writes. The header carries the same fields the
 * JSONL provider stores in its own first record, `parentSession` included,
 * which is what makes grouping a content question rather than a ref-layout
 * question (§7.2).
 *
 * @module @dsh-fleet/session-archive/archive
 */

import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { ArchivedSession, SessionFamily } from './types.ts'

/** Raised when a session cannot be archived, or an archive cannot be read. */
export class SessionArchiveError extends Error {
  /**
   * @param message - operator-facing description of the refusal.
   * @param sessionId - session the refusal belongs to, when one is known.
   */
  constructor(
    message: string,
    readonly sessionId?: string,
  ) {
    super(message)
    this.name = 'SessionArchiveError'
  }
}

/**
 * One character an archive path or ref segment keeps literally. `.` is not in
 * the set, so no id can name a hidden component or one ending in `.lock`;
 * `_` is the escape marker rather than a literal.
 */
const SAFE_UNIT = /^[A-Za-z0-9-]$/

/** Prefix of one escaped UTF-16 code unit. */
const ESCAPE_MARKER = '_'

/** Suffix of every archived log file. */
export const ARCHIVE_SUFFIX = '.jsonl'

/** First line of an archived log: the header the grouping view reads. */
export interface ArchivedHeader {
  /** Record tag; the provider's own first record uses the same one. */
  readonly type: 'session'
  /** Session format version the archived events were written in. */
  readonly version: number
  /** Session id. */
  readonly id: string
  /** Creation time, which orders sibling sessions. */
  readonly createdAt: number
  /** Absolute workspace the session was created in, when it had one. */
  readonly cwd?: string
  /** Session this one was forked from; the parent link grouping reads. */
  readonly parentSession?: string
  /** Whether the archived log begins with a fork-inherited prefix. */
  readonly isSeeded: boolean
  /** Coarse classification of a subagent child. */
  readonly origin?: 'subagent'
  /** Delegation depth of the archived session. */
  readonly delegationDepth: number
  /** Agent preset the archived session was composed from, when one was recorded. */
  readonly agentPreset?: string
}

/**
 * Encode one session id as a single safe path and ref segment.
 *
 * A session id is an opaque string, and it becomes a directory entry, a file
 * name, and a git ref component. Every unit outside the literal set — `.`, `_`,
 * path separators, `~`, NUL, and everything non-ASCII — is escaped as `_XXXX`,
 * so the result is spelled only in characters git accepts in a ref component
 * and no id can traverse out of the archive tree or name a component git
 * refuses (a leading dot, a `.lock` ending, or a `~`).
 *
 * @param value - the session id to encode; must be non-empty.
 * @returns the escaped single segment.
 * @throws {SessionArchiveError} when the id is empty and cannot name a segment.
 */
export function archiveSegment(value: string): string {
  if (value === '') throw new SessionArchiveError('a session id cannot name an archive path or ref', value)
  let segment = ''
  for (let index = 0; index < value.length; index += 1) {
    const unit = value[index] ?? ''
    segment += SAFE_UNIT.test(unit)
      ? unit
      : `${ESCAPE_MARKER}${unit.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`
  }
  return segment
}

/**
 * The file name one session's archived log is stored under.
 * @param sessionId - session id to encode.
 * @returns the escaped id with the archive suffix.
 */
export function archiveFileName(sessionId: string): string {
  return `${archiveSegment(sessionId)}${ARCHIVE_SUFFIX}`
}

/**
 * Render the archived copy of one durable log.
 *
 * The header line is built from the stored header, so the archive records the
 * same identity and lineage a live log carries, then every durable event
 * follows in sequence order, one JSON object per line.
 *
 * @param header - the session's stored header.
 * @param events - the durable events the persistence seam exposed, contiguous from seq 0.
 * @returns the complete archive file content, newline-terminated.
 */
export function renderArchiveLog(header: SessionHeader, events: readonly SessionEvent[]): string {
  const line: ArchivedHeader = {
    type: 'session',
    version: header.version,
    id: String(header.id),
    createdAt: header.createdAt,
    ...header.cwd === undefined ? {} : { cwd: header.cwd },
    ...header.parentSession === undefined ? {} : { parentSession: String(header.parentSession) },
    isSeeded: header.isSeeded,
    ...header.origin === undefined ? {} : { origin: header.origin },
    delegationDepth: header.delegationDepth ?? 0,
    ...header.agentPreset === undefined ? {} : { agentPreset: header.agentPreset },
  }
  return `${[JSON.stringify(line), ...events.map(event => JSON.stringify(event))].join('\n')}\n`
}

/**
 * Read the header line of an archived log.
 * @param line - the file's first line.
 * @param path - absolute archive file the line came from, for failures.
 * @returns the decoded header.
 * @throws {SessionArchiveError} when the line is not an archived session header.
 */
export function parseArchivedHeader(line: string, path: string): ArchivedHeader {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    // A first line that is not JSON cannot identify the session it belongs to.
    throw new SessionArchiveError(`archived session ${path} does not begin with a JSON header line`, path)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SessionArchiveError(`archived session ${path} does not begin with a session header object`, path)
  }
  const record = parsed as Partial<Record<keyof ArchivedHeader, unknown>>
  if (record.type !== 'session' || typeof record.id !== 'string' || typeof record.createdAt !== 'number') {
    throw new SessionArchiveError(`archived session ${path} has no readable session header`, path)
  }
  if (record.parentSession !== undefined && typeof record.parentSession !== 'string') {
    throw new SessionArchiveError(`archived session ${path} has a non-string parentSession`, path)
  }
  return {
    type: 'session',
    version: typeof record.version === 'number' ? record.version : 0,
    id: record.id,
    createdAt: record.createdAt,
    ...typeof record.cwd === 'string' ? { cwd: record.cwd } : {},
    ...typeof record.parentSession === 'string' ? { parentSession: record.parentSession } : {},
    isSeeded: record.isSeeded === true,
    ...record.origin === 'subagent' ? { origin: 'subagent' } : {},
    delegationDepth: typeof record.delegationDepth === 'number' ? record.delegationDepth : 0,
    ...typeof record.agentPreset === 'string' ? { agentPreset: record.agentPreset } : {},
  }
}

/**
 * Order sibling sessions deterministically.
 * @param left - one archived session.
 * @param right - the other archived session.
 * @returns a negative, zero, or positive comparison result.
 */
function byCreation(left: ArchivedSession, right: ArchivedSession): number {
  if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}

/**
 * Reconstruct the grouping view of one session from archived headers.
 *
 * The tree comes from each header's `parentSession`, never from the ref
 * layout: a ref name carries a machine and a session, and two sessions of one
 * family are routinely archived on different machines. A parent that is not
 * archived in this checkout keeps its link on the node and contributes no
 * ancestor, which is how a family whose root lives on another machine still
 * answers with what this checkout holds.
 *
 * @param sources - every archived session this checkout holds.
 * @param sessionId - the session to answer for.
 * @returns its family, or undefined when the session is not archived here.
 * @throws {SessionArchiveError} when the queried session cannot be located in the tree it belongs to.
 */
export function buildFamily(sources: readonly ArchivedSession[], sessionId: string): SessionFamily | undefined {
  const byId = new Map(sources.map(source => [source.id, source]))
  const requested = byId.get(sessionId)
  if (requested === undefined) return undefined

  // Walk up while the parent is archived here; a repeated id ends the walk, so
  // content that links two sessions to each other cannot recurse forever.
  const lineage: string[] = []
  const visited = new Set<string>([requested.id])
  let rootId = requested.id
  for (
    let parent = requested.parentSession;
    parent !== undefined && byId.has(parent) && !visited.has(parent);
    parent = byId.get(parent)?.parentSession
  ) {
    visited.add(parent)
    lineage.unshift(parent)
    rootId = parent
  }

  const nodes = new Map<string, ArchivedSession>()
  const build = (id: string, ancestors: ReadonlySet<string>): ArchivedSession => {
    const source = byId.get(id)
    if (source === undefined) {
      throw new SessionArchiveError(`archived family is missing session "${id}"`, id)
    }
    const next = new Set(ancestors)
    next.add(id)
    const node: ArchivedSession = {
      id: source.id,
      ...source.parentSession === undefined ? {} : { parentSession: source.parentSession },
      createdAt: source.createdAt,
      machine: source.machine,
      archivePath: source.archivePath,
      children: sources
        .filter(candidate => candidate.parentSession === id && !next.has(candidate.id))
        .sort(byCreation)
        .map(candidate => build(candidate.id, next)),
    }
    nodes.set(id, node)
    return node
  }

  const root = build(rootId, new Set())
  const session = nodes.get(requested.id)
  if (session === undefined) {
    throw new SessionArchiveError(`archived session "${sessionId}" is not reachable from its own family root`, sessionId)
  }
  const ancestors: ArchivedSession[] = []
  for (const id of lineage) {
    const ancestor = nodes.get(id)
    if (ancestor === undefined) {
      throw new SessionArchiveError(`archived ancestor "${id}" is not reachable from the family root`, id)
    }
    ancestors.push(ancestor)
  }
  return { root, session, ancestors }
}
