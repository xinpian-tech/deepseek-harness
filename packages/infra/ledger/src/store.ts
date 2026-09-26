/**
 * The two durable media a ledger can live in: one JSON file at an absolute
 * path, or one record of a single-layout KV unit on the storage seam.
 *
 * Both hold the same document, so `ledgerFile` selects where the ledger is
 * durable and changes nothing else about it. A medium reads whole documents and
 * replaces them whole; validation of the decoded document belongs to
 * `validate.ts` and runs on every read, because a durable file and a storage
 * record are both untrusted input.
 *
 * @module @dsh-fleet/ledger/store
 */

import { readFile } from 'node:fs/promises'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { KvUnit, Storage } from '@deepseek-ai/dsh-storage'
import { LedgerError } from './errors.ts'
import type { LedgerDocument } from './types.ts'
import { decodeLedgerDocument } from './validate.ts'

/** Format version stamped on every ledger document. */
export const LEDGER_VERSION = 1

/** Unit name of the ledger's home on the storage seam; the hub requires this name form. */
export const LEDGER_UNIT = 'fleet_ledger'

/** Table holding the ledger document inside that unit. */
export const LEDGER_TABLE = 'ledger'

/**
 * The empty ledger a medium with no stored document reads as.
 * @returns a document with no members.
 */
export function emptyLedger(): LedgerDocument {
  return { version: LEDGER_VERSION, members: {} }
}

/**
 * One durable home for the whole ledger.
 *
 * A medium owns one document; the service serializes its own writes, so a
 * medium never merges concurrent ones.
 */
export interface LedgerMedium {
  /**
   * Read the stored document.
   * @returns the ledger, or the empty ledger when nothing was stored yet.
   */
  read(): Promise<LedgerDocument>

  /**
   * Replace the stored document.
   * @param document - the complete new ledger.
   * @returns resolution after the replacement is durable.
   */
  write(document: LedgerDocument): Promise<void>

  /**
   * Release the medium. Idempotent.
   * @returns resolution after the medium is released.
   */
  close(): Promise<void>
}

/** The ledger as one JSON file at a configured absolute path. */
export class FileLedgerMedium implements LedgerMedium {
  /**
   * @param file - absolute path of the ledger file; its directory is created on first write.
   */
  constructor(readonly file: string) {}

  /**
   * Read the ledger file.
   * @returns the stored ledger, or the empty ledger when the file does not exist.
   * @throws {LedgerError} when the file exists but does not hold a readable ledger.
   */
  async read(): Promise<LedgerDocument> {
    let text: string
    try {
      text = await readFile(this.file, 'utf8')
    } catch (error) {
      // A ledger file that was never written is an empty ledger; every other
      // read failure is a medium fault the caller must see.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyLedger()
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      throw new LedgerError(
        'malformed-ledger',
        `${this.file} is not JSON: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    return decodeLedgerDocument(parsed, this.file, LEDGER_VERSION)
  }

  /**
   * Replace the ledger file.
   * @param document - the complete new ledger.
   * @returns resolution after the replacement is durable.
   */
  async write(document: LedgerDocument): Promise<void> {
    await writeFileAtomic(this.file, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
  }

  /**
   * Release the file medium. The file itself is the durable data and stays.
   * @returns resolution immediately.
   */
  close(): Promise<void> {
    return Promise.resolve()
  }
}

/** The ledger as one record of one single-layout KV unit on the storage seam. */
export class StorageLedgerMedium implements LedgerMedium {
  /**
   * @param unit - the opened unit holding the ledger record.
   * @param storageKey - record key whose value is the whole ledger document.
   */
  constructor(
    readonly unit: KvUnit,
    readonly storageKey: string,
  ) {}

  /**
   * Read the ledger record.
   * @returns the stored ledger, or the empty ledger when the record was never written.
   * @throws {LedgerError} when the record does not hold a readable ledger.
   */
  async read(): Promise<LedgerDocument> {
    const all = await this.unit.loadAll()
    const table = all.tables[LEDGER_TABLE]
    const record = table === undefined ? undefined : table[this.storageKey]
    if (record === undefined) return emptyLedger()
    return decodeLedgerDocument(record, `storage record '${this.storageKey}'`, LEDGER_VERSION)
  }

  /**
   * Replace the ledger record.
   * @param document - the complete new ledger.
   * @returns resolution after the write is durable.
   */
  async write(document: LedgerDocument): Promise<void> {
    await this.unit.putRecord(LEDGER_TABLE, this.storageKey, document)
  }

  /**
   * Release the unit.
   * @returns resolution after the unit is closed.
   */
  async close(): Promise<void> {
    await this.unit.close()
  }
}

/**
 * Open the ledger's home on the storage seam.
 *
 * The unit name is fixed and the record key is the configured `storageKey`, so
 * one deployment can route the ledger to any mounted backend without changing
 * what the ledger is.
 *
 * @param storage - the mounted storage hub.
 * @param backendName - registered backend serving the ledger unit.
 * @param storageKey - record key whose value is the whole ledger document.
 * @returns the opened medium, owned by the caller until it closes it.
 * @throws {LedgerError} when the named backend serves no key-value facet.
 * @throws {StorageError} when no backend is registered under that name.
 */
export async function openStorageMedium(
  storage: Storage,
  backendName: string,
  storageKey: string,
): Promise<StorageLedgerMedium> {
  const backend = storage.backend.get(backendName)
  const kv = backend.kv
  if (kv === undefined) {
    throw new LedgerError(
      'storage-unavailable',
      `storage backend '${backendName}' serves no key-value facet, so it cannot hold ledger '${storageKey}'`,
    )
  }
  const unit = await kv.open({
    name: LEDGER_UNIT,
    version: LEDGER_VERSION,
    tables: [LEDGER_TABLE],
    hasGlobal: false,
    layout: 'single',
  })
  return new StorageLedgerMedium(unit, storageKey)
}
