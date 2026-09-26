/**
 * Profile resolution for the nix-only backend: the deployment's configuration
 * plus three host facts become the plain-data profile a confined call runs
 * under.
 *
 * Resolution happens once at plugin load, where a misconfigured sandbox can
 * still fail loudly; a call only adds its own workspace root and narrows the
 * write grants with its per-call mode.
 *
 * @module @dsh-fleet/nix-sandbox/profile
 */

import { delimiter, isAbsolute, join, resolve as resolvePath, sep } from 'node:path'
import type {
  NixDroppedPathEntry,
  NixPathAccess,
  NixProfileRequest,
  NixSandboxHost,
  NixSandboxProfile,
  NixVisiblePath,
  ResolvedConfig,
} from './types.ts'

/**
 * Package-manager executables the confined PATH refuses to expose: the
 * installers §2.1 names (`npm`, `pip`, `apt`, `cargo`, `go`) plus their direct
 * siblings, every one of which writes a tree the flake does not own.
 *
 * Nix's own tools are deliberately absent. The flake IS the sanctioned
 * dependency source (R-8), and `nix-env` shares the `nix` store directory, so
 * blocking it by name would also remove `nix`, `nix-shell`, and `nix develop`
 * from the layer-two execution environment. Nothing `nix-env` can install
 * survives anyway: the namespace exposes no writable path but the workspace and
 * the temp root.
 */
const BLOCKED_MANAGERS: readonly string[] = [
  'apk',
  'apt',
  'apt-get',
  'brew',
  'bundle',
  'cargo',
  'choco',
  'composer',
  'conda',
  'corepack',
  'dnf',
  'dotnet',
  'dpkg',
  'flatpak',
  'gem',
  'go',
  'mamba',
  'npm',
  'nuget',
  'pacman',
  'pip',
  'pip3',
  'pipx',
  'pnpm',
  'poetry',
  'port',
  'rpm',
  'rustup',
  'scoop',
  'snap',
  'uv',
  'winget',
  'yarn',
  'yum',
  'zypper',
]

/**
 * Reject a path the profile cannot bind.
 * @param field - configuration field name used in the error message.
 * @param value - the candidate path.
 * @throws {TypeError} when the value is not absolute.
 */
function assertAbsolute(field: string, value: string): void {
  if (!isAbsolute(value)) {
    throw new TypeError(`@dsh-fleet/nix-sandbox: ${field} must be an absolute path, got ${JSON.stringify(value)}`)
  }
}

/**
 * Whether `path` is `root` or lies under it.
 * @param path - candidate descendant path.
 * @param root - the containing root.
 * @returns true when `path` is inside `root`.
 */
function isInside(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
}

/**
 * Resolve and validate the deployment's profile.
 *
 * Every configured value is checked here, so a sandbox that cannot be enforced
 * fails at load instead of degrading to unconfined execution later.
 *
 * @param config - plugin configuration after the schema applied its defaults.
 * @param host - environment, temp root, and existence probe of the host to confine on.
 * @returns the deployment-level profile; per-call workspace and mode narrowing
 *   is {@link effectiveProfile}'s job.
 * @throws {TypeError} when the profile name is empty, a path is relative or
 *   missing, a writable root overlaps the store or the temp root, an
 *   `allowPackages` entry names a manager this profile does not block, or the
 *   environment exposes no flake-provided tool directory.
 */
