/**
 * Vocabulary of the nix-only profile: which paths a confined command can
 * reach, with what access, and which tools its PATH exposes (§2.2 layer one).
 *
 * Every value here is plain data, so a task's acceptance evidence can quote the
 * profile a fleet worker actually ran under without reading backend internals.
 *
 * @module @dsh-fleet/nix-sandbox/types
 */

import type { ConfinedSandboxMode } from '@deepseek-ai/dsh-sandbox'

/** What a profile grants at one visible path. */
export type NixPathAccess =
  /** The path is bound as-is: reads succeed, writes fail. */
  | 'read-only'
  /** The path is bound writable. */
  | 'read-write'

/** Why one path is inside the confined namespace. */
export type NixPathRole =
  /** The read-only flake store; the only dependency source (§2.1). */
  | 'store'
  /** The calling session's workspace root, supplied per call through the sandbox policy. */
  | 'workspace'
  /** The private, empty temp root the backend mounts in place of the host temp area. */
  | 'temp'
  /** An extra writable root the deployment configured. */
  | 'writable-root'

/** One path the confined process can reach, and the access this profile grants there. */
export interface NixVisiblePath {
  /** Absolute host path bound into the confined mount namespace. */
  readonly path: string
  /**
   * Access this profile grants at `path`. A `read-only` call mode narrows every
   * entry to `read-only` except the store, which is never writable.
   */
  readonly access: NixPathAccess
  /** What the path is, which decides how a call's workspace and mode treat it. */
  readonly role: NixPathRole
}

/** One store directory left off the confined PATH, with the managers that removed it. */
export interface NixDroppedPathEntry {
  /** The store directory that is not on the confined PATH. */
  readonly path: string
  /** Package-manager executables found in it that `allowPackages` does not name. */
  readonly managers: readonly string[]
}

/** Whether the confined process shares the host network namespace. */
export type NixNetworkPolicy =
  /** The process runs in its own network namespace; only loopback exists. */
  | 'disabled'
  /** The process shares the host network; the deployment opted in for a flake input fetch. */
  | 'enabled'

/**
 * The effective nix-only profile. This is the profile's whole contract: a
 * command runs inside exactly these paths, sees exactly this PATH, and reaches
 * the network only when {@link NixSandboxProfile.network} is `enabled`.
 */
export interface NixSandboxProfile {
  /** Profile name; `nix-only` unless the deployment renamed it. */
  readonly profileName: string
  /** The flake store, bound read-only. */
  readonly storePath: string
  /**
   * Every path inside the namespace in bind order: the store, the calling
   * session's workspace when a call named one, the temp root, then the
   * configured writable roots. Nothing else exists in the namespace.
   */
  readonly visiblePaths: readonly NixVisiblePath[]
  /** The confined PATH in order; every entry is a directory inside {@link storePath}. */
  readonly path: readonly string[]
  /** Store directories removed from {@link path}, with the managers that removed them. */
  readonly droppedPathEntries: readonly NixDroppedPathEntry[]
  /** Every package-manager executable name this profile refuses to expose. */
  readonly blockedManagers: readonly string[]
  /** Package managers `allowPackages` opted back onto the PATH — a deliberate weakening. */
  readonly allowedManagers: readonly string[]
  /** Whether the network namespace is shared. */
  readonly network: NixNetworkPolicy
}

/** Inputs that select which profile one confined call actually receives. */
export interface NixProfileRequest {
  /**
   * Absolute workspace root of the calling session. Omitted reports the
   * deployment's own roots, which is what a call without a session receives.
   */
  readonly workspaceRoot?: string
  /**
   * Per-call file-effect mode from `ctx.sandboxPolicy`. `read-only` narrows
   * every grant except the store; omitted reports the profile's grants as
   * configured.
   */
  readonly mode?: ConfinedSandboxMode
}

/**
 * The host facts profile resolution reads: the environment the confined PATH is
 * derived from, the temp root the profile replaces, and the existence probe
 * that decides whether a store directory provides a package manager. The plugin
 * wires this process's environment, `os.tmpdir()`, and `fs.existsSync`.
 */
export interface NixSandboxHost {
  /** Environment to read; only its `PATH` entry is used. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** Absolute host temp root; the profile mounts a private tmpfs over it. */
  readonly tempRoot: string
  /** Whether a path exists on this host. */
  readonly exists: (path: string) => boolean
}

/** Plugin configuration after the schema applied every default. */
export interface ResolvedConfig {
  /** Profile name reported by {@link NixSandboxProfile.profileName}. */
  readonly profileName: string
  /** Absolute flake store path, read-only inside the namespace. */
  readonly storePath: string
  /** Extra absolute writable roots, on top of the workspace and temp roots. */
  readonly writableRoots: readonly string[]
  /** Whether a flake input fetch needs the host network. */
  readonly network: boolean
  /** Package managers deliberately opted back onto the confined PATH. */
  readonly allowPackages: readonly string[]
}
