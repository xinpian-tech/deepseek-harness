/**
 * Validation of everything that enters the ledger, and decoding of everything
 * that leaves its durable medium.
 *
 * Both directions run the same field checks, so a stored document cannot accept
 * a value a write would refuse. Only the error class differs: a write names the
 * caller's field with a `TypeError`, a read names the stored document with a
 * {@link LedgerError}. There is deliberately no rule about scores, weights, or
 * votes here — the ledger has no such field to validate.
 *
 * @module @dsh-fleet/ledger/validate
 */

import { LedgerError } from './errors.ts'
import type {
  DefectCount,
  DefectSeverity,
  LedgerDocument,
  LedgerEntry,
  LedgerOutcome,
  LedgerRole,
  MemberDurableState,
  PeerSignal,
  ScoringInput,
} from './types.ts'

/** Every role a ledger entry may carry. */
export const LEDGER_ROLES: readonly LedgerRole[] = ['red', 'blue', 'leader', 'worker']

/** Every outcome a ledger entry may carry. */
export const LEDGER_OUTCOMES: readonly LedgerOutcome[] = ['accepted', 'reworked', 'failed']

/** Every severity a red-team defect count may carry. */
export const DEFECT_SEVERITIES: readonly DefectSeverity[] = ['critical', 'major', 'minor']

/**
 * Builds the error one unusable value raises: `TypeError` for a write, a coded
 * {@link LedgerError} for a stored document.
 */
export type Fault = (message: string) => Error

/**
 * The error a write raises.
 * @param message - description naming the offending field.
 * @returns the `TypeError` the caller sees.
 */
export const writeFault: Fault = message => new TypeError(message)

/**
 * The error a stored document raises.
 * @param where - medium location the document was read from.
 * @returns a fault that prefixes every message with that location.
 */
export function readFault(where: string): Fault {
  return message => new LedgerError('malformed-ledger', `${where} ${message}`)
}

/**
 * Reject a member id that cannot name a ledger member.
 * @param memberId - member id supplied by the caller.
 * @throws {TypeError} when the id is not a non-empty string.
 */
export function assertMemberId(memberId: string): void {
  if (typeof memberId !== 'string' || memberId.length === 0) {
    throw new TypeError(`memberId must be a non-empty string: ${JSON.stringify(memberId)}`)
  }
}

/**
 * Validate one outcome entry.
 * @param value - the entry a caller supplied, or the decoded stored entry.
 * @param where - description of the value, used to name it in errors.
 * @param fault - error factory for the calling direction.
 * @returns the entry, field by field.
 * @throws {TypeError} when `fault` is {@link writeFault} and a field is unusable.
 * @throws {LedgerError} when `fault` is {@link readFault} and a stored field is unusable.
 */
export function decodeEntry(value: unknown, where: string, fault: Fault): LedgerEntry {
  const record = requireRecord(value, where, fault)
  const cost = record['cost']
  return {
    memberId: requireIdentifier(record, 'memberId', where, fault),
    taskId: requireIdentifier(record, 'taskId', where, fault),
    role: requireMember(record['role'], LEDGER_ROLES, 'role', where, fault),
    outcome: requireMember(record['outcome'], LEDGER_OUTCOMES, 'outcome', where, fault),
    rounds: requireCount(record['rounds'], 'rounds', where, fault),
    ...cost === undefined ? {} : { cost: requireCost(cost, where, fault) },
    recordedAt: requireTimestamp(record['recordedAt'], where, fault),
  }
}

/**
 * Validate one set of scoring inputs.
 * @param value - the inputs a caller supplied, or the decoded stored inputs.
 * @param where - description of the value, used to name it in errors.
 * @param fault - error factory for the calling direction.
 * @returns the inputs, field by field.
 * @throws {TypeError} when `fault` is {@link writeFault} and a field is unusable.
 * @throws {LedgerError} when `fault` is {@link readFault} and a stored field is unusable.
 */
export function decodeInputs(value: unknown, where: string, fault: Fault): ScoringInput {
  const record = requireRecord(value, where, fault)
  const peerSignals = requireArray(record['peerSignals'], 'peerSignals', where, fault)
  const defects = requireArray(record['defects'], 'defects', where, fault)
  return {
    memberId: requireIdentifier(record, 'memberId', where, fault),
    taskId: requireIdentifier(record, 'taskId', where, fault),
    peerSignals: peerSignals.map((signal, position) =>
      decodePeerSignal(signal, `${where} peerSignals[${position}]`, fault)),
    defects: defects.map((defect, position) => decodeDefect(defect, `${where} defects[${position}]`, fault)),
    recordedAt: requireTimestamp(record['recordedAt'], where, fault),
  }
}

/**
 * Decode one member's retained state from a stored document.
 * @param value - the decoded member entry.
 * @param where - medium location named in errors.
 * @returns the member's retained entries and inputs.
 * @throws {LedgerError} when a stored field is unusable.
 */
export function decodeMemberState(value: unknown, where: string): MemberDurableState {
  const fault = readFault(where)
  const record = requireRecord(value, where, fault)
  return {
    entries: requireArray(record['entries'], 'entries', where, fault)
      .map((entry, position) => decodeEntry(entry, `${where} entries[${position}]`, fault)),
    inputs: requireArray(record['inputs'], 'inputs', where, fault)
      .map((input, position) => decodeInputs(input, `${where} inputs[${position}]`, fault)),
  }
}

