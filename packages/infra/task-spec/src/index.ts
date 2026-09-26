/**
 * `ctx.taskSpec` — the fleet's task contract (§6.1). A task is created
 * together with the acceptance criteria that decide it, and those criteria are
 * durable data rather than prompt text: they are recorded on the task's
 * session, re-read by every layer, and re-run against the workspace without
 * trusting the layer below.
 *
 * The service owns four things the rest of the fleet must not re-implement:
 * the §2.4 Nix template every generated acceptance set carries, the gate that
 * refuses a criterion a machine could not decide, the run that executes
 * criteria and returns one result per criterion, and the durable records that
 * carry a spec, its per-criterion outcomes, and the failed-item report into and
 * out of a session log.
 *
 * @module @dsh-fleet/task-spec
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve as resolvePath } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ShellRunResult } from '@deepseek-ai/dsh-shell'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { assertObjectJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { assertTaskSpec, nixAcceptanceTemplate, resolveWithin } from './criteria.ts'
import { CAPTURE_BYTES, changedLines, runGit } from './git.ts'
import type { GitCommandResult } from './git.ts'
import type {
  AcceptanceCriterion,
  AcceptanceResult,
  AcceptanceStatus,
  CommandCriterion,
  DiffCriterion,
  SchemaCriterion,
  TaskReport,
  TaskRunContext,
  TaskSpec,
} from './types.ts'

export type * from './types.ts'

/** Configuration of the task contract. */
export interface Config {
  /**
   * Project test command the `nix develop -c` acceptance criterion runs when a
   * caller passes none to {@link TaskSpecService.nixAcceptance}.
   */
  defaultTestCommand?: string
  /** Deadline in milliseconds for one criterion (default 600000). */
  defaultTimeoutMs?: number
  /** Largest number of criteria one spec may carry (default 64). */
  maxCriteria?: number
  /**
   * Absolute workspace root a `schema` criterion must stay inside. A relative
   * value resolves against the harness launch directory once, at load; absent
   * uses that launch directory.
   */
  workspaceRoot?: string
}

/** Deadline applied to a criterion that carries none. */
const DEFAULT_TIMEOUT_MS = 600_000

/** Bound on how many criteria one spec may carry. */
const DEFAULT_MAX_CRITERIA = 64

/** Longest stdout or stderr excerpt one failed command result carries. */
const EVIDENCE_CHARS = 400

/** Most schema violations one failed result lists before it summarizes the rest. */
const VIOLATIONS_SHOWN = 5

/** The configuration after defaults, with the workspace root resolved once. */
export interface ResolvedConfig {
  readonly defaultTestCommand: string | undefined
  readonly defaultTimeoutMs: number
  readonly maxCriteria: number
  readonly workspaceRoot: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    taskSpec: TaskSpecService
  }
}

/** The task contract service. */
export default class TaskSpecService extends Service {
  static inject = ['shell', 'subprocess']

