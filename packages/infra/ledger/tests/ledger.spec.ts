/**
 * The performance ledger over both of its durable media: aggregates derived
 * from entries, persistence across two service instances pointed at the same
 * file and at the same storage backend, ranking determinism, every validation
 * rejection, and the absence of any peer-scoring write path.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import FleetLedger, { LedgerError, resolveConfig } from '../src/index.ts'
import type { Config, LedgerEntry, ScoringInput } from '../src/index.ts'

/** Temp directories created by the running test, removed in afterEach. */
const temporary: string[] = []

/** Root contexts created by the running test, disposed in afterEach. */
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true })
})

/**
 * One outcome entry with test defaults.
 * @param overrides - fields this test changes.
 * @returns the entry.
 */
function entry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    memberId: 'worker-a',
    taskId: 'task-1',
    role: 'worker',
    outcome: 'accepted',
    rounds: 1,
    recordedAt: 1_700_000_000_000,
    ...overrides,
  }
}

/**
 * One scoring input with test defaults.
 * @param overrides - fields this test changes.
 * @returns the inputs.
 */
function input(overrides: Partial<ScoringInput> = {}): ScoringInput {
  return {
    memberId: 'worker-a',
    taskId: 'task-1',
    peerSignals: [{ from: 'worker-b', taskId: 'task-1', note: 'reviewed the diff', recordedAt: 1_700_000_000_000 }],
    defects: [{ severity: 'major', count: 2 }],
    recordedAt: 1_700_000_000_000,
    ...overrides,
  }
}

/**
 * A temp directory this test owns.
 * @param prefix - directory name prefix.
 * @returns the created directory.
 */
async function tempDirectory(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  temporary.push(dir)
  return dir
}

/** One mounted ledger over the file medium. */
interface Harness {
  /** Context owning the service. */
  readonly ctx: Context
  /** The mounted service. */
  readonly ledger: FleetLedger
  /** Absolute path of the ledger file. */
  readonly file: string
}

/**
 * Mount the ledger with a file medium.
 * @param overrides - configuration fields this test changes.
 * @returns the mounted harness.
 */
async function createHarness(overrides: Partial<Config> = {}): Promise<Harness> {
  const dir = await tempDirectory('dsh-ledger-')
  const file = join(dir, 'ledger.json')
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(FleetLedger, { ledgerFile: file, maxEntries: 10, ...overrides })
  return { ctx, ledger: ctx.ledger, file }
}

/**
 * Mount the ledger over the storage seam, with the shipped JSON backend.
 * @param root - backend root shared by every instance of one medium.
 * @returns the mounted context and service.
 */
async function createStorageHarness(root: string): Promise<{ ctx: Context; ledger: FleetLedger }> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(FleetLedger, { storageBackend: 'json', storageKey: 'fleet/ledger', maxEntries: 10 })
  return { ctx, ledger: ctx.ledger }
}

describe('ledger aggregation', () => {
  it('derives every counter from the retained entries', async () => {
    const { ledger } = await createHarness()
    await ledger.record(entry({ outcome: 'accepted', rounds: 2 }))
    await ledger.record(entry({ outcome: 'reworked', rounds: 4, taskId: 'task-2' }))
    await ledger.record(entry({ outcome: 'failed', rounds: 0, taskId: 'task-3', role: 'red' }))

    const record = await ledger.recordOf('worker-a')

    expect(record).toMatchObject({ memberId: 'worker-a', accepted: 1, reworked: 1, failed: 1, meanRounds: 2 })
    expect(record?.entries.map(item => item.taskId)).toEqual(['task-1', 'task-2', 'task-3'])
    await expect(ledger.recordOf('worker-b')).resolves.toBeUndefined()
  })

  it('keeps only the newest entries within the configured bound', async () => {
    const { ledger } = await createHarness({ maxEntries: 2 })
    await ledger.record(entry({ taskId: 'task-1', outcome: 'failed' }))
    await ledger.record(entry({ taskId: 'task-2', outcome: 'accepted' }))
    await ledger.record(entry({ taskId: 'task-3', outcome: 'accepted' }))

    const record = await ledger.recordOf('worker-a')

    expect(record?.entries.map(item => item.taskId)).toEqual(['task-2', 'task-3'])
    expect(record).toMatchObject({ accepted: 2, failed: 0 })
  })
})

