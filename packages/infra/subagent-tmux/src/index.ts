/**
 * The fleet's ONLY delegation provider (§3, §11 item 1).
 *
 * Every child is a complete `dsh --profile sdk` process living in a tmux pane:
 * the caller writes NDJSON frames into the pane's stdin and reads the child's
 * frames back from its `pipe-pane` log. Two session semantics exist, and the
 * difference is the whole point of the design:
 *
 * - `fresh` — a new pane and a new child session per call, reclaimed when the
 *   run settles. This is an ordinary workflow `agent()` call.
 * - `resident` — the same pane and the same child session are reused for a
 *   given task key, so a correction round continues the SAME conversation
 *   rather than restarting it (§4 invariant R-4: reworking wakes the original
 *   agent; a restart loses its context and the loop never converges).
 *
 * Completion is never the `session/prompt` response: that response only
 * acknowledges that the prompt was enqueued (§5.4). The run completes when the
 * child session reports `idle`, which is what the provider waits for.
 *
 * @module @dsh-fleet/subagent-tmux
 */

import { createHash, randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  InitializeParams,
  InitializeResult,
  SessionEventNotification,
  SessionPromptParams,
  SessionPromptResult,
} from '@deepseek-ai/dsh-sdk-protocol'
import type { SessionEvent, SessionId, TurnEndReason } from '@deepseek-ai/dsh-session'
import {
  AssistantOutputFold,
  NO_START_CAPABILITIES,
  resolveChildCwd,
  settleRunResult,
  subprocessRunHandle,
} from '@deepseek-ai/dsh-subagent'
import type {
  SubagentCapabilities,
  SubagentProvider,
  SubagentResult,
  SubagentRun,
  SubagentStartRequest,
  SubagentStopReason,
} from '@deepseek-ai/dsh-subagent'
// The channel contract is owned by `@dsh-fleet/tmux`; this is a type-only
// import, so no runtime edge crosses between the two plugins.
import type { TmuxFrame, TmuxPlacement } from '@dsh-fleet/tmux'

export const name = 'subagent-tmux'
export const inject = ['subagents', 'tmux']

/** Configuration of the tmux delegation provider. */
export interface Config {
  /** Provider name on `ctx.subagents` (default `tmux`). */
  providerName?: string
  /**
   * Session semantics for a start (default `fresh`). `resident` reuses the
   * pane and child session keyed by the delegating session plus the task key,
   * which is how a correction round resumes the same worker conversation.
   */
  sessionMode?: 'fresh' | 'resident'
  /** Prefix of a pane key; the full key also carries the parent session and task key. */
  paneKeyPrefix?: string
  /** Working directory override for the pane and its child session. */
  cwd?: string
  /** Provider route the child runtime initializes with (default `deepseek-official`). */
  provider?: string
  /** Model the child runtime initializes with (default `deepseek-v4-flash`). */
  model?: string
  /** Optional adapter-owned reasoning effort for the child route. */
  reasoningEffort?: string
  /** Optional output-token cap for the child runtime. */
  maxTokens?: number
  /** Extra environment entries handed to the pane, on top of the pane's own allowlist. */
  env?: Record<string, string>
  /** Bound (ms) on pane startup and the initialize handshake (default 120000). */
  startTimeoutMs?: number
  /** Bound (ms) on one child turn; `0` waits indefinitely (default 0). */
  turnTimeoutMs?: number
  /** Grace (ms) for signaling a pane during disposal (default 5000). */
  disposeGraceMs?: number
}

/** Config schema; every field is deployment-configurable, none is a hidden constant. */
export const Config: z<Config> = z.object({
  providerName: z.string().default('tmux'),
  sessionMode: z.union([z.const('fresh'), z.const('resident')]).default('fresh'),
  paneKeyPrefix: z.string().default('worker'),
  cwd: z.string(),
  provider: z.string().default('deepseek-official'),
  model: z.string().default('deepseek-v4-flash'),
  reasoningEffort: z.string(),
  maxTokens: z.number().step(1).min(1),
  env: z.dict(z.string()).default({}),
  startTimeoutMs: z.number().default(120_000),
  turnTimeoutMs: z.number().default(0),
  disposeGraceMs: z.number().default(5000),
})