/**
 * Decode a whole ledger document read from a durable medium.
 * @param value - the parsed stored document.
 * @param where - medium location named in errors.
 * @param expectedVersion - format version this build reads and writes.
 * @returns the ledger document.
 * @throws {LedgerError} when the version differs or a stored field is unusable.
 */
export function decodeLedgerDocument(value: unknown, where: string, expectedVersion: number): LedgerDocument {
  const fault = readFault(where)
  const record = requireRecord(value, where, fault)
  const version = record['version']
  if (version !== expectedVersion) {
    throw new LedgerError(
      'unsupported-version',
      `${where} holds ledger version ${String(version)}, this build reads version ${expectedVersion}`,
    )
  }
  const members = requireRecord(record['members'], `${where} field 'members'`, fault)
  return {
    version: expectedVersion,
    members: Object.fromEntries(
      Object.entries(members).map(([memberId, state]) => [memberId, decodeMemberState(state, `${where} member ${memberId}`)]),
    ),
  }
}

/**
 * Validate one peer signal.
 * @param value - the signal a caller supplied, or the decoded stored signal.
 * @param where - description of the value, used to name it in errors.
 * @param fault - error factory for the calling direction.
 * @returns the signal, field by field.
 */
function decodePeerSignal(value: unknown, where: string, fault: Fault): PeerSignal {
  const record = requireRecord(value, where, fault)
  return {
    from: requireIdentifier(record, 'from', where, fault),
    taskId: requireIdentifier(record, 'taskId', where, fault),
    note: requireIdentifier(record, 'note', where, fault),
    recordedAt: requireTimestamp(record['recordedAt'], where, fault),
  }
}

/**
 * Validate one red-team defect count.
 * @param value - the count a caller supplied, or the decoded stored count.
 * @param where - description of the value, used to name it in errors.
 * @param fault - error factory for the calling direction.
 * @returns the defect count, field by field.
 */
function decodeDefect(value: unknown, where: string, fault: Fault): DefectCount {
  const record = requireRecord(value, where, fault)
  return {
    severity: requireMember(record['severity'], DEFECT_SEVERITIES, 'severity', where, fault),
    count: requireCount(record['count'], 'count', where, fault),
  }
}

/**
 * Read one field as a non-empty identifier.
 * @param record - the object holding the field.
 * @param field - field name, named in the error.
 * @param where - description of the object, used to name it in errors.
 * @param fault - error factory for the calling direction.
 * @returns the field text.
 */
function requireIdentifier(record: Record<string, unknown>, field: string, where: string, fault: Fault): string {
  const value = record[field]
  if (typeof value !== 'string' || value.length === 0) {
    throw fault(`${where} field '${field}' must be a non-empty string`)
  }
  return value
}

/**
 * Read one field as a member of a closed set.
 * @param value - the candidate value.
 * @param allowed - the accepted members.
 * @param field - field name, named in the error.
 * @param where - description of the object, used to name it in errors.
 * @param fault - error factory for the calling direction.
 * @returns the value as a member of `allowed`.
 */
function requireMember<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
  where: string,
  fault: Fault,
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw fault(`${where} field '${field}' must be one of ${allowed.join(', ')}: ${JSON.stringify(value)}`)
  }
  return value as T
}

/**
 * Read one field as a non-negative integer.
 * @param value - the candidate value.
 * @param field - field name, named in the error.
 * @param where - description of the object, used to name it in errors.
 * @param fault - error factory for the calling direction.
 * @returns the count.
 */
function requireCount(value: unknown, field: string, where: string, fault: Fault): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw fault(`${where} field '${field}' must be a non-negative integer: ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * Read one field as a non-negative reported cost.
 * @param value - the candidate value.
 * @param where - description of the object, used to name it in errors.
 * @param fault - error factory for the calling direction.
 * @returns the cost.
 */
function requireCost(value: unknown, where: string, fault: Fault): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw fault(`${where} field 'cost' must be a non-negative finite number: ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * Read one field as an epoch-millisecond timestamp.
 * @param value - the candidate value.
 * @param where - description of the object, used to name it in errors.
 * @param fault - error factory for the calling direction.
 * @returns the timestamp.
 */
function requireTimestamp(value: unknown, where: string, fault: Fault): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw fault(`${where} field 'recordedAt' must be an epoch-millisecond timestamp: ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * Read one field as an array.
 * @param value - the candidate value.
 * @param field - field name, named in the error.
 * @param where - description of the object, used to name it in errors.
 * @param fault - error factory for the calling direction.
 * @returns the array.
 */
function requireArray(value: unknown, field: string, where: string, fault: Fault): unknown[] {
  if (!Array.isArray(value)) throw fault(`${where} field '${field}' must be an array`)
  return value
}

/**
 * Read one value as a JSON object.
 * @param value - the candidate value.
 * @param where - description of the value, used to name it in errors.
 * @param fault - error factory for the calling direction.
 * @returns the value as a string-keyed record.
 */
function requireRecord(value: unknown, where: string, fault: Fault): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw fault(`${where} must be a JSON object`)
  }
  return value as Record<string, unknown>
}
