/** Version-fingerprint resolution, digest stability, and the durable session record. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import ConfigGenerationService, {
  FLAKE_URI_ENV,
  flakeRootOf,
  nixSystemFor,
  readVendorRecord,
  type Config,
} from '../src/index.ts'

/** The checkout this test runs from: the flake default resolves to its root. */
const REPO_ROOT = resolve(fileURLToPath(new URL('../../../..', import.meta.url)))

/** The vendored llm-agents record shape `infra/nix/vendor.json` writes. */
const VENDOR = {
  url: 'github:numtide/llm-agents.nix',
  rev: 'rev-a',
  narHash: 'sha256-aaa',
  nixpkgsRev: 'nixpkgs-a',
}

/** Temporary directories this file created; every one is removed after each test. */
const roots: string[] = []

/** Contexts this file mounted; every one is disposed after each test. */
const contexts: Context[] = []

/**
 * Create a temporary directory this file owns.
 * @returns the absolute path of the new directory.
 */
async function freshDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-config-generation-'))
  roots.push(root)
  return root
}

/**
 * Create a directory that looks like a launched flake checkout.
 * @param options - lock content and vendored record to write.
 * @returns the root, lock path, and vendor path of the fixture.
 */
async function freshFlake(options: { lock?: string; vendor?: unknown } = {}): Promise<{
  root: string
  lockPath: string
  vendorPath: string
}> {
  const root = await freshDir()
  const lockPath = join(root, 'flake.lock')
  const vendorPath = join(root, 'infra', 'nix', 'vendor.json')
  await writeFile(join(root, 'flake.nix'), '{}\n', 'utf8')
  await writeFile(lockPath, options.lock ?? '{"nodes":{}}\n', 'utf8')
  await mkdir(join(root, 'infra', 'nix'), { recursive: true })
  await writeFile(vendorPath, JSON.stringify(options.vendor ?? VENDOR), 'utf8')
  return { root, lockPath, vendorPath }
}

/**
 * SHA-256 of one file's bytes, computed independently of the service.
 * @param path - absolute file path.
 * @returns the lowercase hex digest.
 */
