/**
 * `ctx.promptSource` — the audit label of a prompt (§11 item 5).
 *
 * The SDK JSON-RPC server labels every `session/prompt` it serves with
 * `source: { kind: 'user' }`, and it exposes no seam for a plugin to change
 * that: the transport handler, the method table, and the message construction
 * all live inside one plugin whose transport instance, request dispatch, and
 * consumed services are private. So this package owns the two things that CAN
 * be owned from outside the server:
 *
 * 1. A request-scoped source registry. `markNext(requestId, source)` reserves
 *    a label for exactly one prompt, `take(requestId)` consumes that
 *    reservation, and an unclaimed reservation expires, so a label can never
 *    attach itself to an unrelated prompt.
 * 2. A source-carrying prompt path, {@link PromptSource.prompt}, which
 *    resolves that reservation, delivers the message, and records the
 *    resolved label on the session as the durable `prompt/source` event.
 *    {@link PromptSource.kindOf} answers the audit question from that durable
 *    record — never from the in-memory registry, which is a guess that does
 *    not survive a restart.
 *
 * The delivered message itself is identical to the one the SDK server builds
 * (content plus `{ kind: 'user' }`), so this plugin changes nothing a model
 * request sees; the label lives in the log-only `prompt/source` record. The
 * README states exactly which part of the requirement the server's missing
 * extension point leaves undelivered.
 *
 * @module @dsh-fleet/prompt-source
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionLogOffset, type SessionEvent } from '@deepseek-ai/dsh-session'
import {
  SessionPersistenceNotFoundError,
  type SessionHandle,
  type SessionPersistence,
} from '@deepseek-ai/dsh-session-persistence'
import type {
  BuiltinPromptSource,
  PromptSourceMark,
  PromptSourceRecord,
  PromptTarget,
  SourcePromptRequest,
  SourcePromptResult,
} from './types.ts'

export type * from './types.ts'

/** Labels every build accepts; `extraKinds` extends this set at load. */
export const BUILTIN_PROMPT_SOURCES: readonly BuiltinPromptSource[] = Object.freeze([
  'user',
  'leader',
  'peer',
])

/**
 * Accepted label alphabet. A label is written into the durable log and into
 * diagnostics, so it stays one lowercase token rather than free text.
 */
const LABEL_PATTERN = /^[a-z][a-z0-9-]{0,31}$/

/** Configuration of the prompt-source registry. */
export interface Config {
  /** Source labels accepted on top of {@link BUILTIN_PROMPT_SOURCES}. */
  extraKinds?: string[]
  /** Label a delivery under no pending mark resolves to (default `user`). */
  defaultSource?: string
  /** Bound (ms) an unclaimed mark stays valid (default 300000). */
  markTtlMs?: number
  /** Most unclaimed marks held at once (default 1024). */
  maxPendingMarks?: number
  /** Events requested per durable read while answering `kindOf` (default 500). */
  readWindow?: number
}

/** The configuration after defaults and validation. */
export interface ResolvedConfig {
  /** Accepted labels on top of {@link BUILTIN_PROMPT_SOURCES}, in declaration order. */
  readonly extraKinds: readonly string[]
  /** Label a delivery under no pending mark resolves to. */
  readonly defaultSource: string
  /** Bound (ms) an unclaimed mark stays valid. */
  readonly markTtlMs: number
  /** Most unclaimed marks held at once. */
  readonly maxPendingMarks: number
  /** Events requested per durable read. */
  readonly readWindow: number
}

/** Raised when a delivered prompt cannot be recorded, or a record cannot be read. */
export class PromptSourceError extends Error {
  /**
   * @param message - operator-facing description of the failure.
   */
  constructor(message: string) {
    super(message)
    this.name = 'PromptSourceError'
  }
}

/** One held reservation plus the time it was placed. */
interface PendingMark {
  readonly mark: PromptSourceMark
  readonly markedAt: number
}

