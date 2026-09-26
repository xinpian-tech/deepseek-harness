/**
 * The one git interaction a `diff` criterion needs: run a subcommand through
 * the subprocess seam, and total the changed lines git reports for it.
 *
 * Git runs as a direct child process with its arguments as an argv, never
 * through a shell, so a criterion's `scope` reaches git as one pathspec and
 * cannot become a second command.
 *
 * @module @dsh-fleet/task-spec/git
 */

import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'

/** Outcome of one git subcommand. */
export interface GitCommandResult {
  /** Process exit code; null when the process died from a signal or before it started. */
  readonly code: number | null
  /** Captured stdout, decoded as UTF-8. */
  readonly stdout: string
  /** Captured stderr, decoded as UTF-8. */
  readonly stderr: string
  /** True when a captured stream lost bytes, so its text cannot decide a criterion. */
  readonly truncated: boolean
}

/**
 * In-memory cap for one captured git stream. A numstat record is one line per
 * changed file, so the cap covers thousands of changed files — far above any
 * scope bound a task carries — while keeping a runaway diff out of memory.
 */
export const CAPTURE_BYTES = 64 * 1024

/**
 * Run one git subcommand in a workspace and collect its output.
 * @param subprocess - the subprocess seam to spawn through.
 * @param workspace - working directory of the git invocation.
 * @param args - arguments after the `git` executable.
 * @param graceMs - termination grace period for the git process.
 * @param signal - caller-owned deadline.
 * @returns the exit code and both captured streams.
 */
export async function runGit(
  subprocess: SubprocessRuntime,
  workspace: string,
  args: readonly string[],
  graceMs: number,
  signal: AbortSignal,
): Promise<GitCommandResult> {
  const handle = subprocess.spawn({
    argv: ['git', ...args],
    cwd: workspace,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: CAPTURE_BYTES },
      stderr: { maxBytes: CAPTURE_BYTES },
    },
    graceMs,
    signal,
  })
  const outcome = await handle.done
  // A collect-mode spawn always publishes a reader for each collected stream,
  // but the handle types keep them optional; a missing reader is reported as
  // empty output rather than aborting the acceptance run.
  const stdout = handle.collected.stdout?.readFrom(0)
  const stderr = handle.collected.stderr?.readFrom(0)
  return {
    code: outcome.exitCode,
    stdout: stdout?.text ?? '',
    stderr: stderr?.text ?? '',
    truncated: (stdout?.lossy ?? false) || (stderr?.lossy ?? false),
  }
}

/**
 * Total the changed lines in `git diff --numstat` output.
 *
 * One record per changed file carries its added and deleted counts; a binary
 * file reports `-` for both and contributes no line count. A record that does
 * not parse means the output was cut short, which would undercount, so it is
 * refused rather than summed.
 *
 * @param numstat - complete stdout of `git diff --numstat`.
 * @returns the added plus deleted line count.
 * @throws {TypeError} when a record or count field is malformed.
 */
export function changedLines(numstat: string): number {
  let total = 0
  for (const record of numstat.split('\n')) {
    if (record.length === 0) continue
    const fields = record.split('\t')
    const added = fields[0]
    const deleted = fields[1]
    if (added === undefined || deleted === undefined) {
      throw new TypeError(`malformed numstat record: ${JSON.stringify(record)}`)
    }
    total += countField(added) + countField(deleted)
  }
  return total
}

/**
 * Read one numstat count field.
 * @param field - the added or deleted column of one record.
 * @returns the line count, or zero for the `-` git writes for a binary file.
 * @throws {TypeError} when the field is neither a count nor the binary marker.
 */
function countField(field: string): number {
  if (field === '-') return 0
  if (!/^\d+$/.test(field)) throw new TypeError(`malformed numstat count: ${JSON.stringify(field)}`)
  return Number.parseInt(field, 10)
}
