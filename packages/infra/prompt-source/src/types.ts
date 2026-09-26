/**
 * Vocabulary of the prompt-source registry: the built-in label set, the
 * request-scoped mark a caller places before delivering a prompt, and the
 * durable session event that records which kind of caller issued one prompt.
 *
 * @module @dsh-fleet/prompt-source/types
 */

import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'

/**
 * Labels every build accepts without configuration.
 *
 * `user` is a human-issued prompt, `leader` one this agent's delegating leader
 * issued, and `peer` one another fleet member issued. A deployment extends the
 * set through the plugin's `extraKinds` config; the durable record carries the
 * label as a string so a reader built for the built-in three can still read a
 * deployment's own label instead of refusing the log.
 */
export type BuiltinPromptSource = 'user' | 'leader' | 'peer'

/**
 * One accepted source label.
 *
 * A plain string rather than a union: the accepted set is
 * `extraKinds`-extensible at load, and every consumer that switches on a label
 * falls through to its documented default.
 */
export type PromptSourceLabel = string

/**
 * One request-scoped reservation created by `markNext` and consumed by `take`
 * or by the source-carrying prompt path.
 */
export interface PromptSourceMark {
  /** Caller-chosen correlation id of the prompt this mark belongs to. */
  readonly requestId: string
  /** Label resolved for that prompt. */
  readonly source: PromptSourceLabel
  /**
   * Session the mark may be consumed by. Absent means any session, which is
   * only safe when the request id already names exactly one prompt; when set,
   * a caller that does not name this session never sees the mark.
   */
  readonly sessionId?: string
}

/**
 * The durable record of one resolved prompt source: the payload of the
 * `prompt/source` session event.
 *
 * Plain JSON, so the record replays with the rest of the log and an auditor
 * joins it to the prompt by {@link PromptSourceRecord.messageId}.
 */
export interface PromptSourceRecord {
  /** Session that owns the record; it is the session the event was appended to. */
  readonly sessionId: string
  /** Identity of the prompt the record describes. */
  readonly messageId: string
  /** Correlation id the caller used for that prompt. */
  readonly requestId: string
  /** Resolved label. */
  readonly source: PromptSourceLabel
}

/**
 * The delivery capability the source-carrying prompt path needs.
 *
 * A live `Agent` satisfies this structurally: it exposes the session whose log
 * receives the record, and `followup` is the queueing primitive §12 keeps for
 * prompts. Naming the capability instead of the whole agent keeps the path
 * usable by any owner of a delivery and keeps this plugin's injection list
 * empty, so it mounts in a pane composition that owns neither an agent loop nor
 * a subagent registry.
 */
export interface PromptTarget {
  /** Live session this prompt enters; its log receives the durable record. */
  readonly session: Session
  /**
   * Queue one prompt as an ordinary follow-up turn.
   * @param message - the identified prompt message to deliver.
   */
  followup(message: UserMessage): void
}

/** One prompt delivered through the source-carrying path. */
export interface SourcePromptRequest {
  /**
   * Correlation id this prompt is delivered under. A pending mark for this id
   * is consumed; without one the configured default label applies.
   */
  readonly requestId: string
  /** Prompt content, delivered verbatim as the user message. */
  readonly contentBlocks: readonly ContentBlock[]
}

/** Outcome of one delivered prompt. */
export interface SourcePromptResult {
  /** Identity of the queued message the record describes. */
  readonly messageId: string
  /** Label the delivery resolved to. */
  readonly source: PromptSourceLabel
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Durable record of the caller kind that issued one prompt (§11 item 5).
     * Log-only: it labels a prompt for audit and never reaches a model
     * request, so replay reconstructs who instructed an agent without
     * changing what any agent saw.
     */
    'prompt/source': PromptSourceRecord
  }
}
