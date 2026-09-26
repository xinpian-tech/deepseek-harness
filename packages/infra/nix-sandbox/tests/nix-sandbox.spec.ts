/**
 * The nix-only profile: the data it resolves to, the misconfigurations it
 * refuses to load with, the argv its backend produces for each seam mode, and
 * the registrations its fiber removes when it is disposed.
 *
 * The resolver suites inject the environment, the temp root, and the existence
 * probe, so the profile's decisions are pinned without depending on what the
 * host happens to have installed. The mounting and backend suites read the real
 * filesystem through a scratch store, which is what production wiring does.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import * as nixSandbox from '../src/index.ts'
import { Config, NixOnlySandboxProvider, effectiveProfile, resolveProfile } from '../src/index.ts'
import type { Config as PluginConfig, NixSandboxHost, NixSandboxProfile, ResolvedConfig } from '../src/index.ts'

/** Scratch tree standing in for a host: a store with two tool directories, a workspace, and a temp root. */
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'nix-sandbox-spec-')))
const store = join(scratch, 'store')
/** A flake-provided tool directory: `node` and nothing a package manager answers to. */
const tools = join(store, 'nodejs', 'bin')
/** A flake-provided directory that also ships package managers. */
const managers = join(store, 'nodejs-pm', 'bin')
const writableRoot = join(scratch, 'writable')
const workspace = join(scratch, 'workspace')
for (const dir of [tools, managers, writableRoot, workspace]) mkdirSync(dir, { recursive: true })
writeFileSync(join(tools, 'node'), '')
writeFileSync(join(managers, 'npm'), '')

/** The host temp root production resolution reads; the profile binds it privately. */
const tempRoot = resolve(tmpdir())

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

/**
 * Host facts over a fixed set of existing paths.
 * @param existing - absolute paths that exist.
 * @param path - the `PATH` value to resolve from.
 * @returns host facts for {@link resolveProfile}.
 */
function hostFacts(existing: readonly string[], path: string): NixSandboxHost {
  const present = new Set(existing)
  return { env: { PATH: path }, tempRoot, exists: candidate => present.has(candidate) }
}

/**
 * The schema's defaults, as the resolver receives them after the loader applied the schema.
 * @param overrides - fields to move away from the default.
 * @returns a fully populated configuration.
 */
function resolvedConfig(overrides: Partial<ResolvedConfig>): ResolvedConfig {
  // The schema filled every default; the cast records that runtime fact, exactly as `apply` does.
  return { ...(Config({}) as ResolvedConfig), ...overrides }
}

/**
 * Mount the package on a fresh root context, as a composition loader would.
 * @param config - plugin configuration.
 * @returns the provider the package registered as `ctx.sandbox`.
 * @throws {Error} when the plugin did not register the nix-only backend.
 */
async function mount(config: PluginConfig): Promise<NixOnlySandboxProvider> {
  const ctx = new Context()
  await ctx.plugin(nixSandbox, config)
  const provider = ctx.get('sandbox')
  if (!(provider instanceof NixOnlySandboxProvider)) {
    throw new Error('the plugin did not register the nix-only backend as ctx.sandbox')
  }
  return provider
}

/** The workspace-write policy a confined call carries. */
const workspaceWrite: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: workspace }

