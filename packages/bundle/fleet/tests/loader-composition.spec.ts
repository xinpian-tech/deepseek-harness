import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { applyEntryPatches, entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { load } from 'js-yaml'

/**
 * Real composition coverage for the fleet bundle: the two patch documents are
 * applied over `dsh-base` with the Loader's own patch semantics, and the
 * resulting tree is checked for the properties the requirement depends on —
 * every inserted row resolves to a module this bundle declares, the removals
 * actually remove, and the delegation rows point at the tmux provider.
 *
 * This is a document-and-resolution test, not a boot: booting the full base
 * composition belongs to the app-level smoke suites. What it proves is that
 * the fleet's own layer is internally complete, which is the failure mode a
 * typo in a row name or an undeclared dependency produces.
 */

const bundleDir = new URL('../', import.meta.url)
const repoRoot = new URL('../../../../', import.meta.url)

/** One decoded row, read by field name rather than by its declared type. */
type Row = Record<string, unknown>

/** Decode one patch document from the repository. */
function readPatches(relative: string): PatchOptions[] {
  const text = readFileSync(fileURLToPath(new URL(relative, repoRoot)), 'utf8')
  return load(text, { schema: entryListSchema }) as PatchOptions[]
}

/**
 * Narrow a decoded YAML value to a plain object.
 * @param value - any decoded value.
 * @returns true for a non-null, non-array object.
 */
function isRow(value: unknown): value is Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Flatten rows, including rows nested inside group and preset `config` lists. */
function rows(entries: readonly unknown[]): Row[] {
  const found: Row[] = []
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item)
      return
    }
    if (!isRow(value)) return
    if (typeof value['id'] === 'string' || typeof value['name'] === 'string') found.push(value)
    walk(value['insert'])
    walk(value['config'])
  }
  walk(entries)
  return found
}

// `dsh-base` is itself a patch document: its rows live inside `insert` lists,
// so the composition document is what those lists contain. Applying the fleet
// patches to that document is exactly what the Loader does when it composes
// the bundle layers.
const baseDocument: EntryOptions[] = readPatches('packages/bundle/base/cordis.patch.yml')
  .flatMap(patch => patch.insert ?? [])
const removalPatches = readPatches('packages/bundle/fleet/no-messaging.cordis.patch.yml')
const compositionPatches = readPatches('packages/bundle/fleet/cordis.patch.yml')
const composed = rows(applyEntryPatches(baseDocument, [...removalPatches, ...compositionPatches], () => {}))
const fleetInserts = rows(compositionPatches.flatMap(patch => patch.insert ?? []))

/**
 * Find one row in the composed tree.
 * @param id - the row id to look up.
 * @returns the row, or undefined when the composition does not contain it.
 */
function rowById(id: string): Row | undefined {
  return composed.find(row => row['id'] === id)
}

describe('fleet composition over dsh-base', () => {
  it('inserts every fleet row without colliding with a base row id', () => {
    const baseIds = new Set(rows(baseDocument).map(row => row['id']))
    const inserted = fleetInserts.filter(row => typeof row['name'] === 'string')
    expect(inserted.length).toBeGreaterThanOrEqual(14)
    for (const row of inserted) {
      const id = row['id']
      expect(typeof id).toBe('string')
      expect(baseIds.has(id)).toBe(false)
    }
  })

  it('resolves every fleet plugin to a module this bundle depends on', () => {
    const names = [...new Set(fleetInserts.map(row => row['name']))].filter(
      (name): name is string => typeof name === 'string',
    )
    expect(names.length).toBeGreaterThanOrEqual(14)
    for (const name of names) {
      expect(name.startsWith('@dsh-fleet/')).toBe(true)
      // Resolution runs from the bundle directory, which is where the Loader
      // resolves a bundle row's specifier.
      expect(() => import.meta.resolve(name, bundleDir.href)).not.toThrow()
    }
  })

  it('removes every message-passing row the requirement lists', () => {
    for (const id of [
      'subagent-spawn-in-process',
      'subagent-fork-in-process',
      'tool-subagent-control',
      'tool-subagent-list-agents',
    ]) {
      // A platform-conditional disable is a `!!js` expression node, so any
      // value other than an explicit `false` counts as switched off.
      expect(rowById(id)?.['disabled'], `${id} must be disabled`).not.toBeUndefined()
    }
  })

  it('points every delegation row at the tmux provider', () => {
    for (const id of ['tool-subagent', 'tool-subagent-fork', 'workflow-ptc']) {
      const config = rowById(id)?.['config'] as Record<string, unknown> | undefined
      expect(config?.['provider'], `${id} provider`).toBe('tmux')
    }
    const ralph = rowById('tool-ralph')?.['config'] as Record<string, unknown> | undefined
    expect(ralph?.['subagentProvider']).toBe('tmux')
  })

  it('leaves continuable delegation off, because resuming a child needs an inbox delivery', () => {
    for (const id of ['tool-subagent', 'tool-subagent-fork']) {
      const config = rowById(id)?.['config'] as Record<string, unknown> | undefined
      expect(config?.['backgroundMode']).toBe('one-shot')
    }
  })

  it('replaces the shell executor and the sandbox provider rather than mounting a second one', () => {
    expect(rowById('bash-sandbox')?.['disabled']).not.toBeUndefined()
    expect(rowById('sandbox')?.['disabled']).not.toBeUndefined()
    expect(rowById('fleet-nix-shell')?.['name']).toBe('@dsh-fleet/nix-shell')
    expect(rowById('fleet-nix-sandbox')?.['name']).toBe('@dsh-fleet/nix-sandbox')
  })

  it('keeps the change inventory in step with the patch documents', () => {
    const manifest = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../../../infra/fleet.manifest.json', import.meta.url)), 'utf8'),
    ) as {
      removals: { id: string; row: string | null; patch: string; defensive?: boolean }[]
      changes: { id: string; package: string }[]
    }
    // Every removal that names a row must actually switch that row off; a
    // removal with no row must say why in its own note.
    for (const removal of manifest.removals) {
      // A removal with no row is code-level (nothing to switch off), and a
      // defensive one names a row dsh-base does not mount: its disable guards
      // any profile that does, so an absent row is correct rather than drift.
      if (removal.row === null) continue
      const target = rowById(removal.row)
      if (removal.defensive === true) {
        expect(target?.['disabled'] ?? true, `${removal.id}: ${removal.row} must not stay enabled`)
          .not.toBe(false)
        continue
      }
      expect(target, `${removal.id}: row ${removal.row} is absent from the composed tree`).toBeDefined()
      expect(target?.['disabled'], `${removal.id}: row ${removal.row} is not disabled`).not.toBeUndefined()
    }
    expect(manifest.changes.map(change => change.id)).toEqual(
      Array.from({ length: 17 }, (_unused, index) => `change-${String(index + 1)}`),
    )
  })

  it('carries a ConfigGeneration record row and the machine registry it quotes', () => {
    expect(rowById('fleet-config-generation')?.['name']).toBe('@dsh-fleet/config-generation')
    expect(rowById('fleet-machine-registry')?.['name']).toBe('@dsh-fleet/machine-registry')
  })
})
