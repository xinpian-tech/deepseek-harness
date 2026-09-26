/**
 * The rules `ctx.taskSpec` decides with, kept free of Cordis state so each rule
 * is testable without a live composition: the §2.4 Nix template, the
 * machine-decidability gate, and workspace path containment.
 *
 * @module @dsh-fleet/task-spec/criteria
 */

import { isAbsolute, relative, resolve, sep } from 'node:path'
import { JsonSchemaError, assertObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { AcceptanceCriterion, CommandCriterion, DiffCriterion, SchemaCriterion, TaskSpec } from './types.ts'

/** The configured bounds a spec is decided against. */
export interface AcceptanceLimits {
  /** Largest number of criteria one spec may carry. */
  readonly maxCriteria: number
  /** Absolute workspace root every `schema` target must stay inside. */
  readonly workspaceRoot: string
}

/**
 * The §2.4 acceptance template every generated set carries.
 *
 * Nix is the dependency decision a machine can always make, so the three
 * commands are fixed and ordered: the flake must evaluate, the default output
 * must build, and the project's own test command must run inside the flake
 * environment. A project without a flake therefore fails the task with no
 * subjective judgement.
 *
 * @param testCommand - the project test command run as `nix develop -c <testCommand>`.
 * @returns the three criteria in evaluation order.
 * @throws {TypeError} when the test command is empty.
 */
export function nixAcceptanceTemplate(testCommand: string): AcceptanceCriterion[] {
  if (testCommand.trim().length === 0) {
    throw new TypeError('nix acceptance requires a non-empty project test command')
  }
  return [
    { kind: 'command', run: 'nix flake check', expect: { exitCode: 0 } },
    { kind: 'command', run: 'nix build .#default', expect: { exitCode: 0 } },
    { kind: 'command', run: `nix develop -c ${testCommand}`, expect: { exitCode: 0 } },
  ]
}

/**
 * Refuse a spec a machine could not decide.
 *
 * Every rejection is a `TypeError` naming the offending field, so a caller
 * that generated a spec learns which field it must fix and a task can never
 * enter the tree with a criterion no layer can evaluate.
 *
 * @param spec - the candidate task contract.
 * @param limits - the configured criterion bound and workspace root.
 * @throws {TypeError} naming the offending field for an empty id or title, an
 *   empty or oversized acceptance list, an undecidable criterion, or a
 *   nonpositive round limit.
 */
export function assertTaskSpec(spec: TaskSpec, limits: AcceptanceLimits): void {
  if (spec.id.trim().length === 0) throw new TypeError('TaskSpec.id must be a non-empty task identifier')
  if (spec.title.trim().length === 0) throw new TypeError('TaskSpec.title must be a non-empty task title')
  if (spec.acceptance.length === 0) {
    throw new TypeError('TaskSpec.acceptance must carry at least one criterion; a task without acceptance cannot be judged')
  }
  if (spec.acceptance.length > limits.maxCriteria) {
    throw new TypeError(
      `TaskSpec.acceptance carries ${String(spec.acceptance.length)} criteria, over the configured maxCriteria of ${String(limits.maxCriteria)}`,
    )
  }
  spec.acceptance.forEach((criterion, index) => {
    assertCriterion(criterion, `TaskSpec.acceptance[${String(index)}]`, limits.workspaceRoot)
  })
  assertRounds(spec.limits.reworkRounds, 'TaskSpec.limits.reworkRounds')
  assertRounds(spec.limits.deepenRounds, 'TaskSpec.limits.deepenRounds')
}

/**
 * Resolve a workspace-relative target and refuse one that leaves the root.
 *
 * Containment is decided on the resolved path, so `a/../../b` is refused for
 * the same reason an absolute path is: the criterion would otherwise read or
 * judge state outside the workspace it was accepted against.
 *
 * @param root - absolute workspace root.
 * @param target - workspace-relative path from the criterion.
 * @param field - field path used in the rejection message.
 * @returns the absolute path of the target inside the root.
 * @throws {TypeError} naming `field` when the target is empty, absolute, or escapes the root.
 */
export function resolveWithin(root: string, target: string, field: string): string {
  if (target.length === 0) throw new TypeError(`${field} must be a non-empty workspace-relative path`)
  if (isAbsolute(target)) {
    throw new TypeError(`${field} must be relative to the workspace root, got ${JSON.stringify(target)}`)
  }
  const resolved = resolve(root, target)
  const inside = relative(root, resolved)
  if (inside === '..' || inside.startsWith(`..${sep}`)) {
    throw new TypeError(`${field} escapes the workspace root ${root}: ${JSON.stringify(target)}`)
  }
  return resolved
}

/**
 * Decide one criterion's decidable fields.
 * @param criterion - the candidate criterion.
 * @param field - field path of the criterion inside its spec.
 * @param workspaceRoot - absolute workspace root a `schema` target must stay inside.
 * @throws {TypeError} naming the offending field.
 */
function assertCriterion(criterion: AcceptanceCriterion, field: string, workspaceRoot: string): void {
  switch (criterion.kind) {
    case 'command':
      assertCommand(criterion, field)
      return
    case 'schema':
      assertSchema(criterion, field, workspaceRoot)
      return
    case 'diff':
      assertDiff(criterion, field)
      return
    /* v8 ignore next -- AcceptanceCriterion is a closed union; the default keeps compile-time exhaustiveness. */
    default:
      assertNever(criterion, 'AcceptanceCriterion')
  }
}

/**
 * Decide a command criterion: a command to run, an exit status to compare, an
 * optional stdout pattern to compile, and an optional deadline to arm.
 * @param criterion - the candidate command criterion.
 * @param field - field path of the criterion inside its spec.
 * @throws {TypeError} naming the offending field.
 */
function assertCommand(criterion: CommandCriterion, field: string): void {
  if (criterion.run.trim().length === 0) throw new TypeError(`${field}.run must be a non-empty command line`)
  if (!Number.isSafeInteger(criterion.expect.exitCode)) {
    throw new TypeError(`${field}.expect.exitCode must be a whole exit status, got ${String(criterion.expect.exitCode)}`)
  }
  const pattern = criterion.expect.stdoutMatches
  if (pattern !== undefined && !compiles(pattern)) {
    throw new TypeError(`${field}.expect.stdoutMatches must be a compilable regular expression, got ${JSON.stringify(pattern)}`)
  }
  const timeoutMs = criterion.expect.timeoutMs
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)) {
    throw new TypeError(`${field}.expect.timeoutMs must be a positive whole number of milliseconds, got ${String(timeoutMs)}`)
  }
}

