/**
 * `ctx.tmux` — the fleet's real-time channel (§5.3). One member is one tmux
 * pane; frames go in through `send-keys -l` and come back through the
 * `pipe-pane` output log, newline-delimited and correlated by JSON-RPC id.
 *
 * The service owns three things the rest of the fleet must not re-implement:
 * placement (which pane belongs to which key, recorded as a durable session
 * event), the completion rule (`session/prompt` acknowledges enqueue, so
 * completion is the session's `idle` status notification), and the interrupt
 * path. It deliberately owns no message store: when a pane is gone, a call
 * fails and the caller runs its correction loop (§5.3 "没有兜底邮箱").
 *
 * @module @dsh-fleet/tmux
 */

import { mkdir } from 'node:fs/promises'
import { isAbsolute, join, resolve as resolvePath } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Session } from '@deepseek-ai/dsh-session'
import { FrameLog, delay, runTmux } from './panes.ts'
import type {
  PlaceMode,
  TmuxCompletion,
  TmuxFrame,
  TmuxPlacement,
  TmuxPlaceRequest,
  TmuxRequestFrame,
  TmuxRequestOptions,
  TmuxResponseFrame,
  TmuxSignal,
} from './types.ts'

export type * from './types.ts'

/** Configuration of the tmux channel as a deployment authors it. */
export interface Config {
  /** tmux executable (default `tmux`). */
  tmuxBin?: string
  /** tmux session every fleet pane lives in (default `dsh-fleet`). */
  sessionPrefix?: string
  /** Harness executable a pane launches (default `dsh`). */
  dshBin?: string
  /** Profile the pane's harness runs (default `sdk`). */
  profile?: string
  /** Profile patch files handed to the pane's harness, in order. */
  patches?: string[]
  /** Absolute harness home for pane processes. */
  dshHome: string
  /**
   * MachineId owning every pane this service places (§7.2). The fleet patch
   * supplies the hostid; an empty value is a load failure, because a placement
   * without an owning machine cannot be sharded or audited.
   */
  machineId: string
  /**
   * Directory holding each pane's frame log. Relative paths resolve against
   * the harness launch directory; omission uses `<dshHome>/fleet/frames`.
   */
  frameRoot?: string
  /**
   * Credential-shaped variables copied into a pane. dsh strips these from an
   * out-of-process child's environment, so a pane that must reach a model
   * provider needs them restated here (§8.2).
   */
  credentialEnv?: string[]
  /** Interval between frame-log polls (default 40 ms). */
  pollIntervalMs?: number
  /** Bound on pane creation, including the shell's own startup (default 15000 ms). */
  startTimeoutMs?: number
  /** Termination grace for tmux client processes (default 2000 ms). */
  graceMs?: number
}

/** Configuration after schema defaults have been applied. */
export interface ResolvedConfig {
  readonly tmuxBin: string
  readonly sessionPrefix: string
  readonly dshBin: string
  readonly profile: string
  readonly patches: readonly string[]
  readonly dshHome: string
  readonly machineId: string
  /** Frame-log directory; omission means `<dshHome>/fleet/frames`. */
  readonly frameRoot?: string
  readonly credentialEnv: readonly string[]
  readonly pollIntervalMs: number
  readonly startTimeoutMs: number
  readonly graceMs: number
}

/** Configuration whose every field is usable: the frame root has been derived. */
export type ValidatedConfig = ResolvedConfig & { readonly frameRoot: string }

declare module '@deepseek-ai/cordis' {
  interface Context {
    tmux: FleetTmux
  }
}

/** Raised when a pane cannot be placed, reached, or observed. */
export class TmuxChannelError extends Error {
  /**
   * @param message - operator-facing description of the channel failure.
   * @param key - the placement key the failure belongs to.
   */
  constructor(
    message: string,
    readonly key: string,
  ) {
    super(message)
    this.name = 'TmuxChannelError'
  }
}

/** Foreground commands that mean the pane is still running a shell. */
const SHELL_COMMANDS = new Set(['sh', 'bash', 'dash', 'zsh', 'fish', 'ksh', 'tmux', ''])

/** tmux window names accept these characters without quoting surprises. */
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/

/**
 * tmux panes are the fleet's real-time channel.
 *
 * @param config - authored plugin configuration.
 * @returns the validated configuration with every default applied.
 * @throws {TypeError} when a required path is missing, relative, or empty.
 */
