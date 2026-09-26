/**
 * Vocabulary of the version fingerprint: the record every execution logs under,
 * the vendored upstream record it reads, and the session event that carries it.
 *
 * @module @dsh-fleet/config-generation/types
 */

/**
 * The exact inputs one run executed under (§11 item 12, §8.1).
 *
 * Plain JSON: the value is written into the session log. `flakeUri`,
 * `nixSystem`, `system`, and `recordedAt` are always resolved; every other
 * field is absent when this process could not resolve it, because a
 * fingerprint with a placeholder component is worse than a missing one.
 */
export interface ConfigGeneration {
  /** Flake the process was launched from, e.g. `path:/nix/store/<hash>-source`. */
  readonly flakeUri: string
  /** SHA-256 of the resolved lock file's bytes, lowercase hex as `builtins.hashFile "sha256"` spells it. */
  readonly flakeLockHash?: string
  /** Revision of the vendored `numtide/llm-agents.nix` copy (`vendor.json` `rev`). */
  readonly llmAgentsRev?: string
  /** NAR hash of that revision (`vendor.json` `narHash`). */
  readonly llmAgentsNarHash?: string
  /** nixpkgs revision the vendored flake locked (`vendor.json` `nixpkgsRev`). */
  readonly nixpkgsRev?: string
  /** Nix system of the process that produced the record, e.g. `x86_64-linux`. */
  readonly nixSystem: string
  /**
   * The same triple under the name `infra/nix/fleet.nix` uses for
   * `pkgs.stdenv.hostPlatform.system`; the flake computes `system` and
   * `nixSystem` from that one value, so the runtime record carries both names.
   */
  readonly system: string
  /** Harness version the deployment pinned (§8.1); absent when none is configured. */
  readonly harnessVersion?: string
  /** When this record was resolved, as an ISO-8601 timestamp. */
  readonly recordedAt: string
}

/**
 * The vendored upstream record (`infra/nix/vendor.json`), narrowed to the
 * fields this package reads. Absent fields are omitted from the fingerprint;
 * a present field that is not a non-empty string is a load failure.
 */
export interface LlmAgentsVendorRecord {
  /** Pinned upstream revision. */
  readonly rev?: string
  /** NAR hash of that revision. */
  readonly narHash?: string
  /** nixpkgs revision the vendored flake locked. */
  readonly nixpkgsRev?: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Durable record of the flake a session's executions ran under (§11 item
     * 12, §8.1), appended when the session is announced. One `flake.lock` pins
     * every harness the fleet runs, so this event is what lets a result be
     * explained and a rebuild attempted after the fact.
     */
    'config/generation': ConfigGeneration
  }
}
