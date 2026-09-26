/**
 * The nix-only sandbox backend: the seam's provider role for §2.2 layer one.
 *
 * The seam's three modes decide write permission; this backend decides
 * visibility. It wraps the caller's argv in the runner's mount and namespace
 * dialect so the confined process reaches the read-only flake store, the
 * workspace, and a private temp root — and nothing else on the host — with a
 * PATH rebuilt from store directories only. Availability is decided by a
 * functional probe and cached; when the probe fails, `confine()` rejects with
 * the seam's fail-closed error rather than returning the caller's own argv.
 *
 * @module @dsh-fleet/nix-sandbox/provider
 */

import { spawnSync } from 'node:child_process'
import { delimiter } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { SandboxProvider, SandboxUnavailableError, canonicalPath } from '@deepseek-ai/dsh-sandbox'
import type {
  ConfinedArgv,
  ConfinedSandboxMode,
  RunnerFailureRule,
  SandboxEnforcement,
  SandboxPolicy,
} from '@deepseek-ai/dsh-sandbox'
import { effectiveProfile } from './profile.ts'
import type { NixSandboxProfile } from './types.ts'

/** The runner this profile is expressed in; bwrap owns the mount and namespace dialect. */
const RUNNER = 'bwrap'

/** Fixed bound on the functional probe: a wedged runner must not hold the first confined call open. */
const PROBE_TIMEOUT_MS = 5_000

/**
 * How completely this backend governs the effects its profile promises. The
 * mounts and the network namespace are the enforcement, so every promised file
 * effect is governed by construction — there is no per-ABI subset as with
 * Landlock, and no aliasing hole as with NTFS hard links.
 */
const ENFORCEMENT: SandboxEnforcement = 'full'

/**
 * The runner's denial dialect: the case-insensitive stderr substrings a file
 * effect denied by THIS backend produces. A write into a `--ro-bind` mount
 * fails with EROFS, and an unreachable bind mount fails with EACCES.
 *
 * ENOENT is deliberately absent. Under this profile the most common denial IS a
 * missing path — nothing outside the visible roots exists — but a failed
 * command's "no such file or directory" is indistinguishable from a genuinely
 * absent file, and classifying ordinary failures as denials would offer the
 * model an escalation that cannot help it.
 */
const DENIAL_SIGNATURES: readonly string[] = ['read-only file system', 'permission denied']

/**
 * Runner-owned fatal diagnostics: bwrap prefixes its own failures with `bwrap: `
 * before it executes the wrapped command, so a broken runner is distinguishable
 * from a denied command.
 */
const RUNNER_FAILURE_RULES: readonly RunnerFailureRule[] = [{ fatalSignatures: [`${RUNNER}: `] }]

/** Test hook: inject the platform and the functional runner probe (mirrors the local backend's `internals`). */
export interface NixSandboxInternals {
  /** Replaces `process.platform` for the availability check. */
  platform?: string
  /** Replaces the functional `bwrap` probe. */
  probeBwrap?: (profileArgs: readonly string[]) => boolean
}

/**
 * Functional probe: run the profile around this harness's own executable, which
 * the profile exposes only when the harness itself comes from the flake store.
 * Exit 0 means the kernel accepted the mounts, the rebuilt PATH, and the
 * network namespace.
 * @param profileArgs - the runner argv prefix expressing the deployment profile.
 * @returns whether the confined world can execute the harness's own runtime.
 */
function defaultProbeBwrap(profileArgs: readonly string[]): boolean {
  const probe = spawnSync(RUNNER, [...profileArgs, '--', process.execPath, '-e', ''], {
    timeout: PROBE_TIMEOUT_MS,
    stdio: 'ignore',
  })
  return probe.status === 0
}

/**
 * The nix-only sandbox backend, registered as `ctx.sandbox`. It holds the
 * deployment profile resolved at load and caches one availability verdict; it
 * keeps no per-call state, because the profile's grants come from the
 * configuration and the policy rather than from anything this provider owns.
 */
