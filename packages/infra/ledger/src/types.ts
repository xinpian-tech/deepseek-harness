/**
 * Vocabulary of the performance ledger (§6.4): the outcome entries the main
 * agent records, the aggregate derived from them, and the scoring inputs kept
 * structurally separate from any score.
 *
 * Two kinds of durable data live here and they never mix. A {@link LedgerEntry}
 * is what the main agent decided about one member's contribution; a
 * {@link ScoringInput} is raw evidence — peer signals and the red team's defect
 * counts — that the main agent may read when deciding. Nothing in this module
 * carries a score field, which is what makes "scoring authority is the main
 * agent's alone" true by construction rather than by convention.
 *
 * @module @dsh-fleet/ledger/types
 */

/** The role a member played in a task group (§5.1). */
export type LedgerRole = 'red' | 'blue' | 'leader' | 'worker'

/** How the main agent closed one member's contribution to one task. */
export type LedgerOutcome = 'accepted' | 'reworked' | 'failed'

/** One member's durable record of one task outcome. */
export interface LedgerEntry {
  /** Member the outcome belongs to, e.g. a candidate or worker identity. */
  readonly memberId: string
  /** Task the member worked on. */
  readonly taskId: string
  /** Role the member held for that task. */
  readonly role: LedgerRole
  /** Outcome the main agent decided. */
  readonly outcome: LedgerOutcome
  /** Evaluation and correction rounds the member needed, counted from zero. */
  readonly rounds: number
  /** Reported cost, in the caller's unit; absent when the deployment reports none. */
  readonly cost?: number
  /** When the outcome was recorded, in epoch milliseconds. */
  readonly recordedAt: number
}

/**
 * One member's aggregate over its retained entries.
 *
 * Every counter is derived from {@link MemberRecord.entries} on read, never
 * stored: the entry list is the one authoritative source, so an aggregate can
 * never disagree with the outcomes it summarizes.
 */
export interface MemberRecord {
  /** Member these counters describe. */
  readonly memberId: string
  /** Retained entries, oldest first. */
  readonly entries: readonly LedgerEntry[]
  /** Entries whose outcome was `accepted`. */
  readonly accepted: number
  /** Entries whose outcome was `reworked`. */
  readonly reworked: number
  /** Entries whose outcome was `failed`. */
  readonly failed: number
  /** Mean `rounds` over the retained entries; `0` when none are retained. */
  readonly meanRounds: number
}

/** Severity of one red-team defect (§5.2 defect list). */
export type DefectSeverity = 'critical' | 'major' | 'minor'

/** One peer's observation about a member, exactly as reported. */
export interface PeerSignal {
  /** Member that reported the observation. */
  readonly from: string
  /** Task the observation belongs to. */
  readonly taskId: string
  /** What the peer observed, in its own words. */
  readonly note: string
  /** When the signal was recorded, in epoch milliseconds. */
  readonly recordedAt: number
}

/** One severity's count from the red team's reproducible defect list (§5.2). */
export interface DefectCount {
  /** Severity the count belongs to. */
  readonly severity: DefectSeverity
  /** Defects found at that severity; a non-negative integer. */
  readonly count: number
}

/**
 * The scoring inputs recorded for one member: raw peer signals and the red
 * team's defect counts.
 *
 * This is evidence, not a verdict. It deliberately has no score, weight, or
 * ranking field, so the main agent's judgment cannot be pre-empted by any peer
 * or by the red team writing here.
 */
export interface ScoringInput {
  /** Member the inputs are about. */
  readonly memberId: string
  /** Task the inputs were gathered on. */
  readonly taskId: string
  /** Peer observations, in reporting order. */
  readonly peerSignals: readonly PeerSignal[]
  /** Red-team defect counts by severity. */
  readonly defects: readonly DefectCount[]
  /** When these inputs were recorded, in epoch milliseconds. */
  readonly recordedAt: number
}

/** What the ledger retains for one member, in both media layouts. */
export interface MemberDurableState {
  /** Retained outcome entries, in recording order. */
  readonly entries: readonly LedgerEntry[]
  /** Retained scoring inputs, in recording order. */
  readonly inputs: readonly ScoringInput[]
}

/**
 * The whole ledger as it is durably stored: one JSON document, whether it lives
 * in a file or in one record of the storage seam.
 */
export interface LedgerDocument {
  /** Format version of this document. */
  readonly version: number
  /** Retained state per member id. */
  readonly members: Readonly<Record<string, MemberDurableState>>
}
