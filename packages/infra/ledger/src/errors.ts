/**
 * The error type shared by the ledger's durable medium and its reads.
 *
 * A caller distinguishes "this deployment has no durable home for the ledger"
 * from "the durable home holds something this build cannot read" by the code,
 * because the first is a configuration fault and the second is a data fault.
 *
 * @module @dsh-fleet/ledger/errors
 */

/** What an unusable medium or document means for the caller. */
export type LedgerErrorCode =
  /** No `ledgerFile` was configured and no storage service is mounted to hold the ledger. */
  | 'storage-unavailable'
  /** The durable document exists but is not a valid ledger. */
  | 'malformed-ledger'
  /** The durable document is a well-formed ledger of a version this build does not read. */
  | 'unsupported-version'

/** Raised when the ledger's durable data cannot be read or written. */
export class LedgerError extends Error {
  /**
   * @param code - what the failure means for the caller.
   * @param message - operator-facing description of the unusable medium or document.
   */
  constructor(
    readonly code: LedgerErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'LedgerError'
  }
}
