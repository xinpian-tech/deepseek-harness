/**
 * `ctx.workerTemplate` — the worker launch template (§11 item 4).
 *
 * A worker is a `dsh --profile sdk` process living in a tmux pane, resident for
 * the whole task and never exiting, because the SDK server's
 * `getOrCreateSession` recreates a session in a new process instead of resuming
 * it (§5.4). The launch is a sequence with three non-negotiable steps, and this
 * package owns them as one contract:
 *
 * 1. Place or reuse the pane through `ctx.tmux`, which owns pane placement, the
 *    frame channel, and the wait until the harness owns the pane's foreground —
 *    this package never drives tmux itself.
 * 2. Suppress the tty's echo (`stty -echo -icanon`) in the same shell that
 *    execs the harness. Without it every frame written into the pane is
 *    echoed back into the output log and arrives as a corrupt frame; the
 *    composed channel's pane command always includes this step, so the
 *    template refuses a configuration that claims otherwise rather than
 *    launching a pane whose channel corrupts.
 * 3. Exec the harness with its profile and ordered patches, and hand the pane
 *    the credential-shaped environment variables explicitly. dsh strips those
 *    variables when it spawns an out-of-process child (§8.2), so a credential
 *    injected only through this process's environment never reaches the
 *    worker's own nested harness — a failure that surfaces as a 401 several
 *    layers down. Every configured credential that is absent is reported
 *    before the pane starts, through `credentialReport()` and a launch
 *    warning, and is omitted from the pane's environment rather than passed as
 *    an empty string.
 *
 * `launch()` returns the exact command line and the exact environment entries
 * the pane received, so a test or an operator asserts the launch without
 * reading the pane. The peer is the shell contract in `infra/scripts/worker.sh`.
 *
 * @module @dsh-fleet/worker-template
 */

import { isAbsolute } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@dsh-fleet/tmux'
import {
  buildLaunchLine,
  resolvePaneEnv,
  type CredentialPresence,
  type ResolvedPaneEnv,
} from './launch.ts'
import type { WorkerHandle, WorkerLaunchRequest } from './types.ts'

export type * from './types.ts'
export {
  buildLaunchLine,
  resolvePaneEnv,
  shellQuote,
  type CredentialPresence,
  type PaneEnvRequest,
  type ResolvedPaneEnv,
  type WorkerLaunchSpec,
} from './launch.ts'

/**
 * Credential-shaped variables a worker pane receives by default — the provider
 * keys this repository already knows (§8.2). A deployment whose worker needs a
 * key outside this list names it in `credentialEnv`.
 */
export const DEFAULT_CREDENTIAL_ENV: readonly string[] = Object.freeze([
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_BASE_URL',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'MOONSHOT_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'ZHIPUAI_API_KEY',
])

/** Environment variable names a pane may receive. */
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Configuration of the worker launch template. */
export interface Config {
  /** Profile the worker harness runs (default `sdk`). */
  profile?: string
  /** Absolute profile patch files handed to the worker harness, in order. */
  patches?: string[]
  /** Harness executable the pane execs (default `dsh`). */
  dshBin?: string
  /** Absolute harness home the pane runs with; the worker's sessions and state live here. */
  dshHome: string
  /** Credential-shaped variables forwarded explicitly, when present. */
  credentialEnv?: string[]
  /** Explicit name/value pairs layered over the credential allowlist. */
  extraEnv?: Record<string, string>
  /**
   * Whether the launch line carries the tty setup step (default true). The
   * composed channel's pane command always carries it, so `false` is refused
   * at load: a pane without it echoes every frame back as corrupt output.
   */
  enableStty?: boolean
  /** Bound (ms) on confirming the placed pane after the launch sequence (default 15000). */
  startTimeoutMs?: number
  /** Interval (ms) between confirmation checks (default 50). */
  confirmPollMs?: number
}

/** The configuration after defaults and validation. */
export interface ResolvedConfig {
  /** Profile the worker harness runs. */
  readonly profile: string
  /** Absolute patch files, in order. */
  readonly patches: readonly string[]
  /** Harness executable the pane execs. */
  readonly dshBin: string
  /** Absolute harness home. */
  readonly dshHome: string
  /** Credential variables forwarded explicitly. */
  readonly credentialEnv: readonly string[]
  /** Explicit environment pairs layered over the allowlist. */
  readonly extraEnv: Readonly<Record<string, string>>
  /** Whether the echo-suppression step is required; always true once resolved. */
  readonly enableStty: boolean
  /** Bound (ms) on confirming the placed pane. */
  readonly startTimeoutMs: number
  /** Interval (ms) between confirmation checks. */
  readonly confirmPollMs: number
}