describe('nix-only profile resolution', () => {
  it('defaults every configuration field to the nix-only value', () => {
    expect(Config({})).toEqual({
      profileName: 'nix-only',
      storePath: '/nix/store',
      writableRoots: [],
      network: false,
      allowPackages: [],
    })
  })

  it('resolves the default profile: store read-only, private temp, store-only PATH, network off', () => {
    const profile = resolveProfile(resolvedConfig({}), hostFacts(
      ['/nix/store', join('/nix/store/aaa-node/bin', 'node'), join('/nix/store/bbb-npm/bin', 'npm')],
      ['/nix/store/aaa-node/bin', '/nix/store/bbb-npm/bin', '/usr/bin', 'tools/bin', ''].join(delimiter),
    ))

    expect(profile).toEqual({
      profileName: 'nix-only',
      storePath: '/nix/store',
      visiblePaths: [
        { path: '/nix/store', access: 'read-only', role: 'store' },
        { path: tempRoot, access: 'read-write', role: 'temp' },
      ],
      path: ['/nix/store/aaa-node/bin'],
      droppedPathEntries: [{ path: '/nix/store/bbb-npm/bin', managers: ['npm'] }],
      blockedManagers: expect.arrayContaining(['apt', 'cargo', 'go', 'npm', 'pip']),
      allowedManagers: [],
      network: 'disabled',
    })
  })

  it('resolves an overridden profile: extra writable root, network opt-in, allowPackages weakening', () => {
    const profile = resolveProfile(resolvedConfig({
      profileName: 'fleet-strict',
      writableRoots: ['/srv/fleet'],
      network: true,
      allowPackages: ['npm'],
    }), hostFacts(
      ['/nix/store', '/srv/fleet', join('/nix/store/bbb-npm/bin', 'npm')],
      '/nix/store/bbb-npm/bin',
    ))

    expect(profile.profileName).toBe('fleet-strict')
    expect(profile.network).toBe('enabled')
    expect(profile.allowedManagers).toEqual(['npm'])
    expect(profile.visiblePaths).toEqual([
      { path: '/nix/store', access: 'read-only', role: 'store' },
      { path: tempRoot, access: 'read-write', role: 'temp' },
      { path: '/srv/fleet', access: 'read-write', role: 'writable-root' },
    ])
    // The directory stays on the PATH because its only manager was opted back in.
    expect(profile.path).toEqual(['/nix/store/bbb-npm/bin'])
    expect(profile.droppedPathEntries).toEqual([])
  })

  it('adds the calling session workspace and narrows every grant under a read-only call', () => {
    const profile = resolveProfile(resolvedConfig({ storePath: store, writableRoots: [writableRoot] }), hostFacts(
      [store, writableRoot, join(tools, 'node')],
      tools,
    ))

    // The deployment profile has no workspace; a call without one adds nothing.
    expect(effectiveProfile(profile).visiblePaths).toEqual(profile.visiblePaths)

    expect(effectiveProfile(profile, { workspaceRoot: '/ws/fleet', mode: 'workspace-write' }).visiblePaths).toEqual([
      { path: store, access: 'read-only', role: 'store' },
      { path: '/ws/fleet', access: 'read-write', role: 'workspace' },
      { path: tempRoot, access: 'read-write', role: 'temp' },
      { path: writableRoot, access: 'read-write', role: 'writable-root' },
    ])

    expect(effectiveProfile(profile, { workspaceRoot: '/ws/fleet', mode: 'read-only' }).visiblePaths).toEqual([
      { path: store, access: 'read-only', role: 'store' },
      { path: '/ws/fleet', access: 'read-only', role: 'workspace' },
      { path: tempRoot, access: 'read-only', role: 'temp' },
      { path: writableRoot, access: 'read-only', role: 'writable-root' },
    ])

    // Narrowing a call never rewrites the deployment profile it derived from.
    expect(profile.visiblePaths).toEqual([
      { path: store, access: 'read-only', role: 'store' },
      { path: tempRoot, access: 'read-write', role: 'temp' },
      { path: writableRoot, access: 'read-write', role: 'writable-root' },
    ])
  })

  it('rejects a workspace root that is not absolute', () => {
    const profile: NixSandboxProfile = resolveProfile(resolvedConfig({ storePath: store }), hostFacts(
      [store, join(tools, 'node')],
      tools,
    ))
    expect(() => effectiveProfile(profile, { workspaceRoot: 'ws/fleet' }))
      .toThrow(/workspace root must be an absolute path/)
  })
})

describe('nix-only load validation', () => {
  const load = (config: PluginConfig) => new Context().plugin(nixSandbox, config)

  it('rejects a relative store path', async () => {
    await expect(load({ storePath: 'nix/store' })).rejects.toThrow(/storePath must be an absolute path/)
  })

  it('rejects a store path that does not exist', async () => {
    await expect(load({ storePath: join(scratch, 'missing-store') })).rejects.toThrow(/storePath does not exist/)
  })

  it('rejects an empty profile name', async () => {
    await expect(load({ storePath: store, profileName: '   ' })).rejects.toThrow(/profileName must be a non-empty/)
  })

  it('rejects a relative writable root', async () => {
    await expect(load({ storePath: store, writableRoots: ['srv/fleet'] }))
      .rejects.toThrow(/writableRoots entry must be an absolute path/)
  })

  it('rejects a writable root that does not exist', async () => {
    await expect(load({ storePath: store, writableRoots: [join(scratch, 'missing-root')] }))
      .rejects.toThrow(/writableRoots entry does not exist/)
  })

  it('rejects a writable root inside the read-only store', async () => {
    await expect(load({ storePath: store, writableRoots: [tools] }))
      .rejects.toThrow(/overlaps the read-only store/)
  })

  it('rejects a writable root that contains the read-only store', async () => {
    await expect(load({ storePath: store, writableRoots: [scratch] }))
      .rejects.toThrow(/overlaps the read-only store/)
  })

  it('rejects the temp root as a writable root', async () => {
    await expect(load({ storePath: store, writableRoots: [tempRoot] }))
      .rejects.toThrow(/is the temp root/)
  })

  it('rejects an allowPackages entry that names no manager this profile blocks', async () => {
    await expect(load({ storePath: store, allowPackages: ['nix-env'] }))
      .rejects.toThrow(/not a package manager this profile blocks/)
  })

  it('rejects an environment with no flake-provided tool directory', async () => {
    vi.stubEnv('PATH', ['/usr/bin', '/bin', 'tools/bin'].join(delimiter))
    await expect(load({ storePath: store })).rejects.toThrow(/PATH exposes no flake-provided tool directory/)
  })
})