/**
 * Decide a schema criterion: a target inside the workspace root and a schema
 * inside the enforced object-rooted subset.
 * @param criterion - the candidate schema criterion.
 * @param field - field path of the criterion inside its spec.
 * @param workspaceRoot - absolute workspace root the target must stay inside.
 * @throws {TypeError} naming the offending field.
 */
function assertSchema(criterion: SchemaCriterion, field: string, workspaceRoot: string): void {
  resolveWithin(workspaceRoot, criterion.target, `${field}.target`)
  try {
    assertObjectJsonSchema(criterion.schema)
  } catch (error) {
    if (error instanceof JsonSchemaError) throw new TypeError(`${field}.schema is outside the supported subset: ${error.message}`)
    throw error
  }
}

/**
 * Decide a diff criterion: a pathspec to match and a positive line bound.
 * @param criterion - the candidate diff criterion.
 * @param field - field path of the criterion inside its spec.
 * @throws {TypeError} naming the offending field.
 */
function assertDiff(criterion: DiffCriterion, field: string): void {
  if (criterion.scope.trim().length === 0) throw new TypeError(`${field}.scope must be a non-empty git pathspec`)
  if (!Number.isSafeInteger(criterion.maxLines) || criterion.maxLines <= 0) {
    throw new TypeError(`${field}.maxLines must be a positive whole number of lines, got ${String(criterion.maxLines)}`)
  }
}

/**
 * Decide one round budget.
 * @param rounds - the candidate round count.
 * @param field - field path of the limit inside its spec.
 * @throws {TypeError} when the budget is not a positive whole number.
 */
function assertRounds(rounds: number, field: string): void {
  if (!Number.isSafeInteger(rounds) || rounds <= 0) {
    throw new TypeError(`${field} must be a positive whole number of rounds, got ${String(rounds)}`)
  }
}

/**
 * Whether a stdout pattern can decide a match at all.
 * @param pattern - regular-expression source from a command criterion.
 * @returns true when the pattern compiles.
 */
function compiles(pattern: string): boolean {
  try {
    return new RegExp(pattern).test('')
  } catch {
    // An uncompilable pattern can never decide a criterion; the caller names it.
    return false
  }
}