export function resolveProfile(config: ResolvedConfig, host: NixSandboxHost): NixSandboxProfile {
  const profileName = config.profileName.trim()
  if (profileName.length === 0) {
    throw new TypeError('@dsh-fleet/nix-sandbox: profileName must be a non-empty profile name')
  }

  assertAbsolute('storePath', config.storePath)
  if (!host.exists(config.storePath)) {
    throw new TypeError(`@dsh-fleet/nix-sandbox: storePath does not exist: ${config.storePath}`)
  }
  const storePath = resolvePath(config.storePath)

  assertAbsolute('tempRoot', host.tempRoot)
  const tempRoot = resolvePath(host.tempRoot)

  const writableRoots: string[] = []
  for (const root of config.writableRoots) {
    assertAbsolute('each writableRoots entry', root)
    const resolved = resolvePath(root)
    if (resolved === tempRoot) {
      throw new TypeError(`@dsh-fleet/nix-sandbox: writableRoots entry is the temp root, which the profile already mounts privately: ${root}`)
    }
    if (isInside(resolved, storePath) || isInside(storePath, resolved)) {
      throw new TypeError(`@dsh-fleet/nix-sandbox: writableRoots entry overlaps the read-only store: ${root}`)
    }
    if (!host.exists(resolved)) {
      throw new TypeError(`@dsh-fleet/nix-sandbox: writableRoots entry does not exist: ${root}`)
    }
    if (!writableRoots.includes(resolved)) writableRoots.push(resolved)
  }

  const allowedManagers: string[] = []
  for (const manager of config.allowPackages) {
    if (!BLOCKED_MANAGERS.includes(manager)) {
      throw new TypeError(`@dsh-fleet/nix-sandbox: allowPackages entry ${JSON.stringify(manager)} is not a package manager this profile blocks`)
    }
    if (!allowedManagers.includes(manager)) allowedManagers.push(manager)
  }

  const path: string[] = []
  const droppedPathEntries: NixDroppedPathEntry[] = []
  for (const entry of (host.env.PATH ?? '').split(delimiter)) {
    // A relative PATH entry cannot be shown to be a store directory, so it is
    // never carried into the confined environment.
    if (entry.length === 0 || !isAbsolute(entry)) continue
    const dir = resolvePath(entry)
    if (!isInside(dir, storePath) || path.includes(dir)) continue
    const managers = BLOCKED_MANAGERS.filter(manager =>
      !allowedManagers.includes(manager) && host.exists(join(dir, manager)))
    if (managers.length > 0) {
      droppedPathEntries.push({ path: dir, managers })
      continue
    }
    path.push(dir)
  }
  if (path.length === 0) {
    throw new TypeError(
      `@dsh-fleet/nix-sandbox: PATH exposes no flake-provided tool directory under ${storePath}; `
      + 'run the harness inside `nix develop` so every PATH entry comes from the flake',
    )
  }

  const visiblePaths: NixVisiblePath[] = [
    { path: storePath, access: 'read-only', role: 'store' },
    { path: tempRoot, access: 'read-write', role: 'temp' },
  ]
  for (const root of writableRoots) visiblePaths.push({ path: root, access: 'read-write', role: 'writable-root' })

  return {
    profileName,
    storePath,
    visiblePaths,
    path,
    droppedPathEntries,
    blockedManagers: [...BLOCKED_MANAGERS],
    allowedManagers,
    network: config.network ? 'enabled' : 'disabled',
  }
}

/**
 * Build the profile one call actually receives: the deployment profile plus the
 * calling session's workspace, narrowed by the per-call mode.
 *
 * The store stays read-only whatever the mode is; `read-only` turns every other
 * grant into `read-only`, so the mode's write promise and the profile's
 * visibility promise can never contradict each other.
 *
 * @param profile - deployment-level profile from {@link resolveProfile}.
 * @param request - workspace root and file-effect mode of the call.
 * @returns a new profile; `profile` is not modified.
 * @throws {TypeError} when the requested workspace root is not absolute.
 */
export function effectiveProfile(profile: NixSandboxProfile, request: NixProfileRequest = {}): NixSandboxProfile {
  const workspaceRoot = request.workspaceRoot
  if (workspaceRoot !== undefined) {
    assertAbsolute('the workspace root', workspaceRoot)
  }
  const narrow = (access: NixPathAccess): NixPathAccess =>
    request.mode === 'read-only' ? 'read-only' : access
  const store = profile.visiblePaths.filter(entry => entry.role === 'store')
  const workspace: NixVisiblePath[] = workspaceRoot === undefined ? [] : [
    { path: resolvePath(workspaceRoot), access: narrow('read-write'), role: 'workspace' },
  ]
  const rest = profile.visiblePaths
    .filter(entry => entry.role !== 'store')
    .map(entry => ({ ...entry, access: narrow(entry.access) }))
  return { ...profile, visiblePaths: [...store, ...workspace, ...rest] }
}
