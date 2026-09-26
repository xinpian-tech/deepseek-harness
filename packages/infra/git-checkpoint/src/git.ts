/**
 * The git primitive the checkpoint service is built from: one git subcommand
 * with no shell in between, and the two local reads phase 1 needs.
 *
 * The module is free of Cordis state, so the argument rules and the result
 * classification can be exercised without a context.
 *
 * @module @dsh-fleet/git-checkpoint/git
 */

import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'

/** Outcome of one git invocation. */
export interface GitResult {
  /** Process exit code; `null` when git died from a signal. */
  readonly code: number | null
  /** Captured stdout, decoded as UTF-8. */
  readonly stdout: string
  /** Captured stderr, decoded as UTF-8. */
  readonly stderr: string
}

/**
 * Raised when a git command this service ran exited non-zero.
 *
 * The repository, the failing command, and its stderr travel with the error,
 * because an operator needs to tell an unconfigured commit identity from a
 * remote that refuses a ref.
 */
export class GitCommandError extends Error {
  /**
   * @param repository - absolute repository the command ran in.
   * @param argv - arguments after the git executable, exactly as spawned.
   * @param code - process exit code; `null` when git died from a signal.
   * @param stderr - captured stderr, decoded as UTF-8.
   */
  constructor(
    readonly repository: string,
    readonly argv: readonly string[],
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(
      `git -C ${repository} ${argv.join(' ')} failed (${code === null ? 'killed by a signal' : `exit ${code}`}): ${stderr.trim()}`,
    )
    this.name = 'GitCommandError'
  }
}

/** In-memory cap for one captured git stream. */
const CAPTURE_BYTES = 1 << 20

/**
 * Termination grace for one git client process.
 *
 * Fixed rather than configurable: it bounds how long a stuck git client may
 * hold a turn open, and a push that outlives it is retried by the queue's own
 * policy rather than by extending this grace.
 */
const GIT_GRACE_MS = 10_000

/**
 * Run one git subcommand inside a repository and collect its output.
 *
 * `argv` reaches the process seam verbatim — never through a shell — so a ref
 * name, branch name, or commit message containing shell metacharacters cannot
 * change which git command runs.
 *
 * @param subprocess - the subprocess seam to spawn through.
 * @param argv - arguments after the git executable.
 * @param repository - absolute path of the repository git runs against.
 * @param signal - cancellation; aborts the git client process.
 * @returns the exit code and both captured streams.
 */
export async function runGit(
  subprocess: SubprocessRuntime,
  argv: readonly string[],
  repository: string,
  signal?: AbortSignal,
): Promise<GitResult> {
  const child = subprocess.spawn({
    argv: ['git', ...argv],
    cwd: repository,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: CAPTURE_BYTES },
      stderr: { maxBytes: CAPTURE_BYTES },
    },
    graceMs: GIT_GRACE_MS,
    signal,
  })
  const exit = await child.done
  const stdout = child.collected.stdout
  const stderr = child.collected.stderr
  if (stdout === undefined || stderr === undefined) {
    // Both streams are requested in collect mode above, so a provider that
    // returned neither readers nor output would otherwise hide git's own text.
    throw new Error(`git ${argv.join(' ')}: the subprocess provider collected no output streams`)
  }
  return { code: exit.exitCode, stdout: stdout.readFrom(0).text, stderr: stderr.readFrom(0).text }
}

/**
 * Run one git subcommand that must succeed.
 * @param subprocess - the subprocess seam to spawn through.
 * @param argv - arguments after the git executable.
 * @param repository - absolute path of the repository git runs against.
 * @param signal - cancellation; aborts the git client process.
 * @returns the successful invocation's captured stdout, without its trailing newline.
 * @throws {GitCommandError} when git exits non-zero or dies from a signal.
 */
export async function requireGit(
  subprocess: SubprocessRuntime,
  argv: readonly string[],
  repository: string,
  signal?: AbortSignal,
): Promise<string> {
  const result = await runGit(subprocess, argv, repository, signal)
  if (result.code !== 0) throw new GitCommandError(repository, argv, result.code, result.stderr)
  return result.stdout.trim()
}

/**
 * Run one local git read whose failure is an expected answer.
 * @param subprocess - the subprocess seam to spawn through.
 * @param argv - arguments after the git executable.
 * @param repository - absolute path of the repository git runs against.
 * @param signal - cancellation; aborts the git client process.
 * @returns the trimmed stdout, or undefined when git exited non-zero.
 */
export async function optionalGit(
  subprocess: SubprocessRuntime,
  argv: readonly string[],
  repository: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const result = await runGit(subprocess, argv, repository, signal)
  if (result.code !== 0) return undefined
  const value = result.stdout.trim()
  return value === '' ? undefined : value
}