export function resolveConfig(config: Config): ValidatedConfig {
  const resolved: ResolvedConfig = FleetTmux.Config(config)
  const dshHome = resolved.dshHome
  if (!isAbsolute(dshHome)) {
    throw new TypeError('@dsh-fleet/tmux dshHome must be an absolute path')
  }
  if (resolved.machineId.length === 0) {
    throw new TypeError('@dsh-fleet/tmux machineId must be a non-empty machine identifier')
  }
  if (resolved.patches.some(patch => !isAbsolute(patch))) {
    throw new TypeError('@dsh-fleet/tmux patches must be absolute paths')
  }
  // A relative frame root resolves against the harness launch directory once,
  // at load, so no later call can depend on the process's mutable cwd.
  return {
    ...resolved,
    frameRoot: resolvePath(resolved.frameRoot ?? join(dshHome, 'fleet', 'frames')),
  }
}

/**
 * Quote one value for a single-quoted shell word.
 * @param value - arbitrary text.
 * @returns the value wrapped so a POSIX shell reproduces it byte for byte.
 */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/** The tmux channel service. */
export class FleetTmux extends Service {
  static inject = ['subprocess']

  static Config: z<Config, ResolvedConfig> = z.object({
    tmuxBin: z.string().default('tmux'),
    sessionPrefix: z.string().default('dsh-fleet'),
    dshBin: z.string().default('dsh'),
    profile: z.string().default('sdk'),
    patches: z.array(z.string()).default([]),
    dshHome: z.string().required(),
    machineId: z.string().required(),
    frameRoot: z.string(),
    credentialEnv: z.array(z.string()).default([
      'DEEPSEEK_API_KEY',
      'DEEPSEEK_BASE_URL',
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'MOONSHOT_API_KEY',
      'GEMINI_API_KEY',
      'GOOGLE_API_KEY',
      'ZHIPUAI_API_KEY',
    ]),
    pollIntervalMs: z.natural().min(1).default(40),
    startTimeoutMs: z.natural().min(1).default(15_000),
    graceMs: z.natural().min(1).default(2000),
  })

  private readonly placements = new Map<string, TmuxPlacement>()
  private readonly logs = new Map<string, FrameLog>()
  private readonly observers = new Map<string, Set<(frame: TmuxFrame) => void>>()
  private nextFrameId = 1

  private readonly config: ValidatedConfig

  /**
   * @param ctx - owning context; `subprocess` must be available.
   * @param config - authored plugin configuration, validated here so a
   * misconfigured deployment fails at load rather than at the first
   * delegation.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'tmux')
    this.config = resolveConfig(config)
  }

  /**
   * Place a member, creating its pane when necessary.
   *
   * `resident` reuses an existing pane with the same key, which is what makes
   * a correction round resume the same worker conversation; `fresh` replaces
   * it. The caller's session receives a `tmux/placement` event so the pane map
   * survives the process that created it.
   *
   * @param key - placement key; stable for the lifetime of one member.
   * @param request - placement request (cwd, mode, optional session to record into).
   * @returns the placement, with `reused` telling the caller which path ran.
   * @throws {TmuxChannelError} when the key is unusable or tmux cannot create the pane.
   */
  async place(key: string, request: TmuxPlaceRequest): Promise<TmuxPlacement> {
    assertKey(key)
    if (!isAbsolute(request.cwd)) {
      throw new TmuxChannelError(`pane cwd must be absolute: ${request.cwd}`, key)
    }
    const existing = this.placements.get(key)
    if (existing !== undefined && request.mode === 'resident' && (await this.alive(key))) {
      // A reuse is recorded too: the durable pane map answers which member a
      // correction round was bound to, not only when a pane was created.
      const reused: TmuxPlacement = { ...existing, reused: true }
      this.record(request.recordTo, reused, request.mode)
      return reused
    }
    if (existing !== undefined) await this.release(key)

    const session = this.config.sessionPrefix
    const window = `w-${key}`
    const target = `${session}:${window}`
    const env = this.paneEnv(request.env ?? {})
    const frameDir = this.frameDir(key)
    await mkdir(frameDir, { recursive: true })
    const frameLog = join(frameDir, 'out.ndjson')

    const hasSession = await this.run(['has-session', '-t', session])
    if (hasSession.code !== 0) {
      const created = await this.run(['new-session', '-d', '-s', session, '-n', 'bootstrap'])
      if (created.code !== 0) {
        throw new TmuxChannelError(`tmux could not create session ${session}: ${created.stderr.trim()}`, key)
      }
    }

    // A pane outlives the harness process that created it: tmux keeps the
    // window, so a restarted process must adopt the window it finds rather
    // than create a second window with the same name (`new-window` happily
    // does that, and the duplicate would then fight over the frame log).
    const adopted = await this.adopt(target, key, request.mode, frameLog)
    if (adopted !== undefined) {
      this.placements.set(key, adopted)
      this.logs.set(key, new FrameLog(frameLog))
      this.record(request.recordTo, adopted, request.mode)
      return adopted
    }

    const envArgs = Object.entries(env).flatMap(([name, value]) => ['-e', `${name}=${value}`])
    // The pane's command is given to tmux at window creation rather than typed
    // into an interactive shell. Typing it leaves a window in which the shell,
    // not the harness, owns the pane's stdin, so a frame sent in that window
    // would be executed as a shell command.
    const created = await this.run([
      'new-window', '-d', '-t', session, '-n', window, '-c', request.cwd, ...envArgs, this.launchLine(),
    ])
    if (created.code !== 0) {
      throw new TmuxChannelError(`tmux could not create pane ${target}: ${created.stderr.trim()}`, key)
    }

    // The output side is attached before the harness can write, so no frame it
    // emits early can be missed.
    const piped = await this.run(['pipe-pane', '-t', target, '-o', `cat >>${shellQuote(frameLog)}`])
    if (piped.code !== 0) {
      await this.killWindow(target)
      throw new TmuxChannelError(`tmux could not pipe pane ${target}: ${piped.stderr.trim()}`, key)
    }

    await this.awaitHarness(target, key)

    const placement: TmuxPlacement = {
      key,
      machine: this.machine,
      session,
      window,
      target,
      panePid: await this.panePid(target),
      frameLog,
      reused: false,
    }
    this.placements.set(key, placement)
    this.logs.set(key, new FrameLog(frameLog))
    this.record(request.recordTo, placement, request.mode)
    return placement
  }

