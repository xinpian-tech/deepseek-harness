/**
 * The Nix-only dependency rule, kept in front of every model that works in a
 * workspace: a permanent prompt section for dsh agents, and the same text in the
 * workspace's `AGENTS.md` for Codex, Kimi, and Claude, whose system prompts this
 * process cannot inject.
 *
 * The rule is declarative, not an enforcement boundary: a caller that never
 * reads it, or that runs a command outside this process, is unaffected. The
 * physical force comes from the sandbox and shell providers ([§2.2]); this row
 * exists so the model knows the rule and cooperates with it.
 *
 * The section is registered at a numeric order because the upstream
 * `SECTION_ORDERS` name registry cannot be extended without editing an upstream
 * file (R-0), and 600–800 is unoccupied.
 *
 * @module @dsh-fleet/nix-mandate
 */

import { join, isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { ensureAgentsBlock } from './agents-file.ts'
import type { AgentsFileOutcome } from './agents-file.ts'
import { AGENTS_BLOCK_BEGIN, AGENTS_BLOCK_END, NIX_MANDATE, renderAgentsBlock } from './mandate.ts'

export type { AgentsFileOutcome } from './agents-file.ts'
export { AGENTS_BLOCK_BEGIN, AGENTS_BLOCK_END, NIX_MANDATE } from './mandate.ts'

/** Stable Loader identity. */
export const name = 'nix-mandate'

/** The prompt registry this row contributes its section to. */
export const inject = ['systemPrompt']

/** Prompt section name; one section per process, so a second mount fails loudly. */
const SECTION_NAME = 'fleet:nix-mandate'

/** The rule text and the workspace-file maintenance this row publishes as `nixMandate`. */
export interface NixMandateApi {
  /**
   * The canonical rule text.
   * @returns the text registered as the prompt section and embedded verbatim in the instruction-file block.
   */
  render(): string
  /**
   * Bring one workspace's instruction file up to date with the rule.
   *
   * Only the delimited region is written: human content around it is preserved,
   * a file without delimiters receives the block at its end, and a file whose
   * region already holds the block is left untouched.
   *
   * @param workspaceRoot - absolute workspace root that holds the instruction file.
   * @param session - session the write is attributed to in the log; omit outside a session.
   * @returns the change made.
   * @throws {TypeError} when `workspaceRoot` is not absolute.
   * @throws {Error} when the file's delimiters are ambiguous, or the file cannot be read or written.
   */
  ensureAgentsFile(workspaceRoot: string, session?: Session): Promise<AgentsFileOutcome>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    nixMandate: NixMandateApi
  }
}

/** Deployment settings for the rule. Invalid values fail plugin load. */
export interface Config {
  /** Prompt section order (default 700). */
  order?: number
  /** Absolute workspace root to maintain; when omitted, each session's own working directory is used. */
  workspaceRoot?: string
  /** Instruction file name inside the workspace root (default `AGENTS.md`). */
  agentsFile?: string
  /** Whether the row registers its section, its API, and its session listener (default true). */
  enabled?: boolean
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  order: z.number().default(700),
  workspaceRoot: z.string(),
  agentsFile: z.string().default('AGENTS.md'),
  enabled: z.boolean().default(true),
})

/** {@link Config} after defaults, with every deployment-varying path checked. */
interface ResolvedConfig {
  readonly order: number
  readonly workspaceRoot: string | undefined
  readonly agentsFile: string
  readonly enabled: boolean
}

/**
 * Apply defaults and reject settings that would write outside the intended workspace.
 *
 * A misconfigured row must fail here, once, at load, rather than at the first
 * session, when the failure would look like a session fault.
 *
 * @param config - plugin configuration after schema validation.
 * @returns the settings every call site reads.
 * @throws {TypeError} when the order is not finite, the workspace root is not
 * absolute, or the file name would escape the workspace root.
 */
function resolveConfig(config: Config): ResolvedConfig {
  // Each fallback only narrows the optional input type; the schema already defaults it.
  const order = config.order ?? 700
  if (!Number.isFinite(order)) {
    throw new TypeError(`@dsh-fleet/nix-mandate order must be a finite number: ${String(config.order)}`)
  }
  const workspaceRoot = config.workspaceRoot
  if (workspaceRoot !== undefined && !isAbsolute(workspaceRoot)) {
    throw new TypeError(`@dsh-fleet/nix-mandate workspaceRoot must be an absolute path: ${JSON.stringify(workspaceRoot)}`)
  }
  const agentsFile = config.agentsFile ?? 'AGENTS.md'
  if (agentsFile.length === 0 || isAbsolute(agentsFile) || agentsFile.split(/[\\/]/).includes('..')) {
    throw new TypeError(`@dsh-fleet/nix-mandate agentsFile must be a file name inside the workspace root: ${JSON.stringify(agentsFile)}`)
  }
  return { order, workspaceRoot, agentsFile, enabled: config.enabled ?? true }
}

/**
 * Maintain one workspace's instruction file and log what changed.
 * @param ctx - context owning the logger.
 * @param resolved - validated settings.
 * @param workspaceRoot - absolute workspace root to maintain.
 * @param session - session the write is attributed to, when any.
 * @returns the change made.
 * @throws {TypeError} when `workspaceRoot` is not absolute.
 * @throws {Error} when the delimiters are ambiguous or the write fails.
 */
async function maintain(
  ctx: Context,
  resolved: ResolvedConfig,
  workspaceRoot: string,
  session: Session | undefined,
): Promise<AgentsFileOutcome> {
  if (!isAbsolute(workspaceRoot)) {
    throw new TypeError(`@dsh-fleet/nix-mandate workspace must be an absolute path: ${JSON.stringify(workspaceRoot)}`)
  }
  const file = join(workspaceRoot, resolved.agentsFile)
  const outcome = await ensureAgentsBlock(file, renderAgentsBlock(), AGENTS_BLOCK_BEGIN, AGENTS_BLOCK_END)
  const attribution = session === undefined ? '' : ` for session ${session.id}`
  if (outcome === 'unchanged') ctx.logger.debug(`nix-mandate: ${file} is already current${attribution}`)
  else ctx.logger.info(`nix-mandate: ${outcome} ${file}${attribution}`)
  return outcome
}

/**
 * Register the rule section, publish {@link NixMandateApi} as `nixMandate`, and
 * maintain the block in every session's workspace.
 *
 * Each contribution is owned by this plugin's fiber: disposal removes the
 * section, unregisters the API, and detaches the listener.
 *
 * @param ctx - host context providing `systemPrompt`.
 * @param config - order, workspace overrides, and enablement.
 * @throws {TypeError} when {@link resolveConfig} rejects a setting.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  if (!resolved.enabled) return
  ctx.effect(() => ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: resolved.order,
    text: NIX_MANDATE,
  }), 'nix-mandate.section()')
  ctx.provide('nixMandate', {
    render: () => NIX_MANDATE,
    ensureAgentsFile: (workspaceRoot, session) => maintain(ctx, resolved, workspaceRoot, session),
  })
  ctx.on('session/created', (session) => {
    const workspaceRoot = resolved.workspaceRoot ?? session.header.cwd
    if (workspaceRoot === undefined) return
    // The write starts with the session, before its first model request; a
    // failure is a warning, because a session must not be vetoed by a file.
    void maintain(ctx, resolved, workspaceRoot, session).catch((error: unknown) => {
      ctx.logger.warn(`nix-mandate: could not maintain ${resolved.agentsFile} in ${workspaceRoot}: ${error instanceof Error ? error.message : String(error)}`)
    })
  })
}