/** Configuration after schemastery applied its defaults. */
interface ResolvedConfig {
  readonly providerName: string
  readonly sessionMode: 'fresh' | 'resident'
  readonly paneKeyPrefix: string
  readonly cwd: string | undefined
  readonly provider: string
  readonly model: string
  readonly reasoningEffort: string | undefined
  readonly maxTokens: number | undefined
  readonly env: Record<string, string>
  readonly startTimeoutMs: number
  readonly turnTimeoutMs: number
  readonly disposeGraceMs: number
}

/**
 * The tmux provider claims exactly one start feature: an explicit route.
 *
 * A route can be honored because a freshly placed pane initializes with it.
 * Everything else — parent-history seeding, a child-side tool filter, a child
 * persona, a depth budget enforced inside the child — would have to cross the
 * pane boundary, and a pane is a separate process with its own composition.
 */
const TMUX_START_CAPABILITIES: SubagentCapabilities = Object.freeze({
  ...NO_START_CAPABILITIES,
  agentOptions: true,
})

/**
 * One child session id per resident key, stable across correction rounds.
 * @param parentSessionId - the delegating session.
 * @param taskKey - the task the pane is bound to.
 * @returns the child session id a resident start adopts.
 */
function residentSessionId(parentSessionId: string, taskKey: string): string {
  const digest = createHash('sha256').update(`${parentSessionId}\u0000${taskKey}`).digest('hex')
  return `session-${digest.slice(0, 32)}`
}

/**
 * Derive a tmux-safe pane key from an arbitrary task key.
 * @param prefix - configured key prefix.
 * @param raw - the parent session and task key that identify the member.
 * @returns a key inside tmux's accepted window-name alphabet.
 */
function paneKey(prefix: string, raw: string): string {
  const digest = createHash('sha256').update(raw).digest('hex').slice(0, 12)
  const readable = raw.replaceAll(/[^A-Za-z0-9_.-]/gu, '-').slice(-24)
  return `${prefix}-${readable}-${digest}`
}

/**
 * Map a child turn's end reason onto the seam's stop reasons.
 * @param reason - the child's `turn/end` reason, when the run produced one.
 * @returns the stop reason the parent observes.
 */
function stopReasonOf(reason: TurnEndReason | undefined): SubagentStopReason {
  switch (reason?.kind) {
    case 'completed':
      return 'completed'
    case 'max-tokens':
      return 'max-tokens'
    case 'aborted':
      return 'aborted'
    case 'blocked':
      return 'refusal'
    case 'error':
      return 'error'
    default:
      // `interrupted`, `forked`, and any plugin-added variant are not a normal
      // completion of the work the caller asked for.
      return 'error'
  }
}

/**
 * Decode a channel frame into the child's session event, when it is one.
 * @param frame - a frame read from the pane.
 * @param sessionId - the child session this run owns.
 * @returns the notification, or undefined for any other frame.
 */
function asSessionEvent(frame: TmuxFrame, sessionId: string): SessionEventNotification | undefined {
  if (!('method' in frame) || frame.method !== 'session.event') return undefined
  const params = frame.params
  if (typeof params !== 'object' || params === null || Array.isArray(params)) return undefined
  const record = params as Record<string, unknown>
  const event = record['event']
  if (record['sessionId'] !== sessionId || event === undefined) return undefined
  // The notification carries a session event verbatim; the fold reads only its
  // `type` and `data`, and a malformed event contributes nothing to the fold.
  return { sessionId, event: event as SessionEvent }
}

/** The delegation provider over tmux panes. */
class TmuxSubagentProvider implements SubagentProvider {
  readonly capabilities = TMUX_START_CAPABILITIES
  readonly inheritsParentContext = false
  readonly agentRouteDefaults: Readonly<{ provider: string; model: string }>

  private readonly routes = new Map<string, { provider: string; model: string }>()

  /**
   * @param name - registry name on `ctx.subagents`.
   * @param ctx - owning context, with `ctx.tmux` available.
   * @param config - validated provider configuration.
   */
  constructor(
    readonly name: string,
    private readonly ctx: Context,
    private readonly config: ResolvedConfig,
  ) {
    this.agentRouteDefaults = Object.freeze({ provider: config.provider, model: config.model })
  }