  /**
   * Read the placement previously created for a key.
   * @param key - placement key.
   * @returns the placement, or undefined when this process never placed it.
   */
  placement(key: string): TmuxPlacement | undefined {
    return this.placements.get(key)
  }

  /**
   * Every placement this process created, in creation order.
   * @returns an immutable snapshot.
   */
  placementsList(): readonly TmuxPlacement[] {
    return [...this.placements.values()]
  }

  /**
   * Whether the key's pane still exists in tmux.
   * @param key - placement key.
   * @returns true when tmux reports the window.
   */
  async alive(key: string): Promise<boolean> {
    const placement = this.placements.get(key)
    if (placement === undefined) return false
    const listed = await this.run(['list-windows', '-t', placement.session, '-F', '#{window_name}'])
    if (listed.code !== 0) return false
    return listed.stdout.split('\n').includes(placement.window)
  }

  /**
   * Write one NDJSON frame into a pane's stdin.
   * @param key - placement key.
   * @param frame - the frame to encode; one line, one frame.
   * @throws {TmuxChannelError} when the key was never placed.
   */
  async send(key: string, frame: TmuxFrame): Promise<void> {
    const placement = this.requirePlacement(key)
    await this.sendLine(placement.target, JSON.stringify(frame))
  }

  /**
   * Send one JSON-RPC request and wait for its completion.
   *
   * With `completion: 'session-idle'` the response frame is only the enqueue
   * acknowledgement, so the call continues until the named session reports
   * `idle` (§5.4). The response's `result` is returned in both modes.
   *
   * @param key - placement key.
   * @param method - JSON-RPC method name.
   * @param params - method parameters, encoded as JSON.
   * @param options - completion rule, session filter, deadline, cancellation.
   * @returns the response frame's `result`.
   * @throws {TmuxChannelError} on a channel fault, a JSON-RPC error, a missing pane, or a timeout.
   */
  async request<T>(
    key: string,
    method: string,
    params: unknown,
    options: TmuxRequestOptions = {},
  ): Promise<T> {
    const id = this.nextFrameId++
    const completion: TmuxCompletion = options.completion ?? 'response'
    const deadline = options.timeoutMs === undefined || options.timeoutMs <= 0
      ? Number.POSITIVE_INFINITY
      : Date.now() + options.timeoutMs
    const frame: TmuxRequestFrame = { jsonrpc: '2.0', id, method, ...params === undefined ? {} : { params } }
    await this.send(key, frame)

    const log = this.requireLog(key)
    let response: TmuxResponseFrame | undefined
    let idle = completion !== 'session-idle'
    for (;;) {
      const { frames } = await log.poll()
      this.dispatch(key, frames)
      for (const received of frames) {
        // A response carries an id and no method; an echoed request carries
        // both, and must never be accepted as the answer.
        if ('id' in received && !('method' in received) && received.id === id) {
          response = received
          continue
        }
        if (completion === 'session-idle' && isIdleNotification(received, options.sessionId)) idle = true
      }
      if (response !== undefined && idle) {
        if (response.error !== undefined) {
          throw new TmuxChannelError(
            `JSON-RPC ${method} failed (${String(response.error.code)}): ${response.error.message}`,
            key,
          )
        }
        return response.result as T
      }
      if (Date.now() >= deadline) {
        throw new TmuxChannelError(
          `tmux call ${method} timed out after ${String(options.timeoutMs ?? 0)} ms${response === undefined ? '' : ' waiting for session idle'}`,
          key,
        )
      }
      if (options.signal?.aborted === true) {
        throw new TmuxChannelError(`tmux call ${method} was aborted`, key)
      }
      if (!(await this.alive(key))) {
        // No redelivery, no mailbox: the caller observes the failure and runs
        // its correction loop (§5.3).
        throw new TmuxChannelError(`pane for ${key} disappeared during ${method}`, key)
      }
      await delay(this.config.pollIntervalMs, options.signal)
    }
  }

