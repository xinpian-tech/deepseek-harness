/**
 * Vocabulary of the fleet's task contract (§6.1): the acceptance criteria a
 * task carries, the machine-decided result of each one, and the durable session
 * records that carry both into a child session's bootstrap context.
 *
 * @module @dsh-fleet/task-spec/types
 */

import type { Session } from '@deepseek-ai/dsh-session'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'

/** What a `command` criterion demands of the command it runs. */
export interface CommandExpectation {
  /** Exit status the command must produce. */
  readonly exitCode: number
  /** Regular-expression source the command's captured stdout must match. */
  readonly stdoutMatches?: string
  /** Deadline in milliseconds for this command; absent uses the configured `defaultTimeoutMs`. */
  readonly timeoutMs?: number
}

/** A shell command whose exit status, and optionally whose stdout, decides pass or fail. */
export interface CommandCriterion {
  readonly kind: 'command'
  /** Command line handed to the shell seam; it runs in the workspace root. */
  readonly run: string
  readonly expect: CommandExpectation
}

/** A workspace file that must exist and satisfy an object-rooted JSON Schema. */
export interface SchemaCriterion {
  readonly kind: 'schema'
  /** Path relative to the workspace root; an absolute path or one escaping the root is refused. */
  readonly target: string
  /** Schema the target file's parsed JSON must satisfy. */
  readonly schema: ObjectJsonSchema
}

/** A bound on how many lines a task may change inside one workspace scope. */
export interface DiffCriterion {
  readonly kind: 'diff'
  /** Git pathspec, relative to the workspace root. */
  readonly scope: string
  /** Largest number of changed lines (added plus deleted) the scope may report. */
  readonly maxLines: number
}

/** One thing a machine can decide about a task's result. */
export type AcceptanceCriterion = CommandCriterion | SchemaCriterion | DiffCriterion

/**
 * What executing one criterion decided. `passed` and `failed` are verdicts on
 * the criterion; `error` means the criterion could not be decided at all — a
 * target outside the workspace root, an unreadable file, a git failure — so the
 * item stays visible instead of turning into a thrown run.
 */
export type AcceptanceStatus = 'passed' | 'failed' | 'error'

/** One criterion's outcome, carrying the criterion it decided and the observed evidence. */
export interface AcceptanceResult {
  /** The exact criterion this result decides, so a report never separates a verdict from its standard. */
  readonly criterion: AcceptanceCriterion
  readonly status: AcceptanceStatus
  /** Observed evidence: exit status, schema violations, or both sides of the line count. */
  readonly detail: string
}

/** Round budgets the parent hands down with the task (§4.3). */
export interface TaskLimits {
  /** Correction rounds the task may spend before it must escalate. */
  readonly reworkRounds: number
  /** Additional tree levels the task may open before it must escalate. */
  readonly deepenRounds: number
}

/** One task as it travels down the tree. */
export interface TaskSpec {
  /** Task identity, unique among the tasks one tree grows. */
  readonly id: string
  /** One-line statement of the outcome the task owes its parent. */
  readonly title: string
  /** The machine-decidable criteria carried by the task itself; never empty, never rewritten. */
  readonly acceptance: readonly AcceptanceCriterion[]
  /** Ancestor task ids from the root down to the parent, which places the task in the tree. */
  readonly parentPath: readonly string[]
  readonly limits: TaskLimits
}

/** What one task consumed, as the ledger (§6.4) records it. */
export interface TaskCost {
  /** Model tokens the task consumed, input plus output. */
  readonly tokens: number
  /** Provider-reported spend in US dollars, when the route reports one. */
  readonly usd?: number
}

/** Steady-state status a layer reports to its parent (§6.2). */
export type TaskStatus = 'done' | 'blocked' | 'failed'

/**
 * The failed-item report a layer sends up (§6.2). The report is the list
 * itself: a correction instruction is built from these items plus a direction,
 * so prose is never the payload.
 */
export interface TaskReport {
  /** The task the report belongs to. */
  readonly taskId: string
  readonly status: TaskStatus
  /** Every criterion whose result was not `passed`, in execution order. */
  readonly failed: readonly AcceptanceResult[]
  readonly cost?: TaskCost
}

/**
 * Where one acceptance run happens and where its results are recorded.
 *
 * `recordTo` is required: acceptance executed without a durable record could
 * not be re-read by the layer above, and R-2 acceptance exists precisely so
 * every layer can re-run it without trusting the layer below.
 */
export interface TaskRunContext {
  /** Absolute workspace root every criterion is resolved and executed against. */
  readonly workspace: string
  /** Task the criteria belong to; recorded with each result so the log attributes it. */
  readonly taskId: string
  /** Session receiving one `task/criterion` record per executed criterion. */
  readonly recordTo: Session
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * The acceptance contract a task was created with (§6.1), recorded the
     * moment the task exists so the criteria travel as durable data rather than
     * as prompt text, together with the task-tree path. Every layer re-reads
     * this record and re-runs the criteria against the workspace instead of
     * trusting the layer below, and no layer rewrites them.
     */
    'task/spec': {
      readonly taskId: string
      readonly title: string
      readonly parentPath: readonly string[]
      readonly acceptance: readonly AcceptanceCriterion[]
      readonly limits: TaskLimits
    }
    /**
     * One criterion's outcome, appended in execution order as the acceptance
     * run reaches it, so the durable log holds the same verdicts the run
     * returned and a replay folds them back into the identical result list.
     */
    'task/criterion': {
      readonly taskId: string
      /** Zero-based position in the run's criterion list. */
      readonly index: number
      readonly criterion: AcceptanceCriterion
      readonly status: AcceptanceStatus
      readonly detail: string
    }
    /**
     * The failed-item report a layer sent up (§6.2): the task's steady-state
     * status and every criterion whose result was not `passed`. The list, not a
     * summary of it, is what the parent turns into a correction instruction.
     */
    'task/report': {
      readonly taskId: string
      readonly status: TaskStatus
      readonly failed: readonly AcceptanceResult[]
      readonly cost?: TaskCost
    }
  }
}
