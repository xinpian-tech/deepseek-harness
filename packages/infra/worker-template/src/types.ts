/**
 * Vocabulary of the worker launch template: what one launch requests, and what
 * it reports about the pane it placed.
 *
 * @module @dsh-fleet/worker-template/types
 */

import type { PlaceMode, TmuxPlacement } from '@dsh-fleet/tmux'
import type { Session } from '@deepseek-ai/dsh-session'

/**
 * One worker pane launch.
 *
 * The peer is the shell contract in `infra/scripts/worker.sh`: a key names the
 * pane, `cwd` is where it lives, and the same key always maps to the same
 * window, which is what makes `resident` mean "resume the same conversation".
 */
export interface WorkerLaunchRequest {
  /** Absolute working directory of the pane, and of the worker session inside it. */
  readonly cwd: string
  /**
   * Whether an existing pane with this key is reused or replaced. A worker is
   * resident for the whole task (§5.4), so the default is `resident`.
   */
  readonly mode?: PlaceMode
  /**
   * Session that receives the durable `tmux/placement` record. The caller's
   * own session is the right owner; the pane's placement is part of that
   * session's reconstructable history.
   */
  readonly recordTo?: Session
}

/**
 * What one launch produced, without reading the pane.
 *
 * `launchLine` and `env` are reported so a test and an operator can assert the
 * exact command and the exact environment entries the pane received; a
 * credential the template failed to forward is then visible in a diagnostic
 * instead of only as a 401 several layers deep in a nested harness (§8.2).
 */
export interface WorkerHandle {
  /** Placement key this launch used. */
  readonly key: string
  /** The pane the composed channel placed or reused. */
  readonly placement: TmuxPlacement
  /** The exact command line the pane runs, already quoted for the shell. */
  readonly launchLine: string
  /** The environment entries handed to the pane, never including a credential that was absent. */
  readonly env: Readonly<Record<string, string>>
  /** Whether this launch reused a live pane instead of creating one. */
  readonly reused: boolean
}