  /**
   * Signal a member's pane, or report that it was already gone.
   *
   * `INT` writes an interrupt character into the pane's tty, which delivers
   * SIGINT to the foreground process group; `TERM` signals that group
   * directly; `KILL` destroys the window. The outcome — including a member
   * that could not be reached — is recorded durably when a session is given.
   *
   * @param key - placement key.
   * @param signal - which signal to deliver.
   * @param recordTo - optional session receiving the `tmux/interrupt` event.
   * @returns whether the signal reached a live pane.
   */
  async interrupt(key: string, signal: TmuxSignal, recordTo?: Session): Promise<boolean> {
    const placement = this.placements.get(key)
    let delivered = false
    let reason: string | undefined
    if (placement === undefined || !(await this.alive(key))) {
      reason = 'pane is not present'
    } else if (signal === 'INT') {
      delivered = (await this.run(['send-keys', '-t', placement.target, 'C-c'])).code === 0
      if (!delivered) reason = 'tmux refused the interrupt key'
    } else if (signal === 'TERM') {
      const pid = await this.panePid(placement.target)
      delivered = signalPaneGroup(pid, 'SIGTERM')
      if (!delivered) reason = 'pane process group is gone'
    } else {
      await this.killWindow(placement.target)
      delivered = true
    }
    if (recordTo !== undefined) {
      recordTo.append('tmux/interrupt', {
        key,
        signal,
        delivered,
        ...reason === undefined ? {} : { reason },
      })
    }
    return delivered
  }

  /**
   * Destroy a member's pane and forget its placement.
   *
   * Idempotent: releasing a key that was never placed, or whose pane already
   * exited, succeeds.
   *
   * @param key - placement key.
   */
  async release(key: string): Promise<void> {
    const placement = this.placements.get(key)
    this.placements.delete(key)
    this.logs.delete(key)
    this.observers.delete(key)
    if (placement === undefined) return
    await this.killWindow(placement.target)
  }

  /** The machine id that owns every placement this process creates (§7.2). */
  get machine(): string {
    return this.config.machineId
  }

  /**
   * Watch every frame read from a pane.
   *
   * A provider that needs the notifications interleaved with its own request
   * (a child's session events, for example) subscribes here instead of reading
   * the frame log itself: two independent readers of the same file would each
   * consume frames the other needs.
   *
   * @param key - placement key.
   * @param listener - called once per frame, in arrival order.
   * @returns the disposer that unsubscribes.
   */
  observe(key: string, listener: (frame: TmuxFrame) => void): () => void {
    const listeners = this.observers.get(key) ?? new Set<(frame: TmuxFrame) => void>()
    listeners.add(listener)
    this.observers.set(key, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.observers.delete(key)
    }
  }

  /**
   * The frame log of one placement, for callers that tail the channel directly.
   * @param key - placement key.
   * @returns the incremental reader, or undefined when the key was never placed.
   */
  frameLog(key: string): FrameLog | undefined {
    return this.logs.get(key)
  }

