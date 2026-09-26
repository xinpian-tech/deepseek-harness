/**
 * Durable state of one task's candidate set: the file a later process reads to
 * learn which worktrees and branches a task already owns.
 *
 * The file is the authority for `list()`, so a service instance that never
 * created a candidate still reports the candidates another instance did. It is
 * replaced atomically, and an unreadable or unexpected document fails loud
 * instead of being treated as an empty candidate set.
 *
 * @module @dsh-fleet/worktree/store
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { Worktree } from './types.ts'

/** File name of one task's durable state inside its task directory. */
export const STATE_FILE = 'state.json'

/** Format version stamped on every task state document. */
export const STATE_VERSION = 1

/** Which candidate a task's evaluation accepted, and the branch publishing it. */
export interface TaskSelection {
  /** Index of the accepted candidate. */
  readonly index: number
  /** Branch the accepted commit was published under. */
  readonly branch: string
  /** Commit the candidate branch pointed at when it was accepted. */
  readonly commit: string
}

/** Durable state of one task: every live candidate plus the accepted one, if any. */
export interface TaskState {
  /** Format version of this document. */
  readonly version: typeof STATE_VERSION
  /** Task these candidates belong to. */
  readonly taskId: string
  /**
   * Branch prefix the candidates were created under. A deployment that changes
   * the prefix changes which branches a task means, so a mismatch refuses
   * instead of silently addressing different branches.
   */
  readonly branchPrefix: string
  /** Live candidates, ordered by index. */
  readonly candidates: readonly Worktree[]
  /** The accepted candidate, or `null` while the task has had no selection. */
  readonly selection: TaskSelection | null
}

/** Raised when a task's durable state is unreadable or holds an unexpected document. */
export class WorktreeStateError extends Error {
  /**
   * @param message - operator-facing description of the unusable state.
   */
  constructor(message: string) {
    super(message)
    this.name = 'WorktreeStateError'
  }
}

/**
 * The directory holding one task's worktrees and its state file.
 * @param worktreeRoot - absolute root of every task's candidate worktrees.
 * @param taskId - validated task id.
 * @returns the task's directory, which git creates when the first candidate is added.
 */
export function taskDirectory(worktreeRoot: string, taskId: string): string {
  return join(worktreeRoot, taskId)
}

/**
 * The directory name of one candidate inside its task directory.
 * @param index - non-negative candidate index.
 * @returns the directory name, stable for the candidate's lifetime.
 */
export function candidateDirectory(index: number): string {
  return `c${index}`
}

/**
 * Read one task's durable state.
 * @param file - absolute path of the task's state file.
 * @returns the recorded state, or undefined when the task has no state file yet.
 * @throws {WorktreeStateError} when the file exists but is not a valid state document.
 */
export async function readTaskState(file: string): Promise<TaskState | undefined> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    // A task with no state file simply has no candidates yet; every other read
    // failure is a medium fault the caller must see.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new WorktreeStateError(
      `task state ${file} is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return decodeTaskState(parsed, file)
}

/**
 * Replace one task's durable state.
 * @param file - absolute path of the task's state file; its directory is created.
 * @param state - the complete new state.
 * @returns resolution after the replacement is durable.
 */
export async function writeTaskState(file: string, state: TaskState): Promise<void> {
  await writeFileAtomic(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
}

/**
 * Validate one decoded state document.
 * @param value - the parsed JSON document.
 * @param where - path named in the error, for operators.
 * @returns the document as a {@link TaskState}.
 * @throws {WorktreeStateError} when a field is missing, mistyped, or of an unsupported version.
 */
export function decodeTaskState(value: unknown, where: string): TaskState {
  const record = requireRecord(value, where)
  const version = record['version']
  if (version !== STATE_VERSION) {
    throw new WorktreeStateError(`${where} holds state version ${String(version)}, expected ${STATE_VERSION}`)
  }
  const candidates = record['candidates']
  if (!Array.isArray(candidates)) throw new WorktreeStateError(`${where} field 'candidates' must be an array`)
  const selection = record['selection']
  return {
    version: STATE_VERSION,
    taskId: requireString(record, 'taskId', where),
    branchPrefix: requireString(record, 'branchPrefix', where),
    candidates: candidates.map((candidate, position) => decodeWorktree(candidate, `${where} candidates[${position}]`)),
    selection: selection === null ? null : decodeSelection(selection, `${where} selection`),
  }
}

/**
 * Validate one recorded candidate.
 * @param value - the decoded candidate.
 * @param where - path named in the error, for operators.
 * @returns the candidate as a {@link Worktree}.
 * @throws {WorktreeStateError} when a field is missing or mistyped.
 */
export function decodeWorktree(value: unknown, where: string): Worktree {
  const record = requireRecord(value, where)
  return {
    taskId: requireString(record, 'taskId', where),
    index: requireNumber(record, 'index', where),
    path: requireString(record, 'path', where),
    branch: requireString(record, 'branch', where),
    baseCommit: requireString(record, 'baseCommit', where),
    createdAt: requireNumber(record, 'createdAt', where),
  }
}

/**
 * Validate one recorded selection.
 * @param value - the decoded selection.
 * @param where - path named in the error, for operators.
 * @returns the selection as a {@link TaskSelection}.
 * @throws {WorktreeStateError} when a field is missing or mistyped.
 */
function decodeSelection(value: unknown, where: string): TaskSelection {
  const record = requireRecord(value, where)
  return {
    index: requireNumber(record, 'index', where),
    branch: requireString(record, 'branch', where),
    commit: requireString(record, 'commit', where),
  }
}

/**
 * Read one field as a JSON object.
 * @param value - the candidate value.
 * @param where - path named in the error, for operators.
 * @returns the value as a string-keyed record.
 * @throws {WorktreeStateError} when the value is not a plain object.
 */
function requireRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new WorktreeStateError(`${where} must be a JSON object`)
  }
  return value as Record<string, unknown>
}

/**
 * Read one required string field.
 * @param record - the object holding the field.
 * @param field - field name, named in the error.
 * @param where - path named in the error, for operators.
 * @returns the field value.
 * @throws {WorktreeStateError} when the field is absent or not a string.
 */
function requireString(record: Record<string, unknown>, field: string, where: string): string {
  const value = record[field]
  if (typeof value !== 'string') throw new WorktreeStateError(`${where} field '${field}' must be a string`)
  return value
}

/**
 * Read one required finite number field.
 * @param record - the object holding the field.
 * @param field - field name, named in the error.
 * @param where - path named in the error, for operators.
 * @returns the field value.
 * @throws {WorktreeStateError} when the field is absent or not a finite number.
 */
function requireNumber(record: Record<string, unknown>, field: string, where: string): number {
  const value = record[field]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new WorktreeStateError(`${where} field '${field}' must be a finite number`)
  }
  return value
}
