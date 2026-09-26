/**
 * Aggregation and ranking of ledger entries.
 *
 * Both are pure functions over the retained entries, so the counters a caller
 * reads and the order dispatch decisions follow come from the same one
 * authoritative source: the entries themselves. Nothing here is stored, and
 * nothing here reads a score — the ledger keeps evidence, and the main agent
 * is the only authority that turns evidence into a decision (§6.4).
 *
 * @module @dsh-fleet/ledger/derive
 */

import type { LedgerEntry, MemberRecord } from './types.ts'

/**
 * Derive one member's aggregate from its retained entries.
 * @param memberId - member the entries belong to.
 * @param entries - retained entries, in recording order.
 * @returns the aggregate; every counter is computed here and never stored.
 */
export function aggregate(memberId: string, entries: readonly LedgerEntry[]): MemberRecord {
  let accepted = 0
  let reworked = 0
  let failed = 0
  let rounds = 0
  for (const entry of entries) {
    switch (entry.outcome) {
      case 'accepted':
        accepted += 1
        break
      case 'reworked':
        reworked += 1
        break
      case 'failed':
        failed += 1
        break
    }
    rounds += entry.rounds
  }
  return {
    memberId,
    entries,
    accepted,
    reworked,
    failed,
    meanRounds: entries.length === 0 ? 0 : rounds / entries.length,
  }
}

/**
 * The documented ranking rule, as a comparison of two aggregates.
 *
 * Order: more `accepted` first; then lower `meanRounds`; then fewer `failed`;
 * then `memberId` by UTF-16 code unit. The last criterion makes the order
 * total, so two rankings over the same entries are identical and a dispatch
 * decision never depends on the order members happened to be scanned in.
 *
 * @param left - first aggregate.
 * @param right - second aggregate.
 * @returns a negative number when `left` ranks first, positive when `right` does, zero when they are the same member.
 */
export function compareMembers(left: MemberRecord, right: MemberRecord): number {
  if (left.accepted !== right.accepted) return right.accepted - left.accepted
  if (left.meanRounds !== right.meanRounds) return left.meanRounds - right.meanRounds
  if (left.failed !== right.failed) return left.failed - right.failed
  return left.memberId < right.memberId ? -1 : left.memberId > right.memberId ? 1 : 0
}

/**
 * Rank aggregates by {@link compareMembers}.
 * @param records - aggregates to rank.
 * @returns a new array in ranking order; the input is not reordered.
 */
export function rank(records: readonly MemberRecord[]): readonly MemberRecord[] {
  return [...records].sort(compareMembers)
}
