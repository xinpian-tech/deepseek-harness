/** Machine identity resolution, registry read-through, and the durable session record. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import MachineRegistry, { MACHINE_ID_ENV, nixSystemFor, readRegistry, resolveMachineId } from '../src/index.ts'

/** Temporary directories this file created; every one is removed after each test. */
const roots: string[] = []

/** Contexts this file mounted; every one is disposed after each test. */
const contexts: Context[] = []

/**
 * Create a temporary directory this file owns.
 * @returns the absolute path of the new directory.
 */
async function freshDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-machine-registry-'))
  roots.push(root)
  return root
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

/**
 * Write one JSON file.
 * @param path - destination path.
 * @param body - value to serialize.
 */
async function writeJson(path: string, body: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(body), 'utf8')
}

afterEach(async () => {
  delete process.env.DSH_FLEET_MACHINE_ID
  await Promise.all(contexts.splice(0).map(async (ctx) => { await ctx.fiber.dispose() }))
  await Promise.all(roots.splice(0).map(async (root) => { await rm(root, { recursive: true, force: true }) }))
})

describe('machine id resolution', () => {
  it('prefers explicit config, then the environment, then a hostid file, then the hostname', async () => {
    const dir = await freshDir()
    const hostid = join(dir, 'machine-id')
    await writeFile(hostid, 'file-id\n', 'utf8')
    const sources = { env: {}, hostidFiles: [hostid], hostname: 'host-box' }

    expect(resolveMachineId({ ...sources, explicit: 'explicit-id', env: { [MACHINE_ID_ENV]: 'env-id' } }))
      .toBe('explicit-id')
    expect(resolveMachineId({ ...sources, env: { [MACHINE_ID_ENV]: 'env-id' } })).toBe('env-id')
    expect(resolveMachineId(sources)).toBe('file-id')
    expect(resolveMachineId({ ...sources, hostidFiles: [join(dir, 'absent')] })).toBe('host-box')
  })

  it('strips whitespace, skips empty sources, and rejects an id that cannot name a ref segment', () => {
    expect(resolveMachineId({ explicit: '  spaced id  ', env: {}, hostidFiles: [], hostname: 'host-box' }))
      .toBe('spacedid')
    expect(resolveMachineId({ explicit: '   ', env: { [MACHINE_ID_ENV]: '' }, hostidFiles: [], hostname: 'host-box' }))
      .toBe('host-box')
    expect(() => resolveMachineId({ explicit: '../escape', env: {}, hostidFiles: [], hostname: 'host-box' }))
      .toThrow(/machine id must match/)
    expect(() => resolveMachineId({ env: {}, hostidFiles: [], hostname: '' }))
      .toThrow(/resolved no machine id/)
  })

  it('spells the nix system of the platform and rejects a pair it cannot spell', () => {
    expect(nixSystemFor('linux', 'x64')).toBe('x86_64-linux')
    expect(nixSystemFor('linux', 'arm64')).toBe('aarch64-linux')
    expect(nixSystemFor('darwin', 'arm64')).toBe('aarch64-darwin')
    expect(() => nixSystemFor('win32', 'x64')).toThrow(/no nix system for platform "win32" and arch "x64"/)
    expect(() => nixSystemFor('linux', 'ia32')).toThrow(/set the nixSystem config field/)
  })
})

describe('machine registry service', () => {
  it('reports the resolved machine as plain JSON', async () => {
    const ctx = freshContext()
    await ctx.plugin(MachineRegistry, { machineId: 'machine-a', alias: 'alpha' })

    const current = ctx.machines.current()
    expect(current).toEqual({
      id: 'machine-a',
      alias: 'alpha',
      nixSystem: nixSystemFor(process.platform, process.arch),
      hostname: hostname(),
    })
    expect(JSON.parse(JSON.stringify(current))).toEqual(current)
    expect(Object.isFrozen(current)).toBe(true)
  })

  it('resolves the id from the environment when no config supplies one', async () => {
    process.env[MACHINE_ID_ENV] = 'env-machine'
    const ctx = freshContext()
    await ctx.plugin(MachineRegistry, {})
    expect(ctx.machines.current().id).toBe('env-machine')
    expect(ctx.machines.current().alias).toBeUndefined()
  })

  it('loads when no session service is mounted', async () => {
    const ctx = freshContext()
    await ctx.plugin(MachineRegistry, { machineId: 'machine-a' })
    expect(ctx.machines.current().id).toBe('machine-a')
  })

  it('records the machine context on every announced session', async () => {
    const ctx = freshContext()
    await ctx.plugin(SessionStore)
    await ctx.plugin(MachineRegistry, { machineId: 'machine-a', alias: 'alpha' })

    const session = ctx.sessions.create(SessionId('session-1'))
    const recorded = session.snapshotEvents().filter(event => event.type === 'machine/context')
    expect(recorded).toHaveLength(1)
    expect(recorded[0]?.data).toEqual(ctx.machines.current())
  })

  it('unregisters the service and stops recording when its fiber is disposed', async () => {
    const ctx = freshContext()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(MachineRegistry, { machineId: 'machine-a' })
    expect(ctx.get('machines')).toBeDefined()

    await fiber.dispose()
    expect(ctx.get('machines')).toBeUndefined()
    const session = ctx.sessions.create(SessionId('session-2'))
    expect(session.snapshotEvents().some(event => event.type === 'machine/context')).toBe(false)
  })

  it('rejects an empty configured alias or nix system', async () => {
    const ctx = freshContext()
    await expect(ctx.plugin(MachineRegistry, { machineId: 'machine-a', alias: ' ' }))
      .rejects.toThrow(/alias must be a non-empty string/)
    await expect(ctx.plugin(MachineRegistry, { machineId: 'machine-a', nixSystem: ' ' }))
      .rejects.toThrow(/nixSystem must be a non-empty nix system/)
  })
})