  /**
   * Start one child on a pane and publish its run.
   * @param request - the resolved start request from the subagent service.
   * @returns the published run; the caller owns it until `dispose()`.
   * @throws when the pane cannot be placed or the child handshake fails before publication.
   */
  async start(request: SubagentStartRequest): Promise<SubagentRun> {
    if (request.signal.aborted) {
      throw new Error('subagent request was aborted before the tmux child started')
    }
    const parentSessionId = String(request.parent.session.id)
    const taskKey = request.label ?? String(request.parent.session.id)
    const key = paneKey(this.config.paneKeyPrefix, `${parentSessionId}:${taskKey}`)
    const cwd = resolveChildCwd('subagent-tmux', this.config.cwd, request.parent.session.header.cwd)
    const mode = this.config.sessionMode

    const placement = await this.ctx.tmux.place(key, {
      cwd,
      mode,
      env: this.config.env,
      recordTo: request.parent.session,
    })

    // Run identity lives in the parent namespace (the pane's own session id is
    // private to the child process); a resident pane reuses one child session
    // so its conversation continues across correction rounds.
    const id = brandString<SessionId>(randomUUID())
    const childSessionId = mode === 'resident'
      ? residentSessionId(parentSessionId, taskKey)
      : `session-${randomUUID().replaceAll('-', '')}`

    const fold = new AssistantOutputFold()
    const observed: TurnEndReason[] = []
    const unsubscribe = this.ctx.tmux.observe(key, (frame: TmuxFrame) => {
      const notification = asSessionEvent(frame, childSessionId)
      if (notification === undefined) return
      fold.push(notification.event)
      if (notification.event.type === 'turn/end') observed.push(notification.event.data.reason)
    })

    // Cancellation and disposal are separate facts: aborting the request means
    // the outstanding work must stop, while disposing a run whose turn already
    // finished must leave a resident worker ready for the next round.
    const flags = { cancelled: false, disposed: false }
    const onAbort = (): void => {
      flags.cancelled = true
    }
    const requestCancel = (): void => {
      flags.disposed = true
    }
    request.signal.addEventListener('abort', onAbort, { once: true })

    // Everything before this point is private to the start; a failure here must
    // leave no half-placed pane behind for the next correction round to trip on.
    try {
      await this.initialize(placement, key, cwd, request.agentOptions, request.signal, mode)
    } catch (error: unknown) {
      unsubscribe()
      request.signal.removeEventListener('abort', onAbort)
      await this.ctx.tmux.release(key)
      throw error
    }

    const collectOutput = (): readonly ContentBlock[] => fold.collect() ?? []
    let diagnostic: string | undefined
    // Whether the child turn itself finished. A resident pane is only
    // interrupted when work is still outstanding; an idle worker is left
    // ready for the correction round that is the point of residency.
    const turn = { finished: false }

    const result: Promise<SubagentResult> = settleRunResult({
      attempt: async () => {
        const prompt: SessionPromptParams = {
          sessionId: childSessionId,
          contentBlocks: [...request.prompt],
        }
        try {
          await this.ctx.tmux.request<SessionPromptResult>(key, 'session/prompt', prompt, {
            sessionId: childSessionId,
            // The response is only the enqueue receipt; idle is the completion.
            completion: 'session-idle',
            timeoutMs: this.config.turnTimeoutMs,
            signal: request.signal,
          })
        } catch (error: unknown) {
          // The channel's own diagnostics are provider-authored and carry no
          // prompt text, file contents, or credentials.
          diagnostic = `the tmux child did not finish its turn: ${error instanceof Error ? error.message : 'unknown channel failure'}`
          throw error
        }
        turn.finished = true
        const stopReason = stopReasonOf(observed.at(-1))
        if (stopReason === 'error') diagnostic = 'the tmux child ended its turn without completing the work'
        return { output: collectOutput(), stopReason }
      },
      collectOutput,
      collectDiagnostic: () => diagnostic,
      cancelled: () => flags.cancelled,
      onError: (error: Error, stopReason: SubagentStopReason) => {
        this.ctx.logger.warn(`subagent-tmux "${this.name}": child run failed (${stopReason}): ${error.message}`)
      },
      signal: request.signal,
      onAbort,
    })

    return subprocessRunHandle({
      id,
      result,
      signal: request.signal,
      onAbort,
      requestCancel,
      teardown: async () => {
        unsubscribe()
        // A `fresh` pane exists only for this run and is reclaimed. A
        // `resident` pane outlives the run — that is what makes the next
        // correction round a continuation rather than a restart (§5.4).
        if (mode === 'fresh') {
          await this.ctx.tmux.release(key)
          return
        }
        if (!turn.finished || flags.cancelled) {
          await this.ctx.tmux.interrupt(key, 'INT', request.parent.session)
        }
      },
    })
  }

