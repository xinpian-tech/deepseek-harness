/**
 * The two primitives the tmux channel is built from: running one tmux
 * subcommand with no shell in between, and reading complete NDJSON frames out
 * of a pane's output log.
 *
 * Both are deliberately free of Cordis state so the polling and framing rules
 * can be tested without a live tmux server.
 *
 * @module @dsh-fleet/tmux/panes
 */

import { open, stat } from 'node:fs/promises'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { TmuxFrame, TmuxResponseFrame } from './types.ts'

/** Outcome of one tmux subcommand. */
export interface TmuxCommandResult {
  /** Process exit code. */
  readonly code: number | null
  /** Captured stdout, decoded as UTF-8. */
  readonly stdout: string
  /** Captured stderr, decoded as UTF-8. */
  readonly stderr: string
}

/** In-memory cap for one captured tmux stream. */
const CAPTURE_BYTES = 1 << 20

/**
 * Run one tmux subcommand and collect its output.
 *
 * `argv` is passed to the process seam verbatim — never through a shell — so a
 * pane key, window name, or frame body containing shell metacharacters cannot
 * change which tmux command runs.
 *
 * @param subprocess - the subprocess seam to spawn through.
 * @param tmuxBin - tmux executable to run.
 * @param argv - arguments after the executable.
 * @param cwd - working directory of the tmux client invocation.
 * @param graceMs - termination grace period for the client process.
 * @returns the exit code and both captured streams.
 */
export async function runTmux(
  subprocess: SubprocessRuntime,
  tmuxBin: string,
  argv: readonly string[],
  cwd: string,
  graceMs: number,
): Promise<TmuxCommandResult> {
  const handle = subprocess.spawn({
    argv: [tmuxBin, ...argv],
    cwd,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: CAPTURE_BYTES },
      stderr: { maxBytes: CAPTURE_BYTES },
    },
    graceMs,
  })
  const outcome = await handle.done
  // A collect-mode spawn always publishes a reader for each collected stream,
  // but the handle types keep them optional; a missing reader is reported as
  // empty output rather than crashing the channel.
  return {
    code: outcome.exitCode,
    stdout: handle.collected.stdout?.readFrom(0).text ?? '',
    stderr: handle.collected.stderr?.readFrom(0).text ?? '',
  }
}

/**
 * Incremental reader for one pane's NDJSON frame log.
 *
 * A frame is one complete line. The reader keeps a byte offset and a partial
 * trailing line, so a poll that lands in the middle of a write returns nothing
 * for that frame and delivers it whole on a later poll. Output is treated as
 * untrusted: a line that is not a JSON object is reported as a parse failure
 * rather than thrown, because a tty artefact must not kill the channel.
 */
export class FrameLog {
  private offset = 0
  private partial = ''
  private started = false

  /**
   * @param path - absolute path of the NDJSON file the pane writes into.
   */
  constructor(readonly path: string) {}

  /**
   * Read every frame that arrived since the previous call.
   * @returns the decoded frames in arrival order, plus the lines that were not JSON objects.
   */
  async poll(): Promise<{ frames: TmuxFrame[]; malformed: string[] }> {
    if (!this.started) {
      // Wait for pipe-pane to create the file; a missing log is "no frames yet".
      try {
        await stat(this.path)
        this.started = true
      } catch {
        // The log does not exist yet; the caller polls again.
        return { frames: [], malformed: [] }
      }
    }
    let size: number
    try {
      size = (await stat(this.path)).size
    } catch {
      // The log disappeared with its pane; nothing new can arrive.
      return { frames: [], malformed: [] }
    }
    if (size < this.offset) {
      // Truncated or replaced by a fresh pane reusing the same key.
      this.offset = 0
      this.partial = ''
    }
    if (size === this.offset) return { frames: [], malformed: [] }

    const length = size - this.offset
    const buffer = Buffer.alloc(length)
    const handle = await open(this.path, 'r')
    try {
      await handle.read(buffer, 0, length, this.offset)
    } finally {
      await handle.close()
    }
    this.offset = size

    const text = this.partial + buffer.toString('utf8')
    const lines = text.split('\n')
    this.partial = lines.pop() ?? ''

    const frames: TmuxFrame[] = []
    const malformed: string[] = []
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      const decoded = decodeFrame(trimmed)
      if (decoded === undefined) malformed.push(trimmed)
      else frames.push(decoded)
    }
    return { frames, malformed }
  }
}

/**
 * Decode one NDJSON line into a frame.
 * @param line - one complete, non-empty line.
 * @returns the frame, or undefined when the line is not a JSON-RPC object.
 */
export function decodeFrame(line: string): TmuxFrame | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    // Non-JSON output belongs to the tty or to a crashed process, not to the channel.
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  if (parsed['jsonrpc'] !== '2.0') return undefined
  const id = parsed['id']
  const method = parsed['method']
  const params = parsed['params']
  const result = parsed['result']
  const error = isRpcError(parsed['error']) ? parsed['error'] : undefined
  // A frame is a JSON-RPC object carrying a numeric id (request or response)
  // or a method name (request or notification); every other member is carried
  // through untouched for the caller to read.
  if (typeof id === 'number') {
    return {
      jsonrpc: '2.0',
      id,
      ...typeof method === 'string' ? { method } : {},
      ...params === undefined ? {} : { params },
      ...result === undefined ? {} : { result },
      ...error === undefined ? {} : { error },
    }
  }
  if (typeof method === 'string') {
    return {
      jsonrpc: '2.0',
      method,
      ...params === undefined ? {} : { params },
    }
  }
  return undefined
}

/**
 * Narrow a decoded JSON value to a plain object.
 * @param value - any decoded JSON value.
 * @returns true when the value is a non-null, non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Narrow a JSON-RPC `error` member.
 * @param value - the `error` member of a decoded line.
 * @returns true when it carries the numeric code and message of a JSON-RPC error.
 */
function isRpcError(value: unknown): value is TmuxResponseFrame['error'] {
  if (!isRecord(value)) return false
  return typeof value['code'] === 'number' && typeof value['message'] === 'string'
}

/**
 * Sleep for a bounded interval.
 * @param ms - milliseconds to wait.
 * @param signal - optional cancellation; aborts the wait.
 * @returns a promise settled after the delay or on abort.
 */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}