export class NixOnlySandboxProvider extends SandboxProvider {
  /** Test hook (mirrors the local backend's `internals`). */
  internals: NixSandboxInternals = {}

  private readonly deployment: NixSandboxProfile
  /** Cached availability verdict; undefined until the first confined wrap needs it. */
  private usable: boolean | undefined

  /**
   * @param ctx - owning context; the service registers on it.
   * @param deployment - the deployment profile resolved at plugin load.
   */
  constructor(ctx: Context, deployment: NixSandboxProfile) {
    super(ctx)
    this.deployment = deployment
  }

  /**
   * Wrap `argv` so it executes inside the nix-only namespace under `policy`.
   *
   * The call's workspace root joins the visible paths and its mode narrows the
   * write grants; the store stays read-only either way. A host that cannot run
   * the profile fails closed here, so a command never runs on the host
   * unconfined because confinement was unavailable.
   *
   * @param argv - the exact argv the caller is about to spawn.
   * @param policy - the file-effect policy this execution runs under.
   * @param signal - cancellation before the profile is assembled.
   * @returns the runner argv plus this backend's enforcement, denial, and
   *   runner-failure facts.
   * @throws {SandboxUnavailableError} when this host cannot enforce the profile.
   * @throws {TypeError} when the policy's workspace root is not absolute.
   */
  async confine(argv: readonly string[], policy: SandboxPolicy, signal?: AbortSignal): Promise<ConfinedArgv> {
    signal?.throwIfAborted()
    this.assertUsable(policy.mode)
    const profile = effectiveProfile(this.deployment, {
      workspaceRoot: canonicalPath(policy.workspaceRoot),
      mode: policy.mode,
    })
    return Promise.resolve<ConfinedArgv>({
      argv: [...this.profileArgs(profile), '--', ...argv],
      enforcement: ENFORCEMENT,
      denialSignatures: DENIAL_SIGNATURES,
      runnerFailureRules: RUNNER_FAILURE_RULES,
    })
  }

  /**
   * Fail closed unless this host can enforce the profile.
   * @param mode - the mode the rejected call requested, named by the seam's error.
   * @throws {SandboxUnavailableError} when no runner can enforce the profile here.
   */
  private assertUsable(mode: ConfinedSandboxMode): void {
    this.usable ??= this.probe()
    if (!this.usable) throw new SandboxUnavailableError(mode)
  }

  /** Probe once per provider lifetime: Linux, and a runner that accepts the real profile. */
  private probe(): boolean {
    if ((this.internals.platform ?? process.platform) !== 'linux') return false
    const args = this.profileArgs(this.deployment)
    return (this.internals.probeBwrap ?? defaultProbeBwrap)(args)
  }

  /**
   * Express one profile in the runner's dialect: the namespace flags, one mount
   * per visible path, the private temp root, the confined PATH, and the network
   * namespace when the profile disables it.
   *
   * The temp tmpfs is mounted before every bind so a workspace or writable root
   * inside the host temp root is not shadowed by it.
   *
   * @param profile - the effective profile to express.
   * @returns the runner argv prefix, before the separator and the caller's argv.
   */
  private profileArgs(profile: NixSandboxProfile): string[] {
    const args = [RUNNER, '--die-with-parent', '--unshare-pid', '--dev', '/dev', '--proc', '/proc']
    for (const entry of profile.visiblePaths) {
      if (entry.role !== 'temp') continue
      args.push('--tmpfs', entry.path)
      // A read-only call keeps the temp root mounted but grants no writes
      // there, exactly as the seam's read-only mode promises.
      if (entry.access === 'read-only') args.push('--remount-ro', entry.path)
      args.push('--setenv', 'TMPDIR', entry.path)
    }
    for (const entry of profile.visiblePaths) {
      if (entry.role === 'temp') continue
      args.push(entry.access === 'read-write' ? '--bind' : '--ro-bind', entry.path, entry.path)
    }
    if (profile.network === 'disabled') args.push('--unshare-net')
    args.push('--setenv', 'PATH', profile.path.join(delimiter))
    return args
  }
}