  /**
   * Record a placement on the owning session, when one was given.
   * @param session - the delegating session, or undefined for an unowned placement.
   * @param placement - the placement to record.
   * @param mode - how the caller asked for the placement.
   */
  private record(session: Session | undefined, placement: TmuxPlacement, mode: PlaceMode): void {
    session?.append('tmux/placement', {
      key: placement.key,
      machine: placement.machine,
      session: placement.session,
      window: placement.window,
      panePid: placement.panePid,
      frameLog: placement.frameLog,
      mode,
    })
  }

  /** Fan one poll's frames out to the key's observers. */
  private dispatch(key: string, frames: readonly TmuxFrame[]): void {
    const listeners = this.observers.get(key)
    if (listeners === undefined) return
    for (const frame of frames) {
      for (const listener of listeners) listener(frame)
    }
  }

  /** Kill the tmux window, tolerating an already-dead pane. */
  private async killWindow(target: string): Promise<void> {
    await this.run(['kill-window', '-t', target])
  }

  /**
   * Write one line of literal text into a pane.
   * @param target - `session:window` target.
   * @param line - text written verbatim; tmux adds the carriage return separately.
   */
  private async sendLine(target: string, line: string): Promise<void> {
    // `-l` disables key-name lookup, so frame content is never interpreted as
    // tmux key names; the separate Enter call is what submits the line.
    await this.run(['send-keys', '-t', target, '-l', line])
    await this.run(['send-keys', '-t', target, 'Enter'])
  }

  /**
   * The command a pane runs: tty setup, then the harness with its profile and
   * patches.
   *
   * `stty -echo -icanon` is not optional. A tty echoes what is written to it,
   * and an echoed request frame is itself valid JSON — the caller would read
   * its own request back and mistake it for an answer (§5.3).
   *
   * @returns one shell word sequence, safe to hand to tmux as the pane command.
   */
  private launchLine(): string {
    const parts = [
      'stty -echo -icanon;',
      'exec',
      shellQuote(this.config.dshBin),
      '--profile',
      shellQuote(this.config.profile),
      ...this.config.patches.flatMap(patch => ['--patch', shellQuote(patch)]),
    ]
    return parts.join(' ')
  }

  /**
   * Adopt a pane this process did not create.
   *
   * A resident placement reuses the window as it stands — the harness in it,
   * its session, and the `pipe-pane` still appending to the same frame log —
   * which is what makes a correction round survive a harness restart
   * (requirement §3: tmux keeps the scene after a crash). A `fresh` placement
   * needs the window for itself, so any surviving pane is destroyed first. A
   * window that is only a shell is not adoptable: no harness is running in it.
   *
   * @param target - `session:window` target.
   * @param key - placement key.
   * @param mode - how the caller asked for the placement.
   * @param frameLog - frame-log path this placement uses.
   * @returns the adopted placement, or undefined when this process must create one.
   */
  private async adopt(
    target: string,
    key: string,
    mode: PlaceMode,
    frameLog: string,
  ): Promise<TmuxPlacement | undefined> {
    const [session, window] = splitTarget(target)
    const listed = await this.run(['list-windows', '-t', session, '-F', '#{window_name}'])
    if (listed.code !== 0 || !listed.stdout.split('\n').includes(window)) return undefined
    if (mode === 'fresh') {
      await this.killWindow(target)
      return undefined
    }
    const command = (await this.run(['list-panes', '-t', target, '-F', '#{pane_current_command}']))
      .stdout.trim().split('\n')[0] ?? ''
    if (command === '' || SHELL_COMMANDS.has(command)) {
      // The window survived but its harness did not; a shell is not a member.
      await this.killWindow(target)
      return undefined
    }
    const placement: TmuxPlacement = {
      key,
      machine: this.config.machineId,
      session,
      window,
      target,
      panePid: await this.panePid(target),
      frameLog,
      reused: true,
    }
    await this.run(['pipe-pane', '-t', target, '-o', `cat >>${shellQuote(frameLog)}`])
    return placement
  }