describe('ledger durability', () => {
  it('survives a restart when two instances point at the same file', async () => {
    const first = await createHarness()
    await first.ledger.record(entry({ outcome: 'accepted', rounds: 3 }))
    await first.ledger.recordInput(input())
    await first.ctx.fiber.dispose()

    const second = await createHarness({ ledgerFile: first.file })

    await expect(second.ledger.recordOf('worker-a')).resolves.toMatchObject({ accepted: 1, meanRounds: 3 })
    await expect(second.ledger.inputs('worker-a')).resolves.toEqual([input()])
    const stored = JSON.parse(await readFile(first.file, 'utf8'))
    expect(stored.version).toBe(1)
    expect(stored.members['worker-a'].entries).toHaveLength(1)
  })

  it('survives a restart when two instances share the storage backend root', async () => {
    const root = await tempDirectory('dsh-ledger-storage-')
    const first = await createStorageHarness(root)
    await first.ledger.record(entry({ outcome: 'reworked', rounds: 5 }))
    await first.ctx.fiber.dispose()

    const second = await createStorageHarness(root)

    await expect(second.ledger.recordOf('worker-a')).resolves.toMatchObject({ reworked: 1, meanRounds: 5 })
  })

  it('releases the storage unit when the plugin is disposed', async () => {
    const root = await tempDirectory('dsh-ledger-storage-')
    const first = await createStorageHarness(root)
    await first.ledger.record(entry())
    await first.ctx.fiber.dispose()

    // The JSON backend rejects a second open of a unit it still holds, so a
    // successful remount proves disposal closed it.
    const second = await createStorageHarness(root)

    await expect(second.ledger.recordOf('worker-a')).resolves.toMatchObject({ accepted: 1 })
  })

  it('fails load on a ledger the medium cannot read', async () => {
    const dir = await tempDirectory('dsh-ledger-')
    const file = join(dir, 'ledger.json')
    await writeFile(file, '{ not json')
    const ctx = new Context()
    contexts.push(ctx)
    await expect(ctx.plugin(FleetLedger, { ledgerFile: file, maxEntries: 10 })).rejects.toThrow(LedgerError)

    await writeFile(file, JSON.stringify({ version: 99, members: {} }))
    const other = new Context()
    contexts.push(other)
    await expect(other.plugin(FleetLedger, { ledgerFile: file, maxEntries: 10 }))
      .rejects.toThrow(/version 99/)
  })

  it('fails load when neither a ledger file nor a storage service is available', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await expect(ctx.plugin(FleetLedger, { maxEntries: 10 })).rejects.toThrow(/ledgerFile/)
  })

  it('removes the ctx.ledger registration when the plugin is disposed', async () => {
    const dir = await tempDirectory('dsh-ledger-')
    const ctx = new Context()
    contexts.push(ctx)
    const fiber = await ctx.plugin(FleetLedger, { ledgerFile: join(dir, 'ledger.json'), maxEntries: 10 })

    expect(ctx.get('ledger')).toBeInstanceOf(FleetLedger)
    await fiber.dispose()
    expect(ctx.get('ledger')).toBeUndefined()
  })
})

describe('ledger ranking', () => {
  it('orders by the documented rule and repeats that order deterministically', async () => {
    const { ledger } = await createHarness()
    // Two accepted members with the same mean rounds, and one with fewer accepted.
    await ledger.record(entry({ memberId: 'worker-b', outcome: 'accepted', rounds: 2 }))
    await ledger.record(entry({ memberId: 'worker-a', outcome: 'accepted', rounds: 2 }))
    await ledger.record(entry({ memberId: 'worker-c', outcome: 'reworked', rounds: 1 }))

    const first = await ledger.ranking()

    expect(first.map(record => record.memberId)).toEqual(['worker-a', 'worker-b', 'worker-c'])
    await expect(ledger.ranking()).resolves.toEqual(first)

    // worker-c now has one accepted outcome at a lower mean round count, so the
    // second ranking criterion moves it ahead of the tied pair.
    await ledger.record(entry({ memberId: 'worker-c', outcome: 'accepted', rounds: 0 }))
    const second = await ledger.ranking()
    expect(second.map(record => record.memberId)).toEqual(['worker-c', 'worker-a', 'worker-b'])
    expect(second.find(record => record.memberId === 'worker-c')?.meanRounds).toBe(0.5)
  })

  it('ranks the same way whatever order members were recorded in', async () => {
    const forward = await createHarness()
    for (const memberId of ['worker-a', 'worker-b', 'worker-c']) await forward.ledger.record(entry({ memberId }))

    const backward = await createHarness()
    for (const memberId of ['worker-c', 'worker-b', 'worker-a']) await backward.ledger.record(entry({ memberId }))

    expect((await backward.ledger.ranking()).map(record => record.memberId))
      .toEqual((await forward.ledger.ranking()).map(record => record.memberId))
  })
})