/** Raised when a pane cannot be confirmed after its launch sequence. */
export class WorkerTemplateError extends Error {
  /**
   * @param message - operator-facing description of the failed launch.
   * @param key - placement key the failure belongs to.
   */
  constructor(
    message: string,
    readonly key: string,
  ) {
    super(message)
    this.name = 'WorkerTemplateError'
  }
}

/**
 * Validate the launch configuration.
 *
 * A misconfigured fleet fails here — at load, once — rather than at the first
 * delegation, when a relative patch path or an unusable credential name would
 * look like a worker fault several layers down.
 *
 * @param config - raw plugin configuration.
 * @returns the validated configuration.
 * @throws {TypeError} when a required path is missing, relative, or empty, an
 * environment name is not a name, a bound is not positive, or `enableStty` is
 * false.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const resolved = WorkerTemplate.Config(config)
  const dshHome = resolved.dshHome
  if (dshHome === undefined || !isAbsolute(dshHome)) {
    throw new TypeError('@dsh-fleet/worker-template dshHome must be an absolute path')
  }
  const dshBin = resolved.dshBin
  if (dshBin === '') throw new TypeError('@dsh-fleet/worker-template dshBin must be a non-empty executable')
  const profile = resolved.profile
  if (profile === '') throw new TypeError('@dsh-fleet/worker-template profile must be a non-empty profile name')
  const patches = resolved.patches
  if (patches.some(patch => !isAbsolute(patch))) {
    throw new TypeError('@dsh-fleet/worker-template patches must be absolute paths')
  }
  const credentialEnv = resolved.credentialEnv
  assertEnvNames(credentialEnv, 'credentialEnv')
  const extraEnv = resolved.extraEnv
  assertEnvNames(Object.keys(extraEnv), 'extraEnv')
  if (resolved.enableStty !== true) {
    throw new TypeError(
      '@dsh-fleet/worker-template requires tty echo suppression: the composed @dsh-fleet/tmux channel runs '
      + '`stty -echo -icanon` on every pane it places, and a pane without it echoes every frame back as corrupt output',
    )
  }
  const startTimeoutMs = resolved.startTimeoutMs
  if (!Number.isSafeInteger(startTimeoutMs) || startTimeoutMs <= 0) {
    throw new TypeError('@dsh-fleet/worker-template startTimeoutMs must be a positive safe integer')
  }
  const confirmPollMs = resolved.confirmPollMs
  if (!Number.isSafeInteger(confirmPollMs) || confirmPollMs <= 0) {
    throw new TypeError('@dsh-fleet/worker-template confirmPollMs must be a positive safe integer')
  }
  return {
    profile,
    patches: Object.freeze([...patches]),
    dshBin,
    dshHome,
    credentialEnv: Object.freeze([...credentialEnv]),
    extraEnv: Object.freeze({ ...extraEnv }),
    enableStty: true,
    startTimeoutMs,
    confirmPollMs,
  }
}

/**
 * Reject a configured value that cannot name an environment variable.
 * @param names - candidate variable names.
 * @param field - configuration field the names came from.
 * @throws {TypeError} when a name is empty or outside the POSIX name alphabet.
 */
function assertEnvNames(names: readonly string[], field: string): void {
  for (const name of names) {
    if (!ENV_NAME_PATTERN.test(name)) {
      throw new TypeError(
        `@dsh-fleet/worker-template ${field} entries must match ${ENV_NAME_PATTERN.source}: ${JSON.stringify(name)}`,
      )
    }
  }
}

/**
 * Wait for the next confirmation check.
 * @param ms - milliseconds to wait.
 * @returns a promise settling after the delay.
 */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    workerTemplate: WorkerTemplate
  }
}

/** The worker launch template service. */
export class WorkerTemplate extends Service {
  static inject = ['tmux']