/**
 * Validate the configured label set and bounds.
 *
 * A deployment that misspells a label or sets a nonpositive bound fails here,
 * at load, rather than after a prompt was already delivered under the wrong
 * label.
 *
 * @param config - raw plugin configuration.
 * @returns the validated configuration.
 * @throws {TypeError} when a label is malformed or duplicated, the default
 * label is not accepted, or a bound is not a positive safe integer.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const resolved = PromptSource.Config(config)
  const accepted: string[] = [...BUILTIN_PROMPT_SOURCES]
  for (const kind of resolved.extraKinds) {
    if (!LABEL_PATTERN.test(kind)) {
      throw new TypeError(
        `@dsh-fleet/prompt-source extraKinds entries must match ${LABEL_PATTERN.source}: ${JSON.stringify(kind)}`,
      )
    }
    if (accepted.includes(kind)) {
      throw new TypeError(`@dsh-fleet/prompt-source extraKinds repeats the accepted label "${kind}"`)
    }
    accepted.push(kind)
  }
  const defaultSource = resolved.defaultSource
  if (!accepted.includes(defaultSource)) {
    throw new TypeError(
      `@dsh-fleet/prompt-source defaultSource must be one of ${accepted.join(', ')}: ${JSON.stringify(defaultSource)}`,
    )
  }
  const markTtlMs = resolved.markTtlMs
  if (!Number.isSafeInteger(markTtlMs) || markTtlMs <= 0) {
    throw new TypeError('@dsh-fleet/prompt-source markTtlMs must be a positive safe integer')
  }
  const maxPendingMarks = resolved.maxPendingMarks
  if (!Number.isSafeInteger(maxPendingMarks) || maxPendingMarks <= 0) {
    throw new TypeError('@dsh-fleet/prompt-source maxPendingMarks must be a positive safe integer')
  }
  const readWindow = resolved.readWindow
  if (!Number.isSafeInteger(readWindow) || readWindow <= 0) {
    throw new TypeError('@dsh-fleet/prompt-source readWindow must be a positive safe integer')
  }
  return {
    extraKinds: Object.freeze([...resolved.extraKinds]),
    defaultSource,
    markTtlMs,
    maxPendingMarks,
    readWindow,
  }
}

/**
 * Find one session's prompt-source record in an already-materialized event
 * list.
 *
 * The scan is the durable read: it reads the record the session logged, and a
 * list without the record answers `undefined` rather than guessing.
 *
 * @param events - session events in log order.
 * @param messageId - identity of the prompt to look up.
 * @returns the record for that message, or undefined when the log holds none.
 */
export function readPromptSourceRecord(
  events: readonly SessionEvent[],
  messageId: string,
): PromptSourceRecord | undefined {
  for (const event of events) {
    if (event.type !== 'prompt/source') continue
    if (event.data.messageId === messageId) return event.data
  }
  return undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    promptSource: PromptSource
  }
}

/** The prompt-source registry service. */
export class PromptSource extends Service {
  static Config: z<Config, ResolvedConfig> = z.object({
    extraKinds: z.array(z.string()).default([]),
    defaultSource: z.string().default('user'),
    markTtlMs: z.number().default(300_000),
    maxPendingMarks: z.number().step(1).default(1024),
    readWindow: z.number().step(1).default(500),
  })

  /** The configuration after defaults and validation. */
  private readonly config: ResolvedConfig
  /** Every accepted label: the built-in set plus the configured extras. */
  private readonly accepted: readonly string[]
  /** {@link accepted} as a membership test. */
  private readonly acceptedSet: ReadonlySet<string>
  /** Unclaimed reservations, keyed by the request id they were placed for. */
  private readonly marks = new Map<string, PendingMark>()

  /**
   * @param ctx - owning context.
   * @param config - plugin configuration, validated here so a bad label set
   * fails at load rather than at the first delivery.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'promptSource')
    this.config = resolveConfig(config)
    this.accepted = Object.freeze([...BUILTIN_PROMPT_SOURCES, ...this.config.extraKinds])
    this.acceptedSet = new Set(this.accepted)
  }

  /**
   * Reserve a source label for the next prompt delivered under a request id.
   *
   * The reservation is consumed exactly once and expires after `markTtlMs`, so
   * a mark never survives into an unrelated prompt. A second call for the same
   * request id replaces the first: the caller retried its own prompt.
   *
   * @param requestId - correlation id of the prompt this label belongs to.
   * @param source - label to resolve for that prompt.
   * @param sessionId - optional session the mark is bound to; a caller that
   * does not name this session never sees it.
   * @throws {TypeError} when the label is not accepted.
   * @throws {PromptSourceError} when the pending-mark bound is reached, which
   * would otherwise silently drop a reservation.
   */
  markNext(requestId: string, source: string, sessionId?: string): void {
    if (requestId === '') throw new TypeError('@dsh-fleet/prompt-source requestId must be a non-empty string')
    if (!this.acceptedSet.has(source)) {
      throw new TypeError(
        `@dsh-fleet/prompt-source rejects the unknown source ${JSON.stringify(source)}; accepted: `
        + this.accepted.join(', '),
      )
    }
    this.expire()
    if (!this.marks.has(requestId) && this.marks.size >= this.config.maxPendingMarks) {
      throw new PromptSourceError(
        `@dsh-fleet/prompt-source holds ${String(this.marks.size)} unclaimed marks; delivering or expiring one `
        + 'frees the bound, and config maxPendingMarks raises it',
      )
    }
    const mark: PromptSourceMark = Object.freeze({
      requestId,
      source,
      ...sessionId === undefined ? {} : { sessionId },
    })
    this.marks.set(requestId, { mark, markedAt: Date.now() })
  }