describe('ledger scoring inputs', () => {
  it('returns the raw inputs and leaves the aggregate untouched', async () => {
    const { ledger } = await createHarness()
    await ledger.record(entry({ outcome: 'accepted', rounds: 2 }))
    const before = await ledger.recordOf('worker-a')

    await ledger.recordInput(input())
    await ledger.recordInput(input({ defects: [{ severity: 'critical', count: 1 }], peerSignals: [] }))

    await expect(ledger.inputs('worker-a')).resolves.toEqual([
      input(),
      input({ defects: [{ severity: 'critical', count: 1 }], peerSignals: [] }),
    ])
    await expect(ledger.recordOf('worker-a')).resolves.toEqual(before)
    expect((await ledger.ranking())[0]).toEqual(before)
  })

  it('has no write path that lets a peer assign a score', async () => {
    const { ledger, file } = await createHarness()
    await ledger.record(entry())
    await ledger.recordInput(input())

    const scoring = /score|rate|rating|grade|vote|weight/i
    const surface = [
      ...Object.getOwnPropertyNames(FleetLedger.prototype),
      ...Object.getOwnPropertyNames(ledger),
    ]
    expect(surface.filter(name => scoring.test(name))).toEqual([])
    expect(surface.filter(name => ['record', 'recordInput', 'recordOf', 'ranking', 'inputs'].includes(name)).sort())
      .toEqual(['inputs', 'ranking', 'record', 'recordInput', 'recordOf'])
    // Neither the stored entries nor the stored inputs carry a score field.
    expect(await readFile(file, 'utf8')).not.toContain('"score"')
    expect(Object.keys(input())).toEqual(['memberId', 'taskId', 'peerSignals', 'defects', 'recordedAt'])
  })
})

describe('ledger validation', () => {
  it('rejects an unusable outcome entry and names the field', async () => {
    const { ledger } = await createHarness()

    await expect(ledger.record(entry({ role: 'referee' as LedgerEntry['role'] }))).rejects.toThrow(/field 'role'/)
    await expect(ledger.record(entry({ outcome: 'maybe' as LedgerEntry['outcome'] }))).rejects.toThrow(/field 'outcome'/)
    await expect(ledger.record(entry({ rounds: -1 }))).rejects.toThrow(/field 'rounds'/)
    await expect(ledger.record(entry({ rounds: 1.5 }))).rejects.toThrow(/field 'rounds'/)
    await expect(ledger.record(entry({ memberId: '' }))).rejects.toThrow(/field 'memberId'/)
    await expect(ledger.record(entry({ taskId: '' }))).rejects.toThrow(/field 'taskId'/)
    await expect(ledger.record(entry({ cost: -1 }))).rejects.toThrow(/field 'cost'/)
    await expect(ledger.record(entry({ recordedAt: -1 }))).rejects.toThrow(/field 'recordedAt'/)
    await expect(ledger.record(entry({ cost: Number.NaN }))).rejects.toThrow(TypeError)
  })

  it('rejects unusable scoring inputs and names the field', async () => {
    const { ledger } = await createHarness()

    await expect(ledger.recordInput(input({ memberId: '' }))).rejects.toThrow(/field 'memberId'/)
    await expect(ledger.recordInput(input({ peerSignals: [input().peerSignals[0]!, { from: '' } as never] })))
      .rejects.toThrow(/field 'from'/)
    await expect(ledger.recordInput(input({ defects: [{ severity: 'blocker' as never, count: 1 }] })))
      .rejects.toThrow(/field 'severity'/)
    await expect(ledger.recordInput(input({ defects: [{ severity: 'minor', count: -2 }] })))
      .rejects.toThrow(/field 'count'/)
    await expect(ledger.recordInput({ ...input(), peerSignals: 'none' as never }))
      .rejects.toThrow(/field 'peerSignals'/)
  })

  it('rejects an empty member id on every read that names one', async () => {
    const { ledger } = await createHarness()

    await expect(ledger.recordOf('')).rejects.toThrow(/memberId must be a non-empty string/)
    await expect(ledger.inputs('')).rejects.toThrow(TypeError)
  })

  it('validates its configuration at load', () => {
    expect(resolveConfig({})).toEqual({
      storageKey: 'fleet/ledger',
      ledgerFile: undefined,
      storageBackend: 'json',
      maxEntries: 200,
    })
    expect(() => resolveConfig({ storageKey: ' ' })).toThrow(/storageKey/)
    expect(() => resolveConfig({ storageBackend: '' })).toThrow(/storageBackend/)
    expect(() => resolveConfig({ ledgerFile: 'relative/ledger.json' })).toThrow(/absolute/)
    expect(() => resolveConfig({ maxEntries: 0 })).toThrow(/maxEntries/)
    expect(() => resolveConfig({ maxEntries: 2.5 })).toThrow(/maxEntries/)
  })
})