describe('nix-only backend', () => {
  it('wraps a workspace-write call in the store, the workspace, and a private temp root', async () => {
    vi.stubEnv('PATH', [tools, managers, '/usr/bin'].join(delimiter))
    const provider = await mount({ storePath: store })
    provider.internals = { probeBwrap: () => true }

    const confined = await provider.confine(['bash', '-c', 'echo hi'], workspaceWrite)

    expect(confined.argv).toEqual([
      'bwrap', '--die-with-parent', '--unshare-pid', '--dev', '/dev', '--proc', '/proc',
      '--tmpfs', tempRoot, '--setenv', 'TMPDIR', tempRoot,
      '--ro-bind', store, store,
      '--bind', workspace, workspace,
      '--unshare-net',
      '--setenv', 'PATH', tools,
      '--', 'bash', '-c', 'echo hi',
    ])
    expect(confined.enforcement).toBe('full')
    expect(confined.denialSignatures).toEqual(['read-only file system', 'permission denied'])
    expect(confined.runnerFailureRules).toEqual([{ fatalSignatures: ['bwrap: '] }])
  })

  it('grants no writes under a read-only call', async () => {
    vi.stubEnv('PATH', tools)
    const provider = await mount({ storePath: store })
    provider.internals = { probeBwrap: () => true }

    const confined = await provider.confine(['true'], { mode: 'read-only', workspaceRoot: workspace })

    expect(confined.argv).toEqual([
      'bwrap', '--die-with-parent', '--unshare-pid', '--dev', '/dev', '--proc', '/proc',
      '--tmpfs', tempRoot, '--remount-ro', tempRoot, '--setenv', 'TMPDIR', tempRoot,
      '--ro-bind', store, store,
      '--ro-bind', workspace, workspace,
      '--unshare-net',
      '--setenv', 'PATH', tools,
      '--', 'true',
    ])
  })

  it('shares the network namespace only when the deployment opted in', async () => {
    vi.stubEnv('PATH', tools)
    const provider = await mount({ storePath: store, network: true })
    provider.internals = { probeBwrap: () => true }

    const confined = await provider.confine(['true'], workspaceWrite)

    expect(confined.argv).not.toContain('--unshare-net')
  })

  it('fails closed when the runner probe rejects the profile', async () => {
    vi.stubEnv('PATH', tools)
    const provider = await mount({ storePath: store })
    provider.internals = { probeBwrap: () => false }

    await expect(provider.confine(['true'], workspaceWrite)).rejects.toBeInstanceOf(SandboxUnavailableError)
  })

  it('fails closed on a platform with no namespace runner', async () => {
    vi.stubEnv('PATH', tools)
    const provider = await mount({ storePath: store })
    provider.internals = { platform: 'darwin', probeBwrap: () => true }

    await expect(provider.confine(['true'], workspaceWrite)).rejects.toBeInstanceOf(SandboxUnavailableError)
  })

  it('fails closed before resolving a call that was already aborted', async () => {
    vi.stubEnv('PATH', tools)
    const provider = await mount({ storePath: store })
    provider.internals = { probeBwrap: () => true }

    await expect(provider.confine(['true'], workspaceWrite, AbortSignal.abort())).rejects.toThrow()
  })
})

describe('nix-only mounting', () => {
  it('answers the effective profile through ctx.fleetSandbox and removes both registrations on dispose', async () => {
    vi.stubEnv('PATH', [tools, managers].join(delimiter))
    const ctx = new Context()
    const fiber = await ctx.plugin(nixSandbox, { storePath: store })

    expect(ctx.get('sandbox')).toBeInstanceOf(NixOnlySandboxProvider)
    const profile = ctx.get('fleetSandbox')?.profile({ workspaceRoot: workspace, mode: 'workspace-write' })
    expect(profile).toEqual({
      profileName: 'nix-only',
      storePath: store,
      visiblePaths: [
        { path: store, access: 'read-only', role: 'store' },
        { path: workspace, access: 'read-write', role: 'workspace' },
        { path: tempRoot, access: 'read-write', role: 'temp' },
      ],
      path: [tools],
      droppedPathEntries: [{ path: managers, managers: ['npm'] }],
      blockedManagers: expect.arrayContaining(['npm']),
      allowedManagers: [],
      network: 'disabled',
    })

    await fiber.dispose()

    expect(ctx.get('sandbox')).toBeUndefined()
    expect(ctx.get('fleetSandbox')).toBeUndefined()
  })
})
