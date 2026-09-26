/**
 * Vocabulary of worktree isolation: one candidate is one git worktree on one
 * branch, and the durable session records that let a task's candidate set be
 * reconstructed from the log (§11 item 8).
 *
 * @module @dsh-fleet/worktree/types
 */

import type { Session } from '@deepseek-ai/dsh-session'

/** One candidate's isolated checkout of the task's repository (§12 worktree 隔离). */
export interface Worktree {
  /** Task the candidate belongs to, exactly as supplied to `createCandidate`. */
  readonly taskId: string
  /** Candidate index within the task. */
  readonly index: number
  /** Absolute path of the candidate's worktree. */
  readonly path: string
  /**
   * Branch the candidate's worktree is checked out on. Every candidate keeps
   * its own branch, so a swept-out candidate's commit stays addressable (§5.5).
   */
  readonly branch: string
  /** Commit the candidate branch was created from. */
  readonly baseCommit: string
  /** Creation time in epoch milliseconds. */
  readonly createdAt: number
}

/** Options for the calls that also write a durable session record. */
export interface WorktreeRecordOptions {
  /**
   * Session receiving the durable `worktree/*` record. The caller's own session
   * is the right owner: the candidate set is part of that session's
   * reconstructable history, not of the candidate's checkout.
   */
  readonly recordTo?: Session
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Durable record of one candidate's worktree and branch (§11 item 8, §5.5).
     * Log-only placement state: replay reconstructs a task's candidate set —
     * including the candidates a later selection swept out and the commits
     * kept as evaluation evidence — without touching git.
     */
    'worktree/candidate': {
      readonly taskId: string
      readonly index: number
      readonly path: string
      readonly branch: string
      readonly baseCommit: string
      readonly createdAt: number
    }
    /**
     * Durable record of which candidate the main agent accepted (§11 item 8).
     * The candidate branch keeps the candidate's own commits; `branch` is the
     * branch the accepted commit was published under, so a branch name alone
     * tells a swept-out candidate from the selected commit (§5.5).
     */
    'worktree/select': {
      readonly taskId: string
      readonly index: number
      readonly branch: string
      readonly commit: string
      readonly selectedBranch: string
    }
    /**
     * Durable record of one prune attempt (§11 item 8). `removedBranches` is
     * empty for the configured keep-losers behaviour and for a task whose
     * candidates were all already gone, so an empty list is a recorded
     * outcome rather than a missing record.
     */
    'worktree/prune': {
      readonly taskId: string
      readonly removedBranches: readonly string[]
    }
  }
}
