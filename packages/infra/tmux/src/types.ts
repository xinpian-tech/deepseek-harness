/**
 * Vocabulary of the tmux channel: placements, NDJSON frames, and the durable
 * session events that record where a member was placed.
 *
 * @module @dsh-fleet/tmux/types
 */

import type { Session } from '@deepseek-ai/dsh-session'

/** One member's real-time channel address (§5.3 "成员形态"). */
export interface TmuxPlacement {
  /** Caller-chosen key; the same key always names the same pane on this machine. */
  readonly key: string
  /** Machine that owns the pane (§7.2 shards durable state by this value). */
  readonly machine: string
  /** tmux session name. */
  readonly session: string
  /** tmux window name inside {@link session}. */
  readonly window: string
  /** Fully qualified `session:window` target accepted by every tmux subcommand. */
  readonly target: string
  /** PID of the pane's top process; `null` when tmux could not report it. */
  readonly panePid: number | null
  /** Absolute path of the NDJSON file the pane's output is piped into. */
  readonly frameLog: string
  /** Whether this placement was created by this call or reused an existing pane. */
  readonly reused: boolean
}

/** How a placement treats an existing pane with the same key. */
export type PlaceMode = 'fresh' | 'resident'

/** One JSON-RPC request frame written into a pane's stdin. */
export interface TmuxRequestFrame {
  readonly jsonrpc: '2.0'
  readonly id: number
  readonly method: string
  readonly params?: unknown
}

/** One JSON-RPC response frame read back from a pane's output. */
export interface TmuxResponseFrame {
  readonly jsonrpc: '2.0'
  readonly id: number
  readonly result?: unknown
  readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown }
}

/** One JSON-RPC notification frame read from a pane's output. */
export interface TmuxNotificationFrame {
  readonly jsonrpc: '2.0'
  readonly method: string
  readonly params?: unknown
}

/** Any frame that may appear on the channel. */
export type TmuxFrame = TmuxRequestFrame | TmuxResponseFrame | TmuxNotificationFrame

/** What a caller waits for after a request frame was accepted. */
export type TmuxCompletion =
  /** The matching response frame is the completion signal. */
  | 'response'
  /**
   * The matching response frame only acknowledges enqueue; completion is the
   * session's `idle` status notification (§5.4).
   */
  | 'session-idle'

/** A signal the fleet may send to a pane's foreground process group. */
export type TmuxSignal = 'INT' | 'TERM' | 'KILL'

/** Request for `FleetTmux.place`. */
export interface TmuxPlaceRequest {
  /** Absolute working directory of the pane, and of the worker session inside it. */
  readonly cwd: string
  /** Whether an existing pane with this key is reused or replaced. */
  readonly mode: PlaceMode
  /** Extra environment entries handed to the pane, on top of the credential allowlist. */
  readonly env?: Readonly<Record<string, string>>
  /**
   * Session that receives the durable `tmux/placement` record. The caller's own
   * session is the right owner: the placement is part of that session's
   * reconstructable history, not of the pane's.
   */
  readonly recordTo?: Session
}

/** Options for `FleetTmux.request`. */
export interface TmuxRequestOptions {
  /** Session id the notification filter matches; required for `session-idle`. */
  readonly sessionId?: string
  /** Completion rule; defaults to `response`. */
  readonly completion?: TmuxCompletion
  /** Bound on the whole exchange; `0` or omission waits indefinitely. */
  readonly timeoutMs?: number
  /** Caller-owned cancellation. */
  readonly signal?: AbortSignal
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Durable record of where a member was placed (§11 item 2). Replay
     * reconstructs the fleet's pane map without touching tmux, which is what
     * makes a crashed machine explainable after the fact.
     */
    'tmux/placement': {
      readonly key: string
      readonly machine: string
      readonly session: string
      readonly window: string
      readonly panePid: number | null
      readonly frameLog: string
      readonly mode: PlaceMode
    }
    /**
     * Durable record of a signal sent to a member, or of a member that was no
     * longer there to receive one (§11 item 13). Absence of a completion is a
     * caller-visible failure, never a queued redelivery.
     */
    'tmux/interrupt': {
      readonly key: string
      readonly signal: TmuxSignal
      readonly delivered: boolean
      readonly reason?: string
    }
  }
}
