/**
 * `ctx.ledger` — the fleet's performance ledger (§11 item 9, §6.4). Each
 * worker's record is durable data that outlives the process that produced it,
 * survives alongside the Team State Repo, and feeds later dispatch decisions:
 * how many candidates N to run for a task, and which candidate to pick.
 *
 * Scoring authority is the main agent's alone. The ledger stores two things
 * and nothing else: outcome entries, which are the main agent's decisions, and
 * scoring inputs, which are raw peer signals and the red team's defect counts.
 * It has no method that accepts a score, a weight, or a peer vote — a peer
 * cannot assign one because there is no write path for one — and the aggregate
 * a caller reads is derived from the entries on every read rather than stored
 * beside them.
 *
 * @module @dsh-fleet/ledger
 */

import { isAbsolute } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { aggregate, rank } from './derive.ts'
import { LedgerError } from './errors.ts'
import { FileLedgerMedium, openStorageMedium } from './store.ts'
import type { LedgerMedium } from './store.ts'
import type {
  LedgerDocument,
  LedgerEntry,
  MemberDurableState,
  MemberRecord,
  ScoringInput,
} from './types.ts'
import { assertMemberId, decodeEntry, decodeInputs, writeFault } from './validate.ts'

export type * from './types.ts'
export { LedgerError } from './errors.ts'
export type { LedgerErrorCode } from './errors.ts'
export { aggregate, compareMembers, rank } from './derive.ts'
export { DEFECT_SEVERITIES, LEDGER_OUTCOMES, LEDGER_ROLES } from './validate.ts'

/** Configuration of the performance ledger. */
export interface Config {
  /**
   * Record key holding the ledger document when the storage seam is the medium
   * (default `fleet/ledger`). It is a key, not a path: the unit name is fixed.
   */
  storageKey?: string
  /**
   * Absolute path of a ledger file. When set, the ledger is durable at that
   * path and the storage seam is not used at all, so a deployment with no
   * storage backend still keeps a ledger.
   */
  ledgerFile?: string
  /** Registered storage backend serving the ledger unit (default `json`). */
  storageBackend?: string
  /**
   * Bound on the outcome entries and scoring inputs retained per member
   * (default 200). The newest are kept, so the aggregate a caller reads always
   * covers the most recent record of that member.
   */
  maxEntries?: number
}

/** The configuration after schemastery applied its defaults. */
export interface ResolvedConfig {
  readonly storageKey: string
  readonly ledgerFile: string | undefined
  readonly storageBackend: string
  readonly maxEntries: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    ledger: FleetLedger
  }
}

/**
 * The durable performance ledger.
 *
 * Every member's record is retained across restarts, and `ranking()` is what a
 * dispatch decision reads: the counters are derived from the retained entries
 * at read time, so they always describe the entries a caller can inspect.
 */
export class FleetLedger extends Service {
  /**
   * Config schema. A class plugin declares the schema here, because the Loader
   * resolves a class plugin's configuration through this static slot; every
   * field has a deployment-reachable default or an explicit requirement.
   */
  static Config: z<Config, ResolvedConfig> = z.object({
    storageKey: z.string().default('fleet/ledger'),
    ledgerFile: z.string(),
    storageBackend: z.string().default('json'),
    maxEntries: z.natural().min(1).default(200),
  })

  private readonly config: ResolvedConfig
  private medium: LedgerMedium | undefined
  private document: LedgerDocument | undefined
  private tail: Promise<unknown> = Promise.resolve()

  /**
   * @param ctx - owning context.
   * @param config - plugin configuration, validated here so a misconfigured
   * deployment fails at load rather than at the first recorded outcome.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'ledger')
    this.config = resolveConfig(config)
  }

  /**
   * Open the durable medium, read the stored ledger once, and own its release.
   * Reading here is what makes a corrupt or unsupported ledger a load failure
   * instead of a surprise on the first dispatch decision.
   * @throws {LedgerError} when no medium is configured or available, or the stored document is unusable.
   */
  protected async [Service.init](): Promise<void> {
    const medium = await this.openMedium()
    const document = await medium.read()
    this.medium = medium
    this.document = document
    this.ctx.effect(() => () => medium.close(), 'ledger.mediumClose')
  }

  /**
   * Record one outcome the main agent decided.
   *
   * The entry is appended to the member's retained entries only after the
   * medium reports it durable, so an observed entry is always a stored entry.
   *
   * @param entry - the outcome to record.
   * @throws {TypeError} when a field is unusable; the message names that field.
   * @throws {LedgerError} when the medium rejects the write.
   */
  async record(entry: LedgerEntry): Promise<void> {
    const validated = decodeEntry(entry, 'ledger entry', writeFault)
    await this.exclusive(async () => {
      const member = this.memberState(validated.memberId)
      await this.commit(validated.memberId, {
        ...member,
        entries: retain([...member.entries, validated], this.config.maxEntries),
      })
    })
  }

  /**
   * Record scoring inputs about one member: raw peer signals and red-team
   * defect counts.
   *
   * Inputs are evidence the main agent may weigh; they are stored apart from
   * the outcome entries and never move a counter or a rank by themselves.
   *
   * @param input - the inputs to record.
   * @throws {TypeError} when a field is unusable; the message names that field.
   * @throws {LedgerError} when the medium rejects the write.
   */
  async recordInput(input: ScoringInput): Promise<void> {
    const validated = decodeInputs(input, 'scoring input', writeFault)
    await this.exclusive(async () => {
      const member = this.memberState(validated.memberId)
      await this.commit(validated.memberId, {
        ...member,
        inputs: retain([...member.inputs, validated], this.config.maxEntries),
      })
    })
  }

