/**
 * Vocabulary of two-phase git archival: one queued push, one drain report, and
 * the durable session event that records the local commit a turn produced.
 *
 * @module @dsh-fleet/git-checkpoint/types
 */

/** One ref waiting for its asynchronous push (§7.1 phase 2). */
export interface PushQueueEntry {
  /** Absolute path of the repository that owns {@link ref}. */
  readonly repository: string
  /** Remote {@link ref} is pushed to; a remote name git resolves, never a URL. */
  readonly remote: string
  /** Full ref name, e.g. `refs/heads/main` or `refs/dsh/machines/m1/sessions/s1`. */
  readonly ref: string
}

/** What one drain did with the queue it read. */
export interface PushDrainReport {
  /** Entries whose push reached the remote during this drain, in queue order. */
  readonly pushed: readonly PushQueueEntry[]
  /**
   * Entries still queued because their attempt budget ran out, or because the
   * drain was cancelled. A failed entry is never dropped: the next drain
   * retries it.
   */
  readonly failed: readonly PushQueueEntry[]
}

/** The local commit one turn produced. */
export interface CheckpointCommit {
  /** Full commit id of the commit the turn's staged workspace produced. */
  readonly commit: string
  /** Absolute repository the commit lives in. */
  readonly repository: string
  /** Branch the commit advanced; absent on a detached HEAD. */
  readonly branch?: string
  /**
   * Branch ref queued for phase 2; absent on a detached HEAD, which has no
   * branch ref to publish.
   */
  readonly ref?: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Durable record of the local commit one turn produced (§7.1 phase 1, §11
     * item 6). The commit itself happens inside the turn with no network
     * access; this event is what lets a later reader pair a turn with the tree
     * it left, whether or not phase 2 has pushed that commit yet.
     */
    'git/checkpoint': {
      /** Turn that produced the commit. */
      readonly turn: number
      /** Full commit id. */
      readonly commit: string
      /** Absolute repository the commit lives in. */
      readonly repository: string
      /** Branch the commit advanced; absent on a detached HEAD. */
      readonly branch?: string
      /** Branch ref queued for the asynchronous push; absent on a detached HEAD. */
      readonly ref?: string
    }
  }
}