  /**
   * Consume the reservation for one request id.
   *
   * @param requestId - correlation id the mark was placed for.
   * @param sessionId - session the caller is delivering into; a session-bound
   * mark is returned only to that session.
   * @returns the consumed mark, or undefined when none is pending.
   */
  take(requestId: string, sessionId?: string): PromptSourceMark | undefined {
    this.expire()
    const pending = this.marks.get(requestId)
    if (pending === undefined) return undefined
    if (pending.mark.sessionId !== undefined && pending.mark.sessionId !== sessionId) return undefined
    this.marks.delete(requestId)
    return pending.mark
  }

  /**
   * Deliver one prompt and record the label it resolved to.
   *
   * The pending mark for `requestId` is consumed; without one the configured
   * default applies. The message handed to the target is the same one the SDK
   * server builds, so nothing model-visible changes; the durable
   * `prompt/source` record is what makes the delivery auditable.
   *
   * The record is appended when the prompt is issued, which is this call: the
   * agent loop owns when the queued message runs, and the label describes who
   * issued the prompt, not when it executed.
   *
   * @param target - live delivery capability; a live `Agent` satisfies it, so
   * the usual argument is `ctx.agents.get(id)`.
   * @param request - correlation id and prompt content.
   * @returns the queued message identity and the resolved label.
   */
  prompt(target: PromptTarget, request: SourcePromptRequest): SourcePromptResult {
    const session = target.session
    const source = this.take(request.requestId, session.id)?.source ?? this.config.defaultSource
    const message = createUserMessage({
      content: [...request.contentBlocks],
      source: { kind: 'user' },
    })
    const record: PromptSourceRecord = Object.freeze({
      sessionId: session.id,
      messageId: message.id,
      requestId: request.requestId,
      source,
    })
    target.followup(message)
    session.append('prompt/source', record)
    return { messageId: message.id, source }
  }

  /**
   * Read one prompt's recorded source from the durable session log.
   *
   * The answer comes from stored events, never from the in-memory mark
   * registry: after a restart the registry is empty, and a guess derived from
   * it would relabel a leader's instruction as a human message. A session this
   * process never stored answers `undefined` — no record exists.
   *
   * @param sessionId - session that owns the prompt.
   * @param messageId - identity of the prompt to look up.
   * @returns the durable record, or undefined when the log holds none.
   * @throws {PromptSourceError} when no persistence service is mounted.
   * @throws the store's own error when the stored log cannot be read — its
   * refusal of an event type this build does not know included, which is the
   * fail-closed answer this read must not translate into a guess.
   */
  async kindOf(sessionId: string, messageId: string): Promise<PromptSourceRecord | undefined> {
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) {
      throw new PromptSourceError(
        '@dsh-fleet/prompt-source reads prompt sources from durable session storage; '
        + 'mount a session-persistence backend in this composition',
      )
    }
    const handle = await this.openStored(persistence, sessionId)
    if (handle === undefined) return undefined
    try {
      let offset = 0
      for (;;) {
        const { events } = await handle.read(SessionLogOffset(offset), this.config.readWindow)
        if (events.length === 0) return undefined
        const record = readPromptSourceRecord(events, messageId)
        if (record !== undefined) return record
        offset += events.length
      }
    } finally {
      await handle.close()
    }
  }

  /**
   * Open the stored session, translating "not stored" into an absent answer.
   * @param persistence - the mounted persistence service.
   * @param sessionId - session to open read-only.
   * @returns the read handle, or undefined when the session was never stored.
   * @throws {PromptSourceError} when the store holds the session but refuses to open it.
   */
  private async openStored(
    persistence: SessionPersistence,
    sessionId: string,
  ): Promise<SessionHandle | undefined> {
    try {
      return await persistence.open(SessionId(sessionId), 'read')
    } catch (error: unknown) {
      if (error instanceof SessionPersistenceNotFoundError) return undefined
      throw new PromptSourceError(
        `@dsh-fleet/prompt-source cannot open session "${sessionId}" for reading: `
        + `${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /** Drop reservations whose bound elapsed, so a stale mark cannot be consumed. */
  private expire(): void {
    const deadline = Date.now() - this.config.markTtlMs
    for (const [requestId, pending] of this.marks) {
      if (pending.markedAt <= deadline) this.marks.delete(requestId)
    }
  }
}

export default PromptSource