function lockHash(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * Mount the service on a fresh context.
 * @param config - plugin configuration.
 * @returns the mounted context.
 */
async function mounted(config: Config = {}): Promise<Context> {
  const ctx = freshContext()
  await ctx.plugin(ConfigGenerationService, config)
  return ctx
}

/**
 * Create a context whose lifetime this file owns.
 * @returns the new root context.
 */
function freshContext(): Context {
  const ctx = new Context()
  contexts.push(ctx)
  return ctx
}

afterEach(async () => {
  delete process.env.DSH_FLEET_FLAKE_URI
  await Promise.all(contexts.splice(0).map(async (ctx) => { await ctx.fiber.dispose() }))
  await Promise.all(roots.splice(0).map(async (root) => { await rm(root, { recursive: true, force: true }) }))
})

describe('resolved record', () => {
  it('resolves the flake, lock hash, vendored revisions, and nix system as plain JSON', async () => {
    const { root, lockPath } = await freshFlake()
    const ctx = await mounted({ flakeUri: `path:${root}` })

    const record = ctx.configGeneration.current()
    const { recordedAt, ...fields } = record
    expect(fields).toEqual({
      flakeUri: `path:${root}`,
      flakeLockHash: lockHash(lockPath),
      llmAgentsRev: 'rev-a',
      llmAgentsNarHash: 'sha256-aaa',
      nixpkgsRev: 'nixpkgs-a',
      nixSystem: nixSystemFor(process.platform, process.arch),
      system: nixSystemFor(process.platform, process.arch),
    })
    expect(recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(JSON.parse(JSON.stringify(record))).toEqual(record)
    expect(Object.isFrozen(record)).toBe(true)
  })

  it('honours configured lock and vendor paths over the ones a path: flake names', async () => {
    const { root } = await freshFlake()
    const elsewhere = await freshDir()
    const lockPath = join(elsewhere, 'pinned.lock')
    const vendorPath = join(elsewhere, 'vendor.json')
    await writeFile(lockPath, '{"nodes":{"other":{}}}\n', 'utf8')
    await writeFile(vendorPath, JSON.stringify({ ...VENDOR, rev: 'rev-b' }), 'utf8')

    const ctx = await mounted({ flakeUri: `path:${root}`, flakeLockPath: lockPath, vendorRecordPath: vendorPath })
    expect(ctx.configGeneration.current().flakeLockHash).toBe(lockHash(lockPath))
    expect(ctx.configGeneration.current().llmAgentsRev).toBe('rev-b')
  })

  it('changes the lock hash when the lock file content changes', async () => {
    const { root, lockPath } = await freshFlake()
    const before = await mounted({ flakeUri: `path:${root}` })
    const beforeHash = before.configGeneration.current().flakeLockHash

    await writeFile(lockPath, '{"nodes":{"changed":{}}}\n', 'utf8')
    const after = await mounted({ flakeUri: `path:${root}` })
    expect(after.configGeneration.current().flakeLockHash).toBe(lockHash(lockPath))
    expect(after.configGeneration.current().flakeLockHash).not.toBe(beforeHash)
  })

  it('records the harness version a deployment pins, and folds it into the digest', async () => {
    const { root } = await freshFlake()
    const plain = await mounted({ flakeUri: `path:${root}` })
    const pinned = await mounted({ flakeUri: `path:${root}`, harnessVersion: '0.1.7-rc.2' })

    expect(plain.configGeneration.current().harnessVersion).toBeUndefined()
    expect(pinned.configGeneration.current().harnessVersion).toBe('0.1.7-rc.2')
    expect(pinned.configGeneration.digest()).not.toBe(plain.configGeneration.digest())
  })

  it('omits every field it cannot resolve instead of filling a placeholder', async () => {
    const ctx = await mounted({ flakeUri: 'github:numtide/llm-agents.nix' })
    const { recordedAt, ...fields } = ctx.configGeneration.current()
    expect(fields).toEqual({
      flakeUri: 'github:numtide/llm-agents.nix',
      nixSystem: nixSystemFor(process.platform, process.arch),
      system: nixSystemFor(process.platform, process.arch),
    })
    expect(Number.isNaN(Date.parse(recordedAt))).toBe(false)

    // A checkout with a flake.nix but neither a lock file nor a vendored record.
    const bare = await freshDir()
    await writeFile(join(bare, 'flake.nix'), '{}\n', 'utf8')
    const bareContext = await mounted({ flakeUri: `path:${bare}` })
    expect(Object.keys(bareContext.configGeneration.current()).sort())
      .toEqual(['flakeUri', 'nixSystem', 'recordedAt', 'system'])
  })

  it('omits the vendored fields a partial record does not carry', async () => {
    const { root } = await freshFlake({ vendor: { rev: 'rev-only' } })
    const ctx = await mounted({ flakeUri: `path:${root}` })
    expect(ctx.configGeneration.current().llmAgentsRev).toBe('rev-only')
    expect(ctx.configGeneration.current().llmAgentsNarHash).toBeUndefined()
    expect(ctx.configGeneration.current().nixpkgsRev).toBeUndefined()
  })
})

describe('digest', () => {
  it('is stable across calls and across mounts of one revision', async () => {
    const { root } = await freshFlake()
    const first = await mounted({ flakeUri: `path:${root}` })
    const digest = first.configGeneration.digest()

    expect(digest).toMatch(/^sha256:[0-9a-f]{16}$/)
    expect(first.configGeneration.digest()).toBe(digest)
    const again = await mounted({ flakeUri: `path:${root}` })
    expect(again.configGeneration.digest()).toBe(digest)
  })

  it('differs across revisions', async () => {
    const { root, lockPath } = await freshFlake()
    const first = await mounted({ flakeUri: `path:${root}` })
    await writeFile(lockPath, '{"nodes":{"next":{}}}\n', 'utf8')
    const next = await mounted({ flakeUri: `path:${root}` })

    expect(next.configGeneration.digest()).not.toBe(first.configGeneration.digest())
  })
})

describe('flake resolution', () => {
  it('resolves the checkout this process was launched from when nothing is configured', async () => {
    const ctx = await mounted()
    expect(ctx.configGeneration.current().flakeUri).toBe(`path:${REPO_ROOT}`)
    expect(ctx.configGeneration.current().flakeLockHash).toBe(lockHash(join(REPO_ROOT, 'flake.lock')))
    expect(ctx.configGeneration.current().llmAgentsRev)
      .toBe(readVendorRecord(join(REPO_ROOT, 'infra', 'nix', 'vendor.json')).rev)
  })

  it('reads the flake URI from the environment, and lets configuration win over it', async () => {
    const { root } = await freshFlake()
    process.env[FLAKE_URI_ENV] = 'github:numtide/llm-agents.nix'
    const fromEnv = await mounted()
    expect(fromEnv.configGeneration.current().flakeUri).toBe('github:numtide/llm-agents.nix')

    const configured = await mounted({ flakeUri: `path:${root}` })
    expect(configured.configGeneration.current().flakeUri).toBe(`path:${root}`)
  })

  it('reads a path: flake reference and ignores references that name no directory', () => {
    expect(flakeRootOf('path:/nix/store/abc-source')).toBe('/nix/store/abc-source')
    expect(flakeRootOf('path:/nix/store/abc-source?narHash=sha256-x')).toBe('/nix/store/abc-source')
    expect(flakeRootOf('path:./relative')).toBeUndefined()
    expect(flakeRootOf('github:numtide/llm-agents.nix')).toBeUndefined()
    expect(() => nixSystemFor('win32', 'x64')).toThrow(/no nix system for platform "win32" and arch "x64"/)
  })
})

describe('load failures', () => {
  it('fails loud when it cannot name the flake at all', async () => {
    const ctx = freshContext()
    await expect(ctx.plugin(ConfigGenerationService, { flakeUri: ' ' }))
      .rejects.toThrow(/flakeUri must be a non-empty flake reference/)
    await expect(ctx.plugin(ConfigGenerationService, { harnessVersion: '' }))
      .rejects.toThrow(/harnessVersion must be a non-empty version/)
    await expect(ctx.plugin(ConfigGenerationService, { nixSystem: '' }))
      .rejects.toThrow(/nixSystem must be a non-empty nix system/)
  })

  it('rejects a configured path that is relative or missing', async () => {
    const ctx = freshContext()
    await expect(ctx.plugin(ConfigGenerationService, { flakeUri: 'github:x', flakeLockPath: 'flake.lock' }))
      .rejects.toThrow(/flakeLockPath must be an absolute path/)
    await expect(ctx.plugin(ConfigGenerationService, { flakeUri: 'github:x', vendorRecordPath: 'vendor.json' }))
      .rejects.toThrow(/vendorRecordPath must be an absolute path/)

    const dir = await freshDir()
    await expect(ctx.plugin(ConfigGenerationService, { flakeUri: 'github:x', flakeLockPath: join(dir, 'absent.lock') }))
      .rejects.toThrow(/configured flakeLockPath does not exist/)
    await expect(ctx.plugin(ConfigGenerationService, { flakeUri: 'github:x', vendorRecordPath: join(dir, 'absent.json') }))
      .rejects.toThrow(/configured vendorRecordPath does not exist/)
  })

  const malformed: readonly { readonly name: string; readonly body: string; readonly pattern: RegExp }[] = [
    { name: 'unparseable JSON', body: 'not json', pattern: /cannot read/ },
    { name: 'a JSON array', body: '[]', pattern: /must be a JSON object/ },
    { name: 'a non-string revision', body: '{"rev":7}', pattern: /field rev must be a non-empty string/ },
    { name: 'an empty nixpkgs revision', body: '{"nixpkgsRev":""}', pattern: /field nixpkgsRev must be a non-empty string/ },
  ]

  it.each(malformed)('rejects a vendored record with $name', async ({ body, pattern }) => {
    const { root, vendorPath } = await freshFlake()
    await writeFile(vendorPath, body, 'utf8')
    const ctx = freshContext()
    await expect(ctx.plugin(ConfigGenerationService, { flakeUri: `path:${root}` })).rejects.toThrow(pattern)
  })
})

describe('session record', () => {
  it('records the generation on every announced session', async () => {
    const { root } = await freshFlake()
    const ctx = freshContext()
    await ctx.plugin(SessionStore)
    await ctx.plugin(ConfigGenerationService, { flakeUri: `path:${root}` })

    const session = ctx.sessions.create(SessionId('session-1'))
    const recorded = session.snapshotEvents().filter(event => event.type === 'config/generation')
    expect(recorded).toHaveLength(1)
    expect(recorded[0]?.data).toEqual(ctx.configGeneration.current())
  })

  it('unregisters the service and stops recording when its fiber is disposed', async () => {
    const { root } = await freshFlake()
    const ctx = freshContext()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(ConfigGenerationService, { flakeUri: `path:${root}` })
    expect(ctx.get('configGeneration')).toBeDefined()

    await fiber.dispose()
    expect(ctx.get('configGeneration')).toBeUndefined()
    const session = ctx.sessions.create(SessionId('session-2'))
    expect(session.snapshotEvents().some(event => event.type === 'config/generation')).toBe(false)
  })
})
