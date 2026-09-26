/**
 * The git primitive the worktree service is built from: one git subcommand
 * with no shell in between, the typed failure a non-zero exit raises, and the
 * parser for the one listing the reuse rule reads.
 *
 * Both are free of Cordis state, so the argument rules and the listing parser
 * can be tested without a Cordis context.
 *
 * @module @dsh-fleet/worktree/git
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

/** One worktree registration reported by `git worktree list --porcelain`. */
export interface WorktreeRegistration {
  /** Absolute path git reports for the worktree. */
  readonly path: string
  /** Commit the registration was last observed at, or `null` when git reported none. */
  readonly head: string | null
  /** Branch name without its `refs/heads/` prefix; `null` for a detached checkout. */
  readonly branch: string | null
  /**
   * `true` when git reports the worktree as prunable, which means its directory
   * is gone: the registration survives but there is no checkout behind it.
   */
  readonly prunable: boolean
}

/** In-memory cap for one captured git stream. */
const CAPTURE_BYTES = 1 << 20

/**
 * Raised when a git command this service ran exited non-zero.
 *
 * The failing command and its stderr travel with the error, because both are
 * what an operator needs to tell a missing repository from a branch that is
 * already checked out somewhere else.
 */
export class GitCommandError extends Error {
  /**
   * @param argv - arguments after the git executable, exactly as spawned.
   * @param code - process exit code; `null` when git died from a signal.
   * @param stderr - captured stderr, decoded as UTF-8.
   */
  constructor(
    readonly argv: readonly string[],
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(`git ${argv.join(' ')} failed (${code === null ? 'signal' : `exit ${code}`}): ${stderr.trim()}`)
    this.name = 'GitCommandError'
  }
}

/**
 * Run one git subcommand and collect its output.
 *
 * `argv` reaches the process seam verbatim — never through a shell — so a task
 * id, branch name, or path containing shell metacharacters cannot change which
 * git command runs.
 *
 * @param subprocess - the subprocess seam to spawn through.
 * @param gitBin - git executable to run.
 * @param argv - arguments after the executable.
 * @param cwd - working directory of the git invocation.
 * @param graceMs - termination grace period for the git process.
 * @returns the exit code and both captured streams.
 */
export async function runGit(
  subprocess: SubprocessRuntime,
  gitBin: string,
  argv: readonly string[],
  cwd: string,
  graceMs: number,
): Promise<GitResult> {
  const handle = subprocess.spawn({
    argv: [gitBin, ...argv],
    cwd,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: CAPTURE_BYTES },
      stderr: { maxBytes: CAPTURE_BYTES },
    },
    graceMs,
  })
  const outcome = await handle.done
  const stdout = handle.collected.stdout
  const stderr = handle.collected.stderr
  if (stdout === undefined || stderr === undefined) {
    // Both streams are requested in collect mode above, so a provider that
    // returns neither readers nor output would otherwise hide git's failure text.
    throw new Error(`git ${argv.join(' ')}: the subprocess provider collected no output streams`)
  }
  return {
    code: outcome.exitCode,
    stdout: stdout.readFrom(0).text,
    stderr: stderr.readFrom(0).text,
  }
}

/**
 * Run one git subcommand that must succeed.
 * @param subprocess - the subprocess seam to spawn through.
 * @param gitBin - git executable to run.
 * @param argv - arguments after the executable.
 * @param cwd - working directory of the git invocation.
 * @param graceMs - termination grace period for the git process.
 * @returns the successful invocation's captured output.
 * @throws {GitCommandError} when git exits non-zero.
 */
export async function requireGit(
  subprocess: SubprocessRuntime,
  gitBin: string,
  argv: readonly string[],
  cwd: string,
  graceMs: number,
): Promise<GitResult> {
  const result = await runGit(subprocess, gitBin, argv, cwd, graceMs)
  if (result.code !== 0) throw new GitCommandError(argv, result.code, result.stderr)
  return result
}

/**
 * Parse `git worktree list --porcelain` output.
 *
 * Each worktree is one block of `key value` lines ended by a blank line; only
 * the fields the reuse rule reads are kept. An unrecognized line is ignored, so
 * a git version that adds summary lines cannot break the listing.
 *
 * @param stdout - the command's captured stdout.
 * @returns one registration per block, in git's reported order.
 */
export function parseWorktreeList(stdout: string): WorktreeRegistration[] {
  const registrations: WorktreeRegistration[] = []
  let path: string | undefined
  let head: string | null = null
  let branch: string | null = null
  let prunable = false

  const flush = (): void => {
    if (path === undefined) return
    registrations.push({ path, head, branch, prunable })
    path = undefined
    head = null
    branch = null
    prunable = false
  }

  for (const line of stdout.split('\n')) {
    if (line.trim().length === 0) {
      flush()
      continue
    }
    if (line.startsWith('worktree ')) {
      path = line.slice('worktree '.length)
      continue
    }
    if (line.startsWith('HEAD ')) {
      head = line.slice('HEAD '.length)
      continue
    }
    if (line.startsWith('branch ')) {
      const ref = line.slice('branch '.length)
      branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref
      continue
    }
    if (line === 'prunable' || line.startsWith('prunable ')) prunable = true
  }
  flush()
  return registrations
}
