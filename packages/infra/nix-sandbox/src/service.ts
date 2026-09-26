/**
 * The profile query surface (`ctx.fleetSandbox`): the read-only view of the
 * profile a fleet worker runs under, so a task's acceptance evidence can quote
 * what the sandbox actually enforced instead of restating its configuration.
 *
 * @module @dsh-fleet/nix-sandbox/service
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { effectiveProfile } from './profile.ts'
import type { NixProfileRequest, NixSandboxProfile } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    fleetSandbox: FleetSandbox
  }
}

/**
 * The fleet's sandbox-profile service. It owns no state beyond the deployment
 * profile resolved at plugin load and exposes no mutation: the profile a call
 * receives is derived from that data plus the call's own policy.
 */
export class FleetSandbox extends Service {
  private readonly deployment: NixSandboxProfile

  /**
   * @param ctx - owning context; the service registers as `ctx.fleetSandbox`.
   * @param deployment - the deployment profile resolved at plugin load.
   */
  constructor(ctx: Context, deployment: NixSandboxProfile) {
    super(ctx, 'fleetSandbox')
    this.deployment = deployment
  }

  /**
   * The effective profile as plain data.
   *
   * Called with a call's workspace root and mode, it answers exactly what that
   * call can reach; called with neither, it reports the deployment's own roots.
   *
   * @param request - workspace root and file-effect mode of the call being described.
   * @returns the profile data; every call returns a fresh value the caller owns.
   * @throws {TypeError} when the requested workspace root is not absolute.
   */
  profile(request: NixProfileRequest = {}): NixSandboxProfile {
    return effectiveProfile(this.deployment, request)
  }
}
