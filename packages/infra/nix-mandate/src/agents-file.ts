/**
 * Idempotent maintenance of one delimited region inside a workspace file.
 *
 * The delimiters, not the caller, define what this module owns: text before the
 * opening delimiter and after the closing delimiter is preserved byte for byte,
 * and a file without delimiters only ever receives an appended block.
 *
 * @module @dsh-fleet/nix-mandate/agents-file
 */

import { readFile, writeFile } from 'node:fs/promises'

/** Which change one {@link ensureAgentsBlock} call made to the file. */
export type AgentsFileOutcome = 'created' | 'updated' | 'unchanged'

/** Where one file's delimited region starts and ends. */
interface BlockRegion {
  /** Index of the opening delimiter's first character. */
  readonly start: number
  /** Index one past the closing delimiter's last character. */
  readonly end: number
}

/**
 * Every index at which `needle` starts in `text`.
 * @param text - text to scan.
 * @param needle - non-empty delimiter to find.
 * @returns the matches in ascending order.
 */
function occurrences(text: string, needle: string): number[] {
  const found: number[] = []
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) found.push(at)
  return found
}

/**
 * Locate the region a marked file gives this module.
 * @param content - the file's current text.
 * @param begin - the opening delimiter.
 * @param end - the closing delimiter.
 * @returns the region, or undefined when the file carries neither delimiter.
 * @throws {Error} when the delimiters are duplicated, unbalanced, or reversed,
 * because any of those makes the owned region ambiguous and a wrong guess would
 * overwrite text this module does not own.
 */
function findRegion(content: string, begin: string, end: string): BlockRegion | undefined {
  const starts = occurrences(content, begin)
  const ends = occurrences(content, end)
  if (starts.length === 0 && ends.length === 0) return undefined
  if (starts.length !== 1 || ends.length !== 1) {
    throw new Error(`expected exactly one "${begin}" and one "${end}", found ${starts.length} and ${ends.length}`)
  }
  // The length check above leaves exactly one of each; read them without an
  // assertion so a future edit to that check cannot silence a real absence.
  const start = starts.at(0)
  const closing = ends.at(0)
  if (start === undefined || closing === undefined) {
    throw new Error(`expected exactly one "${begin}" and one "${end}"`)
  }
  if (closing < start) throw new Error(`"${end}" precedes "${begin}"`)
  return { start, end: closing + end.length }
}

/**
 * Separator that keeps an appended block its own Markdown section.
 * @param content - the text the block is appended to.
 * @returns the exact run of newlines to insert before the block.
 */
function separatorAfter(content: string): string {
  if (content.length === 0) return ''
  if (content.endsWith('\n\n')) return ''
  return content.endsWith('\n') ? '\n' : '\n\n'
}

/**
 * Text that follows a replaced region, with one normalization.
 * @param content - the file's text before replacement.
 * @param end - index one past the replaced region.
 * @returns the untouched remainder, or a single newline when only whitespace
 * followed the closing delimiter, so a block that ends the file leaves exactly
 * one trailing newline.
 */
function tailAfter(content: string, end: number): string {
  const tail = content.slice(end)
  return tail.trim().length === 0 ? '\n' : tail
}

/**
 * Whether a read failure means the file does not exist.
 * @param error - the value thrown by the read.
 * @returns true only for `ENOENT`; every other failure must reach the caller.
 */
function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

/**
 * Write `block` into `file`, creating the file when it is absent.
 *
 * A file carrying no delimiter receives the block after one blank line; a file
 * carrying the delimiters has exactly that region replaced. The file is opened
 * for writing only when the resulting text differs from the current text, so a
 * repeated call reports `unchanged` and leaves the modification time alone.
 *
 * @param file - path of the file to maintain.
 * @param block - the complete delimited block, without a trailing newline.
 * @param begin - the opening delimiter `block` starts with.
 * @param end - the closing delimiter `block` ends with.
 * @returns the change made.
 * @throws {Error} when an existing file's delimiters are ambiguous, or when the
 * file cannot be read or written.
 */
export async function ensureAgentsBlock(
  file: string,
  block: string,
  begin: string,
  end: string,
): Promise<AgentsFileOutcome> {
  let content: string | undefined
  try {
    content = await readFile(file, 'utf8')
  } catch (error) {
    if (!isMissingFile(error)) throw error
  }
  if (content === undefined) {
    await writeFile(file, `${block}\n`, 'utf8')
    return 'created'
  }
  const region = findRegion(content, begin, end)
  const next = region === undefined
    ? `${content}${separatorAfter(content)}${block}\n`
    : `${content.slice(0, region.start)}${block}${tailAfter(content, region.end)}`
  if (next === content) return 'unchanged'
  await writeFile(file, next, 'utf8')
  return 'updated'
}