  /**
   * One member's aggregate.
   * @param memberId - member to read.
   * @returns the aggregate derived from the member's retained entries, or undefined when the ledger holds no entry for it.
   * @throws {TypeError} when the member id is empty.
   */
  async recordOf(memberId: string): Promise<MemberRecord | undefined> {
    assertMemberId(memberId)
    const member = this.requireDocument().members[memberId]
    return member === undefined ? undefined : aggregate(memberId, member.entries)
  }

  /**
   * Every member's aggregate in ranking order.
   * @returns the aggregates sorted by the documented ranking rule, which reads outcome entries only.
   */
  async ranking(): Promise<readonly MemberRecord[]> {
    const members = this.requireDocument().members
    return rank(Object.entries(members).map(([memberId, member]) => aggregate(memberId, member.entries)))
  }

  /**
   * The scoring inputs recorded for one member, exactly as they were recorded.
   * @param memberId - member to read.
   * @returns the retained inputs; empty when the ledger holds none for it.
   * @throws {TypeError} when the member id is empty.
   */
  async inputs(memberId: string): Promise<readonly ScoringInput[]> {
    assertMemberId(memberId)
    return this.requireDocument().members[memberId]?.inputs ?? []
  }

  /**
   * Construct the medium this deployment configured: a file when `ledgerFile`
   * is set, otherwise one record of the storage seam.
   * @returns the opened medium, before its first read.
   * @throws {LedgerError} when neither a file nor a storage service is available.
   */
  private async openMedium(): Promise<LedgerMedium> {
    const file = this.config.ledgerFile
    if (file !== undefined) return new FileLedgerMedium(file)
    const storage = this.ctx.get('storage')
    if (storage === undefined) {
      throw new LedgerError(
        'storage-unavailable',
        `@dsh-fleet/ledger needs an absolute ledgerFile, or a mounted storage service holding key '${this.config.storageKey}'`,
      )
    }
    return await openStorageMedium(storage, this.config.storageBackend, this.config.storageKey)
  }

  /**
   * The retained state of one member, empty when the ledger holds none.
   * @param memberId - member to read.
   * @returns the member's retained entries and inputs.
   */
  private memberState(memberId: string): MemberDurableState {
    return this.requireDocument().members[memberId] ?? { entries: [], inputs: [] }
  }

  /**
   * Replace one member's retained state in the medium and adopt the written
   * document only after the medium reports it durable.
   * @param memberId - member being written.
   * @param member - the member's complete new state.
   */
  private async commit(memberId: string, member: MemberDurableState): Promise<void> {
    const document: LedgerDocument = {
      version: this.requireDocument().version,
      members: { ...this.requireDocument().members, [memberId]: member },
    }
    await this.requireMedium().write(document)
    this.document = document
  }

  /**
   * The document this service read at init and has since written.
   * @returns the current in-memory ledger.
   */
  private requireDocument(): LedgerDocument {
    if (this.document === undefined) throw new Error('@dsh-fleet/ledger is not initialized')
    return this.document
  }

  /**
   * The medium this service opened at init.
   * @returns the open medium.
   */
  private requireMedium(): LedgerMedium {
    if (this.medium === undefined) throw new Error('@dsh-fleet/ledger is not initialized')
    return this.medium
  }

  /**
   * Serialize one read-modify-write of the document against this service's
   * other writers, so a member's state is never written from a document another
   * call already replaced.
   * @param operation - the write to run.
   * @returns the operation's result.
   */
  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(operation)
    this.tail = run.then(() => undefined, () => undefined)
    return run
  }
}

/**
 * Keep the newest items within one member's retention bound.
 * @param items - items in recording order.
 * @param bound - configured retention bound, a positive integer.
 * @returns the retained items; the oldest are dropped first.
 */
function retain<T>(items: readonly T[], bound: number): readonly T[] {
  return items.length <= bound ? items : items.slice(items.length - bound)
}

/**
 * Apply defaults and validate everything this service depends on.
 *
 * A misconfigured fleet must fail here — at load, once — rather than at the
 * first dispatch decision. The schema supplies every default and rejects a
 * `maxEntries` that is not a positive integer; this function adds the checks a
 * schema cannot express.
 *
 * @param config - authored plugin configuration.
 * @returns the validated configuration.
 * @throws {TypeError} when a key is empty or the file path is relative.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const resolved = FleetLedger.Config(config)
  if (resolved.storageKey.trim().length === 0) {
    throw new TypeError('@dsh-fleet/ledger storageKey must be a non-empty record key')
  }
  if (resolved.storageBackend.trim().length === 0) {
    throw new TypeError('@dsh-fleet/ledger storageBackend must name a registered storage backend')
  }
  const ledgerFile = resolved.ledgerFile
  if (ledgerFile !== undefined && !isAbsolute(ledgerFile)) {
    throw new TypeError('@dsh-fleet/ledger ledgerFile must be an absolute path')
  }
  return {
    storageKey: resolved.storageKey,
    ledgerFile,
    storageBackend: resolved.storageBackend,
    maxEntries: resolved.maxEntries,
  }
}

export default FleetLedger
