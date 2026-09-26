/**
 * `ctx.shell` provider that runs every command inside a flake environment
 * (§2.2 layer two). `nix develop <flakeRef> -c bash -lc <command>` replaces the
 * inherited executor's `bash -c <command>`, so a command that installs a
 * package installs it into a throwaway environment instead of onto the
 * machine. Process plumbing, output capture, deadlines, cancellation, and the
 * sandbox wrap stay `@deepseek-ai/dsh-bash-sandbox`'s: this package changes
 * which argv is spawned and nothing else. Exactly one implementation of
 * `ctx.shell` may be mounted, so the composition that loads this provider
 * disables the base profile's executor.
 * @module @dsh-fleet/nix-shell
 */

import { accessSync, constants as fsConstants, existsSync, statSync } from 'node:fs'
import { delimiter, isAbsolute, join, resolve as resolvePath } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { assertServiceableBashConfig } from '@deepseek-ai/dsh-bash-local'
import type { Config as LocalConfig } from '@deepseek-ai/dsh-bash-local'
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'
import type { ShellExecRequest, ShellExecSpec, ShellExecution } from '@deepseek-ai/dsh-shell'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { nixShellArgv, shellCommandLine } from './command.ts'
import type { NixShellInvocation, NixShellMode } from './command.ts'

export type { NixShellInvocation, NixShellMode } from './command.ts'
export { nixShellArgv, shellCommandLine, shellQuote } from './command.ts'

/**
 * Local-executor schema defaults, restated so this package's single schema
 * validates the whole object the executor receives. They are equal to
 * `@deepseek-ai/dsh-bash-local`'s own defaults, which is what keeps the
 * inherited budgets behaving identically here.
 */
const LOCAL_DEFAULTS = {
  timeoutMs: 120_000,
  maxTimeoutMs: 600_000,
  maxOutputBytes: 64_000,
  maxSpillBytes: 64 * 1024 * 1024,
  graceMs: 3_000,
} as const

/** Milliseconds added to a command deadline for realising the flake environment (the `developTimeoutMs` default). */
const DEFAULT_DEVELOP_TIMEOUT_MS = 300_000

/**
 * Flake reference markers that make a reference a registry, URL, or fragment
 * form (`github:owner/repo`, `path:/srv/flake`, `nixpkgs#hello`) rather than a
 * path this process can resolve and check.
 */
