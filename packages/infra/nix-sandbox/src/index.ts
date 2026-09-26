/**
 * `@dsh-fleet/nix-sandbox` — the fleet's nix-only sandbox profile (§2.2 layer
 * one, §11 item 14): a confined command reaches a read-only `/nix/store`, the
 * session workspace, and a private temp root, and nothing else on the host.
 *
 * Mounting this package contributes three things, all of them effects of one
 * plugin load: the profile resolved as data, the backend that enforces it in
 * the seam's provider role (`ctx.sandbox`), and the read-only query surface
 * (`ctx.fleetSandbox`) a task's acceptance evidence quotes. Disposing the
 * fiber removes both registrations, so a composition that unmounts the profile
 * cannot leave a stale confinement claim behind.
 *
 * @module @dsh-fleet/nix-sandbox
 */

import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveProfile } from './profile.ts'
import { NixOnlySandboxProvider } from './provider.ts'
import { FleetSandbox } from './service.ts'
import type { ResolvedConfig } from './types.ts'

export type * from './types.ts'
export { effectiveProfile, resolveProfile } from './profile.ts'
export { NixOnlySandboxProvider } from './provider.ts'
export type { NixSandboxInternals } from './provider.ts'
export { FleetSandbox } from './service.ts'

/** Plugin name used by loader diagnostics. */
export const name = '@dsh-fleet/nix-sandbox'

/**
 * Plugin configuration. Every field is optional because the schema below
 * supplies the deployment-reachable default; a field is set only to move the
 * profile away from that default.
 */
export interface Config {
  /** Profile name carried by the resolved profile (default `nix-only`). */
  profileName?: string
  /** Absolute flake store path bound read-only (default `/nix/store`). */
  storePath?: string
  /**
   * Extra absolute writable roots, granted to every call. The calling
   * session's workspace root is added per call and does not belong here.
   */
  writableRoots?: string[]
  /**
   * Share the host network namespace (default `false`). Turn it on only for a
   * call that must fetch a flake input; this is the profile's network opt-in.
   */
  network?: boolean
  /**
   * Package managers named back onto the confined PATH (default empty). Every
   * entry is a deliberate weakening of the profile and is recorded in
   * {@link NixSandboxProfile.allowedManagers}.
   */
  allowPackages?: string[]
}

/**
 * Config schema. Every default is the fleet's nix-only value: the store at its
 * standard location, no extra writable roots, no network, no package manager.
 */
export const Config: z<Config> = z.object({
  profileName: z.string().default('nix-only'),
  storePath: z.string().default('/nix/store'),
  writableRoots: z.array(z.string()).default([]),
  network: z.boolean().default(false),
  allowPackages: z.array(z.string()).default([]),
})

/**
 * Resolve the profile once and contribute it to the seam.
 *
 * Resolution runs here, at load: a profile the host cannot enforce stops the
 * composition instead of degrading to unconfined execution at the first
 * command. Mounting this package where another provider already owns
 * `ctx.sandbox` fails at load too, because the seam allows one provider per
 * context — the fleet replaces the `sandbox-local` row rather than adding to it.
 *
 * @param ctx - context the plugin loads into.
 * @param config - plugin configuration; the schema above already applied defaults.
 * @throws {TypeError} when the configuration cannot be enforced on this host.
 */
export function apply(ctx: Context, config: Config): void {
  // The schema filled every default, so the cast records a runtime fact.
  const profile = resolveProfile(config as ResolvedConfig, {
    env: process.env,
    tempRoot: tmpdir(),
    exists: existsSync,
  })
  ctx.plugin(FleetSandbox, profile)
  ctx.plugin(NixOnlySandboxProvider, profile)
}
