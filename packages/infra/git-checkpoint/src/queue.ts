/**
 * The durable push queue: the same on-disk state `infra/scripts/push-queue.sh`
 * maintains, so either side can read and drain what the other queued.
 *
 * One entry is one line of `<repository>\t<remote>\t<ref>`. A ref is what makes
 * a queued push idempotent: pushing an already-pushed ref succeeds without a
 * change, so a retry after a crash costs one round trip and never duplicates
 * work. An entry leaves the file only after its push succeeded.
 *
 * @module @dsh-fleet/git-checkpoint/queue
 */

import { open, readFile } from 'node:fs/promises'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { PushQueueEntry } from './types.ts'

/** Permission bits of the queue file: readable by the operator running the fleet. */
const QUEUE_MODE = 0o600

/** Raised when the queue file holds a line that is not one queue entry. */
export class PushQueueError extends Error {
  /**
   * @param path - absolute queue file holding the malformed line.
   * @param line - 1-based line number of the offending entry.
   * @param detail - what makes the line unusable.
   */
  constructor(
    readonly path: string,
    readonly line: number,
    detail: string,
  ) {
    super(`push queue ${path} line ${line} is not a queue entry: ${detail}`)
    this.name = 'PushQueueError'
  }
}

/**
 * Encode one entry as a queue line, newline included.
 * @param entry - the push to queue.
 * @returns the single line this queue stores for the entry.
 */
export function encodeEntry(entry: PushQueueEntry): string {
  return `${entry.repository}\t${entry.remote}\t${entry.ref}\n`
}

/**
 * Parse a queue file's complete content.
 *
 * A final line without its newline is a write still in flight and is not yet
 * an entry; every other malformed line refuses the whole read, because
 * silently dropping it would leave a ref that never gets pushed.
 *
 * @param text - the queue file's content.
 * @param path - absolute queue file the text came from, for failures.
 * @returns the entries in file order.
 * @throws {PushQueueError} when a complete line is not a queue entry.
 */
export function parseQueue(text: string, path: string): PushQueueEntry[] {
  // `split` always yields a final element after the last newline — the
  // in-flight line when there is one, and the empty string otherwise.
  const complete = text.split('\n').slice(0, -1)
  const entries: PushQueueEntry[] = []
  for (const [index, line] of complete.entries()) {
    if (line.trim() === '') continue
    const fields = line.split('\t')
    if (fields.length !== 3 || fields.some(field => field === '')) {
      throw new PushQueueError(path, index + 1, `${fields.length} tab-separated fields`)
    }
    const [repository, remote, ref] = fields as [string, string, string]
    entries.push({ repository, remote, ref })
  }
  return entries
}

/**
 * Read every entry the queue currently holds.
 * @param path - absolute queue file.
 * @returns the entries in file order; an absent file holds none.
 * @throws {PushQueueError} when the file holds a malformed entry.
 */
export async function readQueue(path: string): Promise<PushQueueEntry[]> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return parseQueue(text, path)
}

/**
 * Append one entry, durably and immediately.
 *
 * The line is written and synced before this resolves, so a process that dies
 * right after `enqueuePush` returns still leaves the ref queued. An entry
 * already present is not written twice; duplicate suppression is advisory
 * (two processes may append the same entry concurrently) because a repeated
 * push of the same ref is harmless.
 *
 * @param path - absolute queue file.
 * @param entry - the push to queue.
 * @returns true when this call appended the entry.
 */
export async function enqueueEntry(path: string, entry: PushQueueEntry): Promise<boolean> {
  const existing = await readQueue(path)
  const line = encodeEntry(entry)
  if (existing.some(candidate => encodeEntry(candidate) === line)) return false
  const handle = await open(path, 'a', QUEUE_MODE)
  try {
    await handle.write(line)
    await handle.sync()
  } finally {
    await handle.close()
  }
  return true
}

/**
 * Drop every entry that succeeded, keeping everything else in the file.
 *
 * The queue is re-read here rather than rewritten from the caller's snapshot,
 * so an entry enqueued while a drain was running survives it.
 *
 * @param path - absolute queue file.
 * @param removed - entries whose push succeeded.
 * @returns the entries still queued afterwards.
 */
export async function removeEntries(path: string, removed: readonly PushQueueEntry[]): Promise<PushQueueEntry[]> {
  const queued = await readQueue(path)
  const dropped = new Set(removed.map(entry => encodeEntry(entry)))
  const remaining = queued.filter(entry => !dropped.has(encodeEntry(entry)))
  if (remaining.length === queued.length) return queued
  await writeFileAtomic(path, remaining.map(encodeEntry).join(''), { mode: QUEUE_MODE })
  return remaining
}