const REFERENCE_MARKER = /[:#]/u

/**
 * Plugin configuration: the local executor's command budgets plus the flake
 * environment every command runs in. The sandbox policy is not here — it stays
 * on `ctx.sandboxPolicy`, which the inherited executor applies to each call.
 */
export interface Config extends LocalConfig {
  /**
   * Flake the command's environment comes from (default `.`). A reference
   * carrying `:` or `#` (`github:owner/repo`, `nixpkgs#hello`) is handed to nix
   * unchecked; every other form is a path, resolved against the harness launch
   * directory once at load and required to be a directory containing
   * `flake.nix`. A bare registry name is therefore a load failure rather than
   * an ambiguous reference resolved at the first command. Changing it takes a
   * reload: the resolved value is fixed when the plugin loads.
   */
  flakeRef: string
  /**
   * nix executable (default `nix`). A bare name is looked up on `PATH`; a path
   * is resolved against the harness launch directory. Either way the absolute
   * result is what every command spawns, so a later `PATH` change cannot move
   * which nix runs.
   */
  nixBin: string
  /**
   * Milliseconds added to every resolved command deadline to cover realising
   * the flake environment (default 300000). `nix develop` may fetch or build
   * the development environment before the command starts, and that work is
   * charged to the same deadline the command runs under.
   */
  developTimeoutMs: number
  /** Which nix subcommand supplies the environment (default `develop`). */
  mode: NixShellMode
  /**
   * Extra nix arguments inserted between the flake reference and `-c`
   * (default empty). Deployment-varying flags such as `--no-write-lock-file`
   * belong here rather than in this package.
   */
  extraArgs: string[]
}

/** The flake-environment configuration after load-time resolution. */
export interface ResolvedConfig {
  /** Absolute nix executable every command spawns. */
  readonly nixBin: string
  /** Subcommand selecting the environment. */
  readonly mode: NixShellMode
  /** Absolute path, or the registry/URL reference nix resolves itself. */
  readonly flakeRef: string
  /** Extra nix arguments inserted before `-c`. */
  readonly extraArgs: readonly string[]
  /** Milliseconds added to every resolved command deadline. */
  readonly developTimeoutMs: number
}

/**
 * Whether a path names a file this process may execute.
 * @param path - candidate path.
 * @returns the path when it is an executable file, else undefined.
 */
function executableFile(path: string): string | undefined {
  try {
    if (!statSync(path).isFile()) return undefined
    // X_OK is POSIX semantics; on Windows it degrades to an existence check.
    accessSync(path, fsConstants.X_OK)
    return path
  } catch {
    // Absent, unreadable, or not executable is not a usable nix binary.
    return undefined
  }
}

/**
 * Resolve an executable name or path the way plugin load does.
 * @param nixBin - executable name looked up on `PATH`, or a path.
 * @param launchDir - directory a relative path resolves against.
 * @returns the absolute executable path, or undefined when nothing runnable is there.
 */
export function resolveExecutable(nixBin: string, launchDir: string): string | undefined {
  if (nixBin.length === 0) return undefined
  if (!nixBin.includes('/') && !nixBin.includes('\\')) {
    const search = process.env['PATH']
    if (search === undefined) return undefined
    for (const dir of search.split(delimiter)) {
      if (dir.length === 0) continue
      const found = executableFile(join(dir, nixBin))
      if (found !== undefined) return found
    }
    return undefined
  }
  return executableFile(isAbsolute(nixBin) ? nixBin : resolvePath(launchDir, nixBin))
}

/**
 * Resolve the flake reference once, at load.
 * @param flakeRef - configured flake reference.
 * @param launchDir - directory a relative path resolves against.
 * @returns the absolute path of the flake, or the reference nix resolves itself.
 * @throws {TypeError} when a path reference holds no `flake.nix`.
 */
function resolveFlakeRef(flakeRef: string, launchDir: string): string {
  if (flakeRef.length === 0) {
    throw new TypeError('@dsh-fleet/nix-shell flakeRef must be a non-empty flake reference')
  }
  if (REFERENCE_MARKER.test(flakeRef)) return flakeRef
  const path = isAbsolute(flakeRef) ? flakeRef : resolvePath(launchDir, flakeRef)
  if (!existsSync(join(path, 'flake.nix'))) {
    throw new TypeError(
      `@dsh-fleet/nix-shell flakeRef ${JSON.stringify(flakeRef)} resolves to ${path}, `
      + 'which is not a directory containing flake.nix',
    )
  }
  return path
}

/**
 * Validate the flake-environment configuration and resolve its paths.
 *
 * A misconfigured deployment must fail here — once, at load — rather than at
 * the first command, where it would look like a command fault: the nix
 * executable must resolve, a path `flakeRef` must name a directory holding
 * `flake.nix`, every budget must be usable, and no extra nix argument may be
 * empty.
 *
 * @param config - schema-validated plugin configuration.
 * @param launchDir - harness launch directory, read once here so no later call depends on a mutable cwd.
 * @returns absolute paths, the environment selector, and the validated budgets.
 * @throws {TypeError} naming the field that cannot be used.
 */
export function resolveNixConfig(config: Config, launchDir: string): ResolvedConfig {
  assertServiceableBashConfig(config)
  const nixBin = resolveExecutable(config.nixBin, launchDir)
  if (nixBin === undefined) {
    throw new TypeError(
      `@dsh-fleet/nix-shell nixBin ${JSON.stringify(config.nixBin)} is neither an executable on PATH `
      + 'nor a resolvable path to one',
    )
  }
  const { developTimeoutMs } = config
  if (!Number.isFinite(developTimeoutMs) || developTimeoutMs <= 0 || developTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new TypeError(
      `@dsh-fleet/nix-shell developTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  for (const arg of config.extraArgs) {
    if (arg.length === 0 || arg.includes('\0')) {
      throw new TypeError('@dsh-fleet/nix-shell extraArgs entries must be non-empty arguments without NUL bytes')
    }
  }
  return {
    nixBin,
    mode: config.mode,
    flakeRef: resolveFlakeRef(config.flakeRef, launchDir),
    extraArgs: config.extraArgs,
    developTimeoutMs,
  }
}

/**
 * `ctx.shell` provider that runs every command inside a flake environment.
 *
 * The inherited executor still confines the spawned argv through `ctx.sandbox`
 * under the resolved policy and still owns output capture, the deadline,
 * cancellation, and sandbox fact reporting; this class replaces only the argv
 * `['bash', '-c', command]` with the flake invocation's argv.
 */
export class NixShellExecutor extends SandboxBashExecutor {
  /**
   * Config schema: the flake-environment fields plus the inherited local
   * executor's budgets, restated so one schema validates the complete object.
   */
  static override Config = z.object({
    cwd: z.string().volatile(),
    timeoutMs: z.number().default(LOCAL_DEFAULTS.timeoutMs).volatile(),
    maxTimeoutMs: z.number().default(LOCAL_DEFAULTS.maxTimeoutMs).volatile(),
    maxOutputBytes: z.number().default(LOCAL_DEFAULTS.maxOutputBytes).volatile(),
    maxSpillBytes: z.number().default(LOCAL_DEFAULTS.maxSpillBytes).volatile(),
    graceMs: z.number().default(LOCAL_DEFAULTS.graceMs).volatile(),
    flakeRef: z.string().default('.'),
    nixBin: z.string().default('nix'),
    developTimeoutMs: z.number().default(DEFAULT_DEVELOP_TIMEOUT_MS),
    mode: z.union(['develop', 'shell'] as const).default('develop'),
    extraArgs: z.array(z.string()).default([]),
  })

  /** The resolved flake invocation, fixed when the plugin loads. */
  private readonly nix: ResolvedConfig

  /** The argv prefix every wrapped command shares. */
  private readonly invocation: NixShellInvocation

  /**
   * @param ctx - owning context; the inherited `subprocess`, `sandbox`, and `sandboxPolicy` services must be available.
   * @param config - plugin configuration, validated here so a misconfigured
   *   deployment fails at load rather than at the first command.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, config)
    // The harness launch directory is read once: a later chdir must not move
    // the flake a command runs in.
    this.nix = resolveNixConfig(config, process.cwd())
    this.invocation = {
      nixBin: this.nix.nixBin,
      mode: this.nix.mode,
      flakeRef: this.nix.flakeRef,
      extraArgs: this.nix.extraArgs,
    }
  }

  /**
   * Extend the inherited resolution with the flake-preparation budget: the
   * resolved deadline covers realising the environment and running the
   * command, so a caller that reads {@link ShellExecSpec.timeoutMs} — job
   * promotion, result reporting — sees the deadline that will actually apply.
   * The result is clamped to the largest schedulable timer.
   *
   * The command itself stays the caller's own text here; {@link execute}
   * wraps it, so a spec a caller inspects still names what the caller asked
   * for.
   * @param request - the caller's request.
   * @returns the resolved spec, with the flake-preparation budget included.
   */
  override resolve(request: ShellExecRequest): ShellExecSpec {
    const spec = super.resolve(request)
    return {
      ...spec,
      timeoutMs: Math.min(spec.timeoutMs + this.nix.developTimeoutMs, MAX_TIMER_DELAY_MS),
    }
  }

  /**
   * Wrap the command in the flake invocation and delegate the spawn to the
   * sandbox-consuming base implementation.
   *
   * The wrap happens here rather than in {@link resolve} because this is the
   * method that cannot be bypassed: any spec reaching `execute` — including one
   * a plugin built by hand — runs inside the flake environment.
   * @param spec - a resolved spec from {@link resolve}.
   * @returns the execution handle with the inherited lifecycle semantics:
   *   resolves after preparation, rejects only for infrastructure failures,
   *   and reports nonzero exits, timeout kills, and abort kills as results.
   */
  override execute(spec: ShellExecSpec): Promise<ShellExecution> {
    return super.execute({ ...spec, command: shellCommandLine(nixShellArgv(this.invocation, spec.command)) })
  }
}

export default NixShellExecutor