  /**
   * Hand the child its route once per pane.
   *
   * A resident pane already completed this handshake for its session, so the
   * second call only verifies that the requested route matches the one the
   * pane is already running: a resident conversation cannot change model
   * halfway through, and silently ignoring the request would report a route
   * the child is not using.
   *
   * @param placement - the pane this child runs in.
   * @param key - placement key.
   * @param cwd - the child session's workspace directory.
   * @param requested - route overrides from the start request.
   * @param signal - the start's cancellation signal.
   * @param mode - the session semantics this start uses.
   */
  private async initialize(
    placement: TmuxPlacement,
    key: string,
    cwd: string,
    requested: AgentOptions | undefined,
    signal: AbortSignal,
    mode: 'fresh' | 'resident',
  ): Promise<void> {
    // The provider's configured effort is a plain string (a patch file cannot
    // carry the adapter-owned brand); the wire type is the branded id.
    const reasoningEffort = (requested?.reasoningEffort ?? this.config.reasoningEffort) as
      | ReasoningEffortId
      | undefined
    const maxTokens = requested?.maxTokens ?? this.config.maxTokens
    const params: InitializeParams = {
      cwd,
      provider: requested?.provider ?? this.config.provider,
      model: requested?.model ?? this.config.model,
      ...reasoningEffort === undefined ? {} : { reasoningEffort },
      ...maxTokens === undefined ? {} : { maxTokens },
    }
    if (placement.reused && mode === 'resident') {
      const previous = this.routes.get(key)
      if (previous !== undefined && (previous.provider !== params.provider || previous.model !== params.model)) {
        throw new Error(
          `subagent-tmux: resident pane ${key} already runs ${previous.provider}/${previous.model}; `
          + `this start asked for ${params.provider}/${params.model}`,
        )
      }
      return
    }
    const started = await this.ctx.tmux.request<InitializeResult>(key, 'initialize', params, {
      completion: 'response',
      timeoutMs: this.config.startTimeoutMs,
      signal,
    })
    this.routes.set(key, { provider: params.provider, model: params.model })
    this.ctx.logger.debug(`subagent-tmux: pane ${key} initialized as ${started.serverInfo.name}`)
  }
}

/**
 * Register the tmux provider on `ctx.subagents`.
 * @param ctx - owning context; `ctx.subagents` and `ctx.tmux` must be available.
 * @param config - plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved: ResolvedConfig = {
    providerName: config.providerName ?? 'tmux',
    sessionMode: config.sessionMode ?? 'fresh',
    paneKeyPrefix: config.paneKeyPrefix ?? 'worker',
    cwd: config.cwd,
    provider: config.provider ?? 'deepseek-official',
    model: config.model ?? 'deepseek-v4-flash',
    reasoningEffort: config.reasoningEffort,
    maxTokens: config.maxTokens,
    env: config.env ?? {},
    startTimeoutMs: config.startTimeoutMs ?? 120_000,
    turnTimeoutMs: config.turnTimeoutMs ?? 0,
    disposeGraceMs: config.disposeGraceMs ?? 5000,
  }
  if (!(resolved.startTimeoutMs > 0)) {
    throw new TypeError('subagent-tmux startTimeoutMs must be positive')
  }
  if (resolved.turnTimeoutMs < 0) {
    throw new TypeError('subagent-tmux turnTimeoutMs must be zero (unbounded) or positive')
  }
  if (!(resolved.disposeGraceMs > 0)) {
    throw new TypeError('subagent-tmux disposeGraceMs must be positive')
  }
  if (resolved.paneKeyPrefix.length === 0 || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(resolved.paneKeyPrefix)) {
    throw new TypeError('subagent-tmux paneKeyPrefix must be a non-empty tmux-safe name')
  }
  ctx.subagents.registerProvider(new TmuxSubagentProvider(resolved.providerName, ctx, resolved))
}
