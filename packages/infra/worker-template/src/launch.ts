/**
 * Pure construction of one worker pane's launch contract: the command line the
 * pane execs, the environment entries the pane receives, and the quoting that
 * stops a hostile path from changing that command.
 *
 * Both builders are pure and exported so the launch contract can be asserted,
 * and reviewed, without a tmux server and without a placed pane.
 *
 * @module @dsh-fleet/worker-template/launch
 */

/**
 * Quote one value for a POSIX shell single-quoted word.
 *
 * Every path handed to a pane passes through this function: a workspace
 * directory containing a space, a quote, a `$`, or a newline must reach the
 * shell as one unchanged word, because the launch line is written into a live
 * pane and anything the shell re-parses could run a different command.
 *
 * @param value - arbitrary text.
 * @returns the value wrapped so a POSIX shell reproduces it byte for byte.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/** The harness invocation a worker pane execs. */
export interface WorkerLaunchSpec {
  /** Harness executable, a path on most deployments. */
  readonly dshBin: string
  /** Profile the worker harness runs (`sdk` unless a deployment says otherwise). */
  readonly profile: string
  /** Profile patch files handed to the worker harness, in order. */
  readonly patches: readonly string[]
}

/**
 * Build the exact command line a worker pane runs.
 *
 * The composed channel hands this line to tmux as the pane's command at window
 * creation, so the line owns the tty setup as well as the harness invocation:
 * `stty -echo -icanon` must run in the same shell that execs the harness, and a
 * pane left echoing would return its own request frames as answers (§5.3). The
 * same placement carries the environment entries this package reports beside
 * the line.
 *
 * @param spec - harness executable, profile, and ordered patch files.
 * @returns the command line, with every value quoted as one shell word.
 */
export function buildLaunchLine(spec: WorkerLaunchSpec): string {
  return [
    'stty -echo -icanon;',
    'exec',
    shellQuote(spec.dshBin),
    '--profile',
    shellQuote(spec.profile),
    ...spec.patches.flatMap(patch => ['--patch', shellQuote(patch)]),
  ].join(' ')
}

/** Whether one configured credential variable is present in the launching process. */
export interface CredentialPresence {
  /** Environment variable name. */
  readonly name: string
  /** Whether the launching process holds a non-empty value for it; the value is never reported. */
  readonly present: boolean
}

/** Inputs of the pane's environment assembly. */
export interface PaneEnvRequest {
  /** Absolute harness home the pane runs with. */
  readonly dshHome: string
  /** Credential-shaped variables forwarded explicitly when present. */
  readonly credentialEnv: readonly string[]
  /** Explicit name/value pairs layered over everything else. */
  readonly extraEnv: Readonly<Record<string, string>>
  /** Environment of the launching process, read but never mutated. */
  readonly env: Readonly<Record<string, string | undefined>>
}

/** Result of one pane environment assembly. */
export interface ResolvedPaneEnv {
  /** Entries handed to the pane, in insertion order. */
  readonly env: Readonly<Record<string, string>>
  /** Configured credential variables absent from the launching environment. */
  readonly missing: readonly string[]
}

/**
 * Assemble the environment entries a pane receives.
 *
 * dsh strips credential-shaped variables when it spawns an out-of-process
 * child, so these entries are the ONLY way the worker's own nested harness
 * reaches a model provider (§8.2). A variable the launching process does not
 * hold is reported as missing and omitted: passing it as an empty string would
 * turn "not configured here" into an authentication failure inside the worker.
 *
 * @param request - harness home, credential allowlist, explicit pairs, and the launching environment.
 * @returns the entries to hand the pane plus every configured credential that was absent.
 */
export function resolvePaneEnv(request: PaneEnvRequest): ResolvedPaneEnv {
  const env: Record<string, string> = { DSH_HOME: request.dshHome }
  const missing: string[] = []
  for (const name of request.credentialEnv) {
    const value = request.env[name]
    if (value === undefined || value === '') missing.push(name)
    else env[name] = value
  }
  return {
    env: Object.freeze({ ...env, ...request.extraEnv }),
    missing: Object.freeze(missing),
  }
}