describe('registry file', () => {
  it('lists exactly the entries in the file, re-reading it on every call', async () => {
    const dir = await freshDir()
    const file = join(dir, 'machines.json')
    await writeJson(file, {
      machines: [
        { id: 'machine-a', nixSystem: 'x86_64-linux', hostname: 'a' },
        { id: 'machine-b', alias: 'beta', nixSystem: 'aarch64-linux', hostname: 'b' },
      ],
    })
    const ctx = freshContext()
    await ctx.plugin(MachineRegistry, { machineId: 'machine-a', registryFile: file })
    expect(ctx.machines.list()).toEqual([
      { id: 'machine-a', nixSystem: 'x86_64-linux', hostname: 'a' },
      { id: 'machine-b', alias: 'beta', nixSystem: 'aarch64-linux', hostname: 'b' },
    ])

    await writeJson(file, { machines: [{ id: 'machine-c', nixSystem: 'x86_64-darwin', hostname: 'c' }] })
    expect(ctx.machines.list().map(machine => machine.id)).toEqual(['machine-c'])
    // The current machine is never invented into the registry's answer.
    expect(ctx.machines.current().id).toBe('machine-a')
  })

  it('refuses a registry that disappears or stops parsing while the process runs', async () => {
    const dir = await freshDir()
    const file = join(dir, 'machines.json')
    await writeJson(file, { machines: [{ id: 'machine-a', nixSystem: 'x86_64-linux', hostname: 'a' }] })
    const ctx = freshContext()
    await ctx.plugin(MachineRegistry, { machineId: 'machine-a', registryFile: file })

    await writeFile(file, 'not json', 'utf8')
    expect(() => ctx.machines.list()).toThrow(/cannot read registry/)
    await rm(file, { force: true })
    expect(() => ctx.machines.list()).toThrow(/cannot read registry/)
  })

  it('throws instead of implying an empty fleet when no registry file is configured', async () => {
    const ctx = freshContext()
    await ctx.plugin(MachineRegistry, { machineId: 'machine-a' })
    expect(() => ctx.machines.list()).toThrow(/no registryFile configured/)
  })

  const rejected: readonly { readonly name: string; readonly body: string; readonly pattern: RegExp }[] = [
    { name: 'an unreadable file', body: '', pattern: /cannot read registry/ },
    { name: 'unparseable JSON', body: 'not json', pattern: /cannot read registry/ },
    { name: 'a JSON array', body: '[]', pattern: /must be a JSON object/ },
    { name: 'no machines array', body: '{"hosts":[]}', pattern: /must hold a "machines" array/ },
    { name: 'a non-object entry', body: '{"machines":["machine-a"]}', pattern: /entry 0 must be a JSON object/ },
    {
      name: 'an entry without a nix system',
      body: '{"machines":[{"id":"machine-a","hostname":"a"}]}',
      pattern: /needs a non-empty nixSystem/,
    },
    {
      name: 'an empty alias',
      body: '{"machines":[{"id":"machine-a","alias":"","nixSystem":"x86_64-linux","hostname":"a"}]}',
      pattern: /alias must be a non-empty string/,
    },
    {
      name: 'an id that cannot name a ref segment',
      body: '{"machines":[{"id":"a/b","nixSystem":"x86_64-linux","hostname":"a"}]}',
      pattern: /machine id must match/,
    },
    {
      name: 'a duplicated id',
      body: '{"machines":[{"id":"machine-a","nixSystem":"x86_64-linux","hostname":"a"},{"id":"machine-a","nixSystem":"x86_64-linux","hostname":"a"}]}',
      pattern: /names machine "machine-a" twice/,
    },
  ]

  it.each(rejected)('fails at load on $name', async ({ body, pattern }) => {
    const dir = await freshDir()
    const file = join(dir, 'machines.json')
    if (body !== '') await writeFile(file, body, 'utf8')
    const ctx = freshContext()
    await expect(ctx.plugin(MachineRegistry, { machineId: 'machine-a', registryFile: file }))
      .rejects.toThrow(pattern)
  })

  it('rejects a relative registry path before reading anything', async () => {
    const ctx = freshContext()
    await expect(ctx.plugin(MachineRegistry, { machineId: 'machine-a', registryFile: 'machines.json' }))
      .rejects.toThrow(/registryFile must be an absolute path/)
  })

  it('validates a registry it reads directly', async () => {
    const dir = await freshDir()
    const file = join(dir, 'machines.json')
    await writeJson(file, { machines: [{ id: 'machine-a', nixSystem: 'x86_64-linux', hostname: 'a' }] })
    expect(readRegistry(file)).toEqual([{ id: 'machine-a', nixSystem: 'x86_64-linux', hostname: 'a' }])
  })
})
