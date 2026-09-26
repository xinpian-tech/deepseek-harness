/**
 * Vocabulary of the machine registry: the identity every durable fleet record
 * is sharded by, the file that lists the fleet's machines, and the session
 * event that records which machine an execution ran on.
 *
 * @module @dsh-fleet/machine-registry/types
 */

/**
 * One machine's stable identity (§11 item 10).
 *
 * Plain JSON: the value is written into the session log, so every field is a
 * string and the object carries no class, date, or map.
 */
export interface MachineContext {
  /**
   * Machine id. It is the `refs/dsh/machines/<id>/` segment of §7.2 and the
   * sharding key of every durable record, so it must be identical for every
   * process on the host and stable across reboots.
   */
  readonly id: string
  /** Human-readable label used in reports; absent when the deployment names no alias. */
  readonly alias?: string
  /** Nix system of the machine in nix's own spelling, e.g. `x86_64-linux`. */
  readonly nixSystem: string
  /** Hostname this process observed; diagnostic context, never an identity input. */
  readonly hostname: string
}

/**
 * The durable machine registry file.
 *
 * Entries are authoritative: a reader returns exactly these machines and never
 * adds the machine it happens to run on.
 */
export interface MachineRegistryFile {
  /** Registered machines, in file order. */
  readonly machines: readonly MachineContext[]
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Durable record of the machine a session runs on (§11 item 10), appended
     * when the session is announced and therefore before any turn can produce a
     * record that needs the sharding id. A session resumed on another machine
     * carries one event per machine it was announced on, so the last one names
     * the current host.
     */
    'machine/context': MachineContext
  }
}