  /**
   * Config schema a deployment's configuration is validated against, with the
   * timer bound Node accepts so a stored deadline cannot outlive the runtime.
   */
  static Config: z<Config> = z.object({
    defaultTestCommand: z.string(),
    defaultTimeoutMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_TIMEOUT_MS),
    maxCriteria: z.natural().min(1).default(DEFAULT_MAX_CRITERIA),
    workspaceRoot: z.string(),
  })

  private readonly config: ResolvedConfig

  /**
   * @param ctx - owning context; `shell` and `subprocess` must be available.
   * @param config - authored plugin configuration, validated here so a
   * misconfigured deployment fails at load rather than at the first
   * acceptance run.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'taskSpec')
    this.config = resolveConfig(config)
  }

  /**
   * The §2.4 acceptance template every generated set carries.
   * @param testCommand - project test command for the third criterion; absent
   *   or blank uses the configured `defaultTestCommand`.
   * @returns `nix flake check`, `nix build .#default`, and `nix develop -c <testCommand>`, in that order.
   * @throws {TypeError} when neither this argument nor `defaultTestCommand` names a command.
   */
  nixAcceptance(testCommand?: string): AcceptanceCriterion[] {
    const command = testCommand === undefined || testCommand.trim().length === 0
      ? this.config.defaultTestCommand
      : testCommand
    if (command === undefined) {
      throw new TypeError('@dsh-fleet/task-spec nixAcceptance needs a project test command or a configured defaultTestCommand')
    }
    return nixAcceptanceTemplate(command)
  }

  /**
   * Refuse a spec this service could not decide.
   *
   * The gate runs before a spec is recorded, so no task enters the tree with a
   * criterion no layer can evaluate.
   *
   * @param spec - the candidate task contract.
   * @throws {TypeError} naming the offending field; see {@link assertTaskSpec}.
   */
  validate(spec: TaskSpec): void {
    assertTaskSpec(spec, { maxCriteria: this.config.maxCriteria, workspaceRoot: this.config.workspaceRoot })
  }

  /**
   * Execute every criterion against the workspace and decide it.
   *
   * Results come back one per criterion in the criteria's own order, and each
   * one is recorded on the session as it is decided, so the layer above re-reads
   * the same verdicts from the durable log. A criterion that cannot be attempted
   * — a target outside the workspace root, an unreadable file, a failed git
   * invocation — is an `error` result rather than a thrown failure, and a
   * command's nonzero exit is a `failed` result carrying the observed status.
   * Only a rejection from the shell seam itself escapes.
   *
   * @param criteria - the criteria to execute, normally a validated spec's `acceptance`.
   * @param context - workspace root, task id, and the session receiving the records.
   * @returns one result per criterion, in the criteria's order.
   */
  async run(criteria: readonly AcceptanceCriterion[], context: TaskRunContext): Promise<AcceptanceResult[]> {
    const results: AcceptanceResult[] = []
    for (const [index, criterion] of criteria.entries()) {
      const result = await this.execute(criterion, context)
      context.recordTo.append('task/criterion', {
        taskId: context.taskId,
        index,
        criterion,
        status: result.status,
        detail: result.detail,
      })
      results.push(result)
    }
    return results
  }

  /**
   * Record a task's acceptance contract on its session.
   *
   * The `task/spec` record is what carries the criteria and the task-tree path
   * into the child session's bootstrap context as durable data: a later reader
   * reconstructs the exact spec, and no layer rewrites it.
   *
   * @param session - session that owns the task's history.
   * @param spec - the validated task contract; see {@link validate}.
   * @throws {TypeError} naming the offending field when the spec is not decidable.
   */
  attach(session: Session, spec: TaskSpec): void {
    this.validate(spec)
    session.append('task/spec', {
      taskId: spec.id,
      title: spec.title,
      parentPath: spec.parentPath,
      acceptance: spec.acceptance,
      limits: spec.limits,
    })
  }

  /**
   * Record a failed-item report on the session that owns the task.
   * @param session - session that owns the task's history.
   * @param report - the task's status, its failed items, and its cost when known.
   */
  report(session: Session, report: TaskReport): void {
    session.append('task/report', {
      taskId: report.taskId,
      status: report.status,
      failed: report.failed,
      ...report.cost === undefined ? {} : { cost: report.cost },
    })
  }

  /**
   * Decide one criterion, turning every failure it can meet into a result.
   * @param criterion - the criterion to execute.
   * @param context - workspace root, task id, and recording session.
   * @returns the criterion's result; never rejects for the criterion's own failure.
   */
  private async execute(criterion: AcceptanceCriterion, context: TaskRunContext): Promise<AcceptanceResult> {
    try {
      switch (criterion.kind) {
        case 'command':
          return await this.runCommand(criterion, context)
        case 'schema':
          return await this.checkSchema(criterion, context)
        case 'diff':
          return await this.checkDiff(criterion, context)
        /* v8 ignore next -- AcceptanceCriterion is a closed union; the default keeps compile-time exhaustiveness. */
        default:
          return assertNever(criterion, 'AcceptanceCriterion')
      }
    } catch (error) {
      // A criterion that cannot be attempted stays a visible item instead of
      // aborting the run: the caller keeps one result per criterion and the
      // durable record keeps the reason.
      return outcome(criterion, 'error', renderThrown(error))
    }
  }

  /**
   * Run one command criterion through the shell seam under its own deadline.
   * @param criterion - the command criterion.
   * @param context - workspace root the command runs in.
   * @returns the pass or fail verdict with the observed exit status.
   */
  private async runCommand(criterion: CommandCriterion, context: TaskRunContext): Promise<AcceptanceResult> {
    const spec = this.ctx.shell.resolve({
      command: criterion.run,
      workdir: context.workspace,
      timeoutMs: criterion.expect.timeoutMs ?? this.config.defaultTimeoutMs,
    })
    const result: ShellRunResult = await (await this.ctx.shell.execute(spec)).result()
    if (result.timedOut) {
      return outcome(criterion, 'failed', `command did not finish within ${String(result.timeoutMs)} ms`)
    }
    if (result.exitCode !== criterion.expect.exitCode) {
      return outcome(criterion, 'failed', `exit status ${String(result.exitCode)}, expected ${String(criterion.expect.exitCode)}${evidence(result)}`)
    }
    const pattern = criterion.expect.stdoutMatches
    if (pattern !== undefined) {
      if (result.stdout.truncated) {
        // A pattern matched against a truncated stream would decide on output
        // the command did not necessarily produce.
        return outcome(criterion, 'error', 'stdout exceeded the executor capture cap, so the pattern cannot be matched')
      }
      if (!new RegExp(pattern).test(result.stdout.text)) {
        return outcome(criterion, 'failed', `stdout did not match /${pattern}/`)
      }
    }
    return outcome(criterion, 'passed', `exit status ${String(criterion.expect.exitCode)}`)
  }

  /**
   * Validate one workspace file against its criterion's schema.
   * @param criterion - the schema criterion.
   * @param context - workspace root the target resolves against.
   * @returns the verdict; a missing, unparsable, or violating target fails.
   * @throws {TypeError} when the target escapes the workspace root; a criterion
   *   whose own schema is outside the enforced subset is refused before any read.
   */
  private async checkSchema(criterion: SchemaCriterion, context: TaskRunContext): Promise<AcceptanceResult> {
    const target = resolveWithin(context.workspace, criterion.target, 'acceptance.target')
    assertObjectJsonSchema(criterion.schema)
    let text: string
    try {
      text = await readFile(target, 'utf8')
    } catch (error) {
      if (!isMissingFile(error)) throw error
      return outcome(criterion, 'failed', `target file does not exist: ${criterion.target}`)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      return outcome(criterion, 'failed', `target is not valid JSON: ${renderThrown(error)}`)
    }
    const violations = validateJsonSchemaValue(criterion.schema, parsed, criterion.target)
    if (violations.length > 0) return outcome(criterion, 'failed', `target violates the schema: ${summarize(violations)}`)
    return outcome(criterion, 'passed', `${criterion.target} satisfies the schema`)
  }

  /**
   * Count the changed lines one scope reports in the workspace repository.
   * @param criterion - the diff criterion.
   * @param context - workspace root holding the git repository.
   * @returns the verdict with both the observed and the allowed line count.
   */
  private async checkDiff(criterion: DiffCriterion, context: TaskRunContext): Promise<AcceptanceResult> {
    const command: GitCommandResult = await this.git(
      context.workspace,
      ['diff', '--numstat', '--no-renames', 'HEAD', '--', criterion.scope],
    )
    if (command.code !== 0) {
      return outcome(criterion, 'error', `git diff failed with ${String(command.code)}: ${excerpt(command.stderr)}`)
    }
    if (command.truncated) {
      return outcome(criterion, 'error', `git diff output exceeded the ${String(CAPTURE_BYTES)}-byte capture cap, so the changed line count is undecided`)
    }
    const lines = changedLines(command.stdout)
    if (lines > criterion.maxLines) {
      return outcome(criterion, 'failed', `scope ${criterion.scope} changed ${String(lines)} lines, over maxLines ${String(criterion.maxLines)}`)
    }
    return outcome(criterion, 'passed', `scope ${criterion.scope} changed ${String(lines)} of ${String(criterion.maxLines)} allowed lines`)
  }

  /**
   * Run one git subcommand under the configured deadline.
   * @param workspace - working directory of the git invocation.
   * @param args - arguments after the `git` executable.
   * @returns the exit code and captured streams.
   */
  private async git(workspace: string, args: readonly string[]): Promise<GitCommandResult> {
    const deadline = new AbortController()
    const timer = setTimeout(() => {
      deadline.abort()
    }, this.config.defaultTimeoutMs)
    try {
      return await runGit(this.ctx.subprocess, workspace, args, this.config.defaultTimeoutMs, deadline.signal)
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * Build one criterion result.
 * @param criterion - the criterion the result decides.
 * @param status - the verdict.
 * @param detail - observed evidence for the verdict.
 * @returns the immutable result.
 */
function outcome(criterion: AcceptanceCriterion, status: AcceptanceStatus, detail: string): AcceptanceResult {
  return { criterion, status, detail }
}

/**
 * Render a thrown value to one line.
 * @param error - any value thrown while deciding a criterion.
 * @returns the error message, or the value's string form.
 */
function renderThrown(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Bound one diagnostic excerpt.
 * @param text - captured process output.
 * @returns the last {@link EVIDENCE_CHARS} characters, trimmed.
 */
function excerpt(text: string): string {
  return text.trim().slice(-EVIDENCE_CHARS)
}

/**
 * The stderr a failed command left behind, as a detail suffix.
 * @param result - the settled shell result.
 * @returns an empty string when the command wrote no stderr.
 */
function evidence(result: ShellRunResult): string {
  const text = excerpt(result.stderr.text)
  return text.length === 0 ? '' : `; stderr: ${text}`
}

/**
 * Bound a schema violation list.
 * @param violations - path-qualified violations in walk order.
 * @returns the first {@link VIOLATIONS_SHOWN} violations, with the remainder counted.
 */
function summarize(violations: readonly string[]): string {
  const shown = violations.slice(0, VIOLATIONS_SHOWN)
  const rest = violations.length - shown.length
  return `${shown.join('; ')}${rest === 0 ? '' : ` (+${String(rest)} more)`}`
}

/**
 * Whether a filesystem failure means the file is simply not there.
 * @param error - any value thrown by the file read.
 * @returns true for a missing-file failure.
 */
function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT'
}

/**
 * Apply the schema's defaults and validate the paths this service depends on.
 *
 * A misconfigured deployment must fail here — at load, once — rather than at
 * the first acceptance run, when the failure would look like a task fault.
 *
 * @param config - authored plugin configuration.
 * @returns the validated configuration with the workspace root resolved.
 * @throws {ValidationError} when a bound falls outside the schema's range.
 * @throws {TypeError} when a configured test command is blank, or when the
 *   resolved workspace root does not exist.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const resolved = TaskSpecService.Config(config)
  const testCommand = resolved.defaultTestCommand?.trim()
  if (testCommand !== undefined && testCommand.length === 0) {
    throw new TypeError('@dsh-fleet/task-spec defaultTestCommand must name a command when configured')
  }
  // A relative root resolves against the harness launch directory once, at
  // load, so no later call depends on the process's mutable cwd.
  const workspaceRoot = resolvePath(resolved.workspaceRoot ?? process.cwd())
  if (!existsSync(workspaceRoot)) {
    throw new TypeError(`@dsh-fleet/task-spec workspaceRoot does not exist: ${workspaceRoot}`)
  }
  return {
    defaultTestCommand: testCommand,
    defaultTimeoutMs: resolved.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxCriteria: resolved.maxCriteria ?? DEFAULT_MAX_CRITERIA,
    workspaceRoot,
  }
}
