/**
 * The git primitive the archive plumbing is built from: one git subcommand
 * with no shell in between, and the two ways its exit status is read.
 *
 * The module holds no Cordis state, so the argument rules and the failure
 * classification are exercised without a context.
 *
 * @module @dsh-fleet/session-archive/git
 */

import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'

/** One git command's place in the world. */
export interface GitTarget {
  /** The subprocess seam to spawn through. */
  readonly subprocess: SubprocessRuntime
  /** Absolute path of the repository git runs against. */
  readonly repository: string
  /** Cancellation; aborts the git client process. */
  readonly signal?: AbortSignal | undefined
}

/** Raised when a git command the archive needs exited non-zero, or answered something unreadable. */
export class GitPlumbingError extends Error {
  /**
   * @param argv - arguments after the git executable, exactly as spawned.
   * @param repository - absolute repository the command ran in.
   * @param detail - the exit status and stderr, or the unusable answer.
   */
  constructor(
    readonly argv: readonly string[],
    readonly repository: string,
    detail: string,
  ) {
    super(`git ${argv.join(' ')} in ${repository} failed: ${detail}`)
    this.name = 'GitPlumbingError'
  }
}

/** In-memory cap for one captured git stream. */
const STREAM_LIMIT_BYTES = 1 << 20

/**
 * Termination grace for one git client process.
 *
 * Fixed rather than configurable: it bounds how long a stuck git client may
 * hold a turn open, and plumbing commands are local, so a client that outlives
 * it is a fault rather than a slow remote.
 */
const PLUMBING_GRACE_MS = 10_000

/**
 * Run one git command and return its stdout, or refuse.
 *
 * `input` is written to the command's stdin and the stream is closed, which is
 * what `hash-object --stdin` and `mktree` read. Arguments reach the process
 * seam verbatim — never through a shell — so a session id or archive path
 * containing shell metacharacters cannot change which git command runs.
 *
 * @param target - the repository and cancellation this command runs under.
 * @param argv - arguments after the git executable.
 * @param input - bytes written to stdin before it closes; defaults to none.
 * @returns the command's stdout, undecoded beyond UTF-8.
 * @throws {GitPlumbingError} when git exits non-zero or the provider collects no streams.
 */
export async function gitPlumbing(target: GitTarget, argv: readonly string[], input = ''): Promise<string> {
  const child = target.subprocess.spawn({
    argv: ['git', ...argv],
    cwd: target.repository,
    stdio: {
      stdin: { data: input },
      stdout: { maxBytes: STREAM_LIMIT_BYTES },
      stderr: { maxBytes: STREAM_LIMIT_BYTES },
    },
    graceMs: PLUMBING_GRACE_MS,
    signal: target.signal,
  })
  const exit = await child.done
  const stdout = child.collected.stdout
  const stderr = child.collected.stderr
  if (stdout === undefined || stderr === undefined) {
    // Both streams are requested in collect mode above, so a provider that
    // returned neither readers nor output would otherwise hide git's own text.
    throw new GitPlumbingError(argv, target.repository, 'the subprocess provider collected no output streams')
  }
  const text = stdout.readFrom(0).text
  if (exit.exitCode !== 0) {
    throw new GitPlumbingError(
      argv,
      target.repository,
      `${exit.exitCode === null ? 'killed by a signal' : `exit ${exit.exitCode}`}: ${stderr.readFrom(0).text.trim()}`,
    )
  }
  return text
}

/**
 * Run one git command whose failure is an ordinary answer.
 * @param target - the repository and cancellation this command runs under.
 * @param argv - arguments after the git executable.
 * @returns the trimmed stdout, or undefined when git exited non-zero.
 */
export async function gitOptional(target: GitTarget, argv: readonly string[]): Promise<string | undefined> {
  try {
    const value = (await gitPlumbing(target, argv)).trim()
    return value === '' ? undefined : value
  } catch (error) {
    if (error instanceof GitPlumbingError) return undefined
    throw error
  }
}