  static Config: z<Config, ResolvedConfig> = z.object({
    profile: z.string().default('sdk'),
    patches: z.array(z.string()).default([]),
    dshBin: z.string().default('dsh'),
    dshHome: z.string().required(),
    credentialEnv: z.array(z.string()).default([...DEFAULT_CREDENTIAL_ENV]),
    extraEnv: z.dict(z.string()).default({}),
    enableStty: z.boolean().default(true),
    startTimeoutMs: z.number().default(15_000),
    confirmPollMs: z.number().default(50),
  })

  /** The configuration after defaults and validation. */
  private readonly config: ResolvedConfig
  /** The command line every pane this service places runs. */
  private readonly launchLine: string

  /**
   * @param ctx - owning context; `tmux` must be available.
   * @param config - plugin configuration, validated here so an unusable launch
   * contract fails at load rather than at the first pane.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'workerTemplate')
    this.config = resolveConfig(config)
    this.launchLine = buildLaunchLine(this.config)
  }

  /**
   * Place or reuse one worker pane and report what it received.
   *
   * A `resident` launch returns the pane a previous launch placed, which is
   * what makes a correction round continue the same worker conversation. A
   * newly created pane is confirmed to exist before this call resolves: a pane
   * that never appears fails the launch here instead of surfacing later as a
   * dead channel.
   *
   * @param key - placement key; stable for the lifetime of one worker.
   * @param request - working directory, placement mode, and optional session to record into.
   * @returns the placement, the exact launch line, and the exact environment entries handed to the pane.
   * @throws {TypeError} when the requested working directory is not absolute.
   * @throws {WorkerTemplateError} when a newly placed pane cannot be confirmed.
   */
  async launch(key: string, request: WorkerLaunchRequest): Promise<WorkerHandle> {
    if (!isAbsolute(request.cwd)) {
      throw new TypeError(`@dsh-fleet/worker-template pane cwd must be absolute: ${request.cwd}`)
    }
    const pane: ResolvedPaneEnv = resolvePaneEnv({
      dshHome: this.config.dshHome,
      credentialEnv: this.config.credentialEnv,
      extraEnv: this.config.extraEnv,
      env: process.env,
    })
    for (const name of pane.missing) {
      // A worker may be launched for a task that needs no model access, so a
      // missing credential is a warning: the worker runs, and the diagnostics
      // say what its nested harness will not be able to authenticate with.
      this.ctx.logger.warn(
        `@dsh-fleet/worker-template: credential ${name} is absent from the launching environment and is not `
        + `passed to pane ${key}; a nested harness in that pane will not reach the provider it authenticates`,
      )
    }
    const placement = await this.ctx.tmux.place(key, {
      cwd: request.cwd,
      mode: request.mode ?? 'resident',
      env: pane.env,
      ...request.recordTo === undefined ? {} : { recordTo: request.recordTo },
    })
    if (!placement.reused) await this.confirm(key)
    return {
      key,
      placement,
      launchLine: this.launchLine,
      env: pane.env,
      reused: placement.reused,
    }
  }

  /**
   * Whether each configured credential variable is present in this process.
   *
   * Values are never returned: this report exists so a missing credential is
   * visible before a pane starts, not after a nested harness fails to
   * authenticate.
   *
   * @returns one entry per configured variable, in configuration order.
   */
  credentialReport(): readonly CredentialPresence[] {
    return Object.freeze(this.config.credentialEnv.map(name => Object.freeze({
      name,
      present: isPresent(process.env[name]),
    })))
  }

  /**
   * Confirm that the pane this call placed still exists, bounded by the launch bound.
   * @param key - placement key of the newly created pane.
   * @throws {WorkerTemplateError} when the pane never appears within the bound;
   * the pane is released first, so a failed launch leaves nothing behind.
   */
  private async confirm(key: string): Promise<void> {
    const deadline = Date.now() + this.config.startTimeoutMs
    for (;;) {
      if (await this.ctx.tmux.alive(key)) return
      if (Date.now() >= deadline) {
        await this.ctx.tmux.release(key)
        throw new WorkerTemplateError(
          `worker pane ${key} did not appear within ${String(this.config.startTimeoutMs)} ms of its launch `
          + `line: ${this.launchLine}`,
          key,
        )
      }
      await delay(this.config.confirmPollMs)
    }
  }
}

/**
 * Whether an environment value counts as present.
 * @param value - value read from the process environment.
 * @returns true for any non-empty value.
 */
function isPresent(value: string | undefined): boolean {
  return value !== undefined && value !== ''
}

export default WorkerTemplate