  /**
   * Wait until the harness owns the pane's foreground.
   *
   * tmux reports the pane's current command, so readiness is observable
   * without the harness cooperating. A pane that never leaves its shell is a
   * startup failure and must be reported here, at placement, rather than as a
   * mysterious silent channel later.
   *
   * @param target - `session:window` target.
   * @param key - placement key, for the failure message.
   * @throws {TmuxChannelError} when the harness does not take over in time.
   */
  private async awaitHarness(target: string, key: string): Promise<void> {
    const deadline = Date.now() + this.config.startTimeoutMs
    for (;;) {
      const listed = await this.run(['list-panes', '-t', target, '-F', '#{pane_current_command}'])
      const command = listed.stdout.trim().split('\n')[0] ?? ''
      if (listed.code !== 0) throw new TmuxChannelError(`pane ${target} disappeared during startup`, key)
      if (command !== '' && !SHELL_COMMANDS.has(command)) return
      if (Date.now() >= deadline) {
        throw new TmuxChannelError(
          `pane ${target} still runs ${command || 'nothing'} after ${String(this.config.startTimeoutMs)} ms`,
          key,
        )
      }
      await delay(this.config.pollIntervalMs)
    }
  }

  /** Environment entries handed to a pane: the credential allowlist plus explicit extras. */
  private paneEnv(extra: Readonly<Record<string, string>>): Record<string, string> {
    const env: Record<string, string> = { DSH_HOME: this.config.dshHome }
    for (const name of this.config.credentialEnv) {
      const value = process.env[name]
      if (value !== undefined && value !== '') env[name] = value
    }
    return { ...env, ...extra }
  }

  /** Absolute frame-log directory for one key. */
  private frameDir(key: string): string {
    return join(resolvePath(this.config.frameRoot), key)
  }

  /** The pane's top process id, or null when tmux cannot report one. */
  private async panePid(target: string): Promise<number | null> {
    const result = await this.run(['list-panes', '-t', target, '-F', '#{pane_pid}'])
    if (result.code !== 0) return null
    const parsed = Number.parseInt(result.stdout.trim().split('\n')[0] ?? '', 10)
    return Number.isSafeInteger(parsed) ? parsed : null
  }

  /** Run one tmux subcommand through the subprocess seam. */
  private run(argv: readonly string[]) {
    return runTmux(this.ctx.subprocess, this.config.tmuxBin, argv, process.cwd(), this.config.graceMs)
  }

  /** Read a placement that must exist. */
  private requirePlacement(key: string): TmuxPlacement {
    const placement = this.placements.get(key)
    if (placement === undefined) throw new TmuxChannelError(`no pane was placed for ${key}`, key)
    return placement
  }

  /** Read the frame log of a placement that must exist. */
  private requireLog(key: string): FrameLog {
    const log = this.logs.get(key)
    if (log === undefined) throw new TmuxChannelError(`no frame log for ${key}`, key)
    return log
  }
}

/**
 * Split a `session:window` target into its two names.
 * @param target - the tmux target.
 * @returns the session and window names.
 */
function splitTarget(target: string): [string, string] {
  const index = target.indexOf(':')
  return index < 0 ? [target, ''] : [target.slice(0, index), target.slice(index + 1)]
}

/**
 * Whether a notification says the named session became idle.
 * @param frame - a frame read from the channel.
 * @param sessionId - session the caller is waiting on.
 * @returns true for the matching `session.status` idle notification.
 */
function isIdleNotification(frame: TmuxFrame, sessionId: string | undefined): boolean {
  if (sessionId === undefined) return false
  if (!('method' in frame) || frame.method !== 'session.status') return false
  const params = frame.params
  if (typeof params !== 'object' || params === null) return false
  const record = params as Record<string, unknown>
  return record['sessionId'] === sessionId && record['status'] === 'idle'
}

/**
 * Signal a pane's process group.
 * @param pid - pane process id reported by tmux.
 * @param signal - signal name to deliver.
 * @returns whether the signal was delivered.
 */
function signalPaneGroup(pid: number | null, signal: NodeJS.Signals): boolean {
  if (pid === null) return false
  try {
    // tmux gives each pane a process group whose leader is the pane process,
    // so the negative pid reaches the harness and its children together.
    process.kill(-pid, signal)
    return true
  } catch {
    // The group is already gone, or the pane process is not a group leader.
    try {
      process.kill(pid, signal)
      return true
    } catch {
      // Neither the group nor the leader exists: the member is gone.
      return false
    }
  }
}

/**
 * Reject a key that cannot name a tmux window.
 * @param key - candidate placement key.
 * @throws {TypeError} when the key is empty or contains unsupported characters.
 */
function assertKey(key: string): void {
  if (!KEY_PATTERN.test(key)) {
    throw new TypeError(`tmux placement key must match ${KEY_PATTERN.source}: ${JSON.stringify(key)}`)
  }
}

export default FleetTmux
