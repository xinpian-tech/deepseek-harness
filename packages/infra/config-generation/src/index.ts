/**
 * `ctx.configGeneration` — the version fingerprint every execution logs under
 * (§11 item 12, §8.1). One `flake.lock` pins every harness the fleet runs, so
 * the lock hash, the flake URI, and the vendored llm-agents revision are what
 * make a result explainable after the fact, and a rebuild attemptable.
 *
 * The record is resolved once, at load, and the lock file's bytes are hashed
 * then: a lock that changes under a running process cannot retroactively
 * relabel the executions that already ran under the old one. Fields this
 * process cannot resolve are omitted rather than filled with a placeholder —
 * a fingerprint with a fake component is worse than a missing one.
 *
 * @module @dsh-fleet/config-generation
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-session'
import type { ConfigGeneration, LlmAgentsVendorRecord } from './types.ts'

export type * from './types.ts'

/** Configuration of the ConfigGeneration record. */
export interface Config {
  /**
   * Flake this process was launched from. Resolved from this field, then
   * {@link FLAKE_URI_ENV}, then the nearest ancestor `flake.nix` of this
   * module; without any of the three the plugin refuses to load.
   */
  flakeUri?: string
  /** Absolute path of the `flake.lock` whose bytes are hashed. */
  flakeLockPath?: string
  /** Absolute path of the vendored llm-agents record, conventionally `<flake root>/infra/nix/vendor.json`. */
  vendorRecordPath?: string
  /** Harness version this deployment pinned (§8.1: production pins a release tag). */
  harnessVersion?: string
  /** Nix system this record describes; defaults to the running host's triple. */
  nixSystem?: string
}

/**
 * Environment variable a deployment sets to the flake URI it launched this
 * process from. `infra/nix/fleet.nix` computes the identical string as
 * `configGeneration.flakeUri = "path:${fleetFlake.outPath}"`, so a launcher
 * that exports it yields the same fingerprint the flake itself reports.
 */
export const FLAKE_URI_ENV = 'DSH_FLEET_FLAKE_URI'

/** Prefix of a flake reference that names a directory on this machine. */
const PATH_FLAKE_PREFIX = 'path:'

/** This module's own path; the anchor for the "which checkout was launched" default. */
const MODULE_PATH = fileURLToPath(import.meta.url)

/** Lock file name inside a flake root. */
const LOCK_FILE = 'flake.lock'

/** Vendored upstream record inside a flake root. */
const VENDOR_RECORD = join('infra', 'nix', 'vendor.json')

/** Number of digest hex characters kept; 64 bits is ample for grouping task records. */
const DIGEST_LENGTH = 16

/**
 * Nix systems this fleet builds for (flake.nix `systems`), keyed by the
 * `process.platform` and `process.arch` pair that reports them.
 */
const NIX_SYSTEMS: Readonly<Record<string, string>> = {
  'linux-x64': 'x86_64-linux',
  'linux-arm64': 'aarch64-linux',
  'linux-arm': 'armv7l-linux',
  'darwin-x64': 'x86_64-darwin',
  'darwin-arm64': 'aarch64-darwin',
}

/**
 * The nix system for one Node platform and arch pair.
 *
 * A pair outside the table throws: a process that cannot spell its own nix
 * system cannot build the flake it runs, and a guessed triple would be written
 * into every execution's record.
 *
 * @param platform - `process.platform`, e.g. `linux`.
 * @param arch - `process.arch`, e.g. `x64`.
 * @returns the nix system, e.g. `x86_64-linux`.
 * @throws {TypeError} when the pair has no nix system.
 */
export function nixSystemFor(platform: string, arch: string): string {
  const system = NIX_SYSTEMS[`${platform}-${arch}`]
  if (system === undefined) {
    throw new TypeError(
      `@dsh-fleet/config-generation: no nix system for platform "${platform}" and arch "${arch}"; set the nixSystem config field`,
    )
  }
  return system
}

/**
 * The directory a `path:` flake reference names.
 *
 * @param flakeUri - a flake reference, e.g. `path:/nix/store/<hash>-source`.
 * @returns that absolute directory, or undefined for a reference that names no
 * local directory (an indirect or remote flake, or a relative path whose
 * meaning depends on the invoker's cwd).
 */
export function flakeRootOf(flakeUri: string): string | undefined {
  if (!flakeUri.startsWith(PATH_FLAKE_PREFIX)) return undefined
  const reference = flakeUri.slice(PATH_FLAKE_PREFIX.length).split('?', 1)[0] ?? ''
  return isAbsolute(reference) ? reference : undefined
}

/**
 * The nearest ancestor directory of one module that holds a `flake.nix`.
 *
 * A harness run from source, and a package installed inside a checkout, both
 * resolve to that checkout's root. A harness whose code lives in a store path
 * with no flake above it has no answer here, and its deployment must state the
 * flake URI instead of this default guessing one.
 *
 * @param modulePath - absolute path of the module doing the lookup.
 * @returns the flake root, or undefined when no ancestor holds a `flake.nix`.
 */
function launchedFlakeRoot(modulePath: string): string | undefined {
  let candidate = dirname(modulePath)
  for (;;) {
    if (existsSync(join(candidate, 'flake.nix'))) return candidate
    const parent = dirname(candidate)
    if (parent === candidate) return undefined
    candidate = parent
  }
}

/** The configuration after every default and validation. */
export interface ResolvedConfig {
  /** Flake this process runs from. */
  readonly flakeUri: string
  /** Lock file to hash, absent when the flake reference names no local lock. */
  readonly flakeLockPath?: string
  /** Vendored llm-agents record to read, absent when none exists. */
  readonly vendorRecordPath?: string
  /** Pinned harness version, absent when the deployment pins none. */
  readonly harnessVersion?: string
  /** Nix system of the running host. */
  readonly nixSystem: string
}

/**
 * Resolve every input and validate the paths this service will read.
 *
 * A configured path that is relative or missing is a load failure: the
 * fingerprint is only as good as the files behind it. A defaulted path is used
 * only when the file exists, so a checkout without a vendored record produces a
 * fingerprint with that field absent instead of one pointing at nothing.
 *
 * @param config - raw plugin configuration.
 * @returns the resolved inputs.
 * @throws {TypeError} when a configured value is empty, a configured path is
 * relative or missing, or no flake URI can be resolved.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  if (config.flakeUri !== undefined && config.flakeUri.trim() === '') {
    throw new TypeError('@dsh-fleet/config-generation flakeUri must be a non-empty flake reference')
  }
  if (config.harnessVersion !== undefined && config.harnessVersion.trim() === '') {
    throw new TypeError('@dsh-fleet/config-generation harnessVersion must be a non-empty version')
  }
  if (config.nixSystem !== undefined && config.nixSystem.trim() === '') {
    throw new TypeError('@dsh-fleet/config-generation nixSystem must be a non-empty nix system')
  }
  if (config.flakeLockPath !== undefined && !isAbsolute(config.flakeLockPath)) {
    throw new TypeError(`@dsh-fleet/config-generation flakeLockPath must be an absolute path: ${config.flakeLockPath}`)
  }
  if (config.vendorRecordPath !== undefined && !isAbsolute(config.vendorRecordPath)) {
    throw new TypeError(`@dsh-fleet/config-generation vendorRecordPath must be an absolute path: ${config.vendorRecordPath}`)
  }

  const flakeUri = resolveFlakeUri(config.flakeUri)
  const root = flakeRootOf(flakeUri)
  const flakeLockPath = resolvePath(
    config.flakeLockPath,
    root === undefined ? undefined : join(root, LOCK_FILE),
    'flakeLockPath',
  )
  const vendorRecordPath = resolvePath(
    config.vendorRecordPath,
    root === undefined ? undefined : join(root, VENDOR_RECORD),
    'vendorRecordPath',
  )
  const harnessVersion = config.harnessVersion?.trim()
  return {
    flakeUri,
    nixSystem: config.nixSystem?.trim() ?? nixSystemFor(process.platform, process.arch),
    ...flakeLockPath === undefined ? {} : { flakeLockPath },
    ...vendorRecordPath === undefined ? {} : { vendorRecordPath },
    ...harnessVersion === undefined ? {} : { harnessVersion },
  }
}

/**
 * Choose the flake reference this process reports.
 *
 * @param explicit - configured `flakeUri`, if any.
 * @returns the configured reference, else {@link FLAKE_URI_ENV}, else the
 * annotated `path:` reference of the checkout this module lives in.
 * @throws {TypeError} when none of the three exists: guessing a flake URI would
 * put a wrong revision into every execution record.
 */
function resolveFlakeUri(explicit: string | undefined): string {
  const fromEnv = process.env[FLAKE_URI_ENV]?.trim()
  const configured = explicit?.trim() ?? (fromEnv === undefined || fromEnv === '' ? undefined : fromEnv)
  if (configured !== undefined) return configured
  const root = launchedFlakeRoot(MODULE_PATH)
  if (root === undefined) {
    throw new TypeError(
      `@dsh-fleet/config-generation cannot name the flake this process was launched from; set the flakeUri config field or ${FLAKE_URI_ENV}`,
    )
  }
  return `${PATH_FLAKE_PREFIX}${root}`
}

/**
 * Choose a file the record reads: the configured path, or a default that must exist.
 *
 * @param configured - configured absolute path, if any.
 * @param fallback - path derived from the flake root, if the reference named one.
 * @param field - config field name, for the failure message.
 * @returns the path to read, or undefined when neither candidate is usable.
 * @throws {TypeError} when the configured path does not exist.
 */
function resolvePath(configured: string | undefined, fallback: string | undefined, field: string): string | undefined {
  if (configured !== undefined) {
    if (!existsSync(configured)) {
      throw new TypeError(`@dsh-fleet/config-generation configured ${field} does not exist: ${configured}`)
    }
    return configured
  }
  return fallback !== undefined && existsSync(fallback) ? fallback : undefined
}

/**
 * Read the vendored upstream record.
 *
 * @param path - absolute path of the vendored `vendor.json`.
 * @returns the fields the fingerprint uses, omitting those the file does not carry.
 * @throws {TypeError} when the file cannot be read or does not parse as a JSON
 * object, or a known field is present but is not a non-empty string.
 */
export function readVendorRecord(path: string): LlmAgentsVendorRecord {
  const parsed: unknown = readJson(path)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TypeError(`@dsh-fleet/config-generation ${path} must be a JSON object`)
  }
  const record = parsed as Record<string, unknown>
  const rev = optionalText(record['rev'], path, 'rev')
  const narHash = optionalText(record['narHash'], path, 'narHash')
  const nixpkgsRev = optionalText(record['nixpkgsRev'], path, 'nixpkgsRev')
  return {
    ...rev === undefined ? {} : { rev },
    ...narHash === undefined ? {} : { narHash },
    ...nixpkgsRev === undefined ? {} : { nixpkgsRev },
  }
}

/**
 * Parse one JSON file.
 *
 * @param path - absolute file path.
 * @returns the parsed value.
 * @throws {TypeError} when the file cannot be read or does not parse.
 */
function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new TypeError(
      `@dsh-fleet/config-generation cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/**
 * Read one optional string field.
 *
 * @param value - candidate field value.
 * @param path - file path, for the failure message.
 * @param field - field name, for the failure message.
 * @returns the value, or undefined when the field is absent.
 * @throws {TypeError} when the field is present but is not a non-empty string.
 */
function optionalText(value: unknown, path: string, field: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value === '') {
    throw new TypeError(`@dsh-fleet/config-generation ${path} field ${field} must be a non-empty string`)
  }
  return value
}

/**
 * SHA-256 of one file's bytes.
 *
 * @param path - absolute file path.
 * @returns the lowercase hex digest, the encoding `builtins.hashFile "sha256"` returns.
 * @throws {TypeError} when the file cannot be read.
 */
function sha256OfFile(path: string): string {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch (error) {
    throw new TypeError(
      `@dsh-fleet/config-generation cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/**
 * Resolve the fingerprint fields this process can read.
 *
 * @param resolved - validated configuration.
 * @returns the record, frozen and ready to log.
 * @throws {TypeError} when a resolved file cannot be read or holds a malformed field.
 */
function buildRecord(resolved: ResolvedConfig): ConfigGeneration {
  const vendor = resolved.vendorRecordPath === undefined ? undefined : readVendorRecord(resolved.vendorRecordPath)
  return Object.freeze({
    flakeUri: resolved.flakeUri,
    nixSystem: resolved.nixSystem,
    // `infra/nix/fleet.nix` computes both names from `pkgs.stdenv.hostPlatform.system`.
    system: resolved.nixSystem,
    recordedAt: new Date().toISOString(),
    ...resolved.flakeLockPath === undefined ? {} : { flakeLockHash: sha256OfFile(resolved.flakeLockPath) },
    ...vendor?.rev === undefined ? {} : { llmAgentsRev: vendor.rev },
    ...vendor?.narHash === undefined ? {} : { llmAgentsNarHash: vendor.narHash },
    ...vendor?.nixpkgsRev === undefined ? {} : { nixpkgsRev: vendor.nixpkgsRev },
    ...resolved.harnessVersion === undefined ? {} : { harnessVersion: resolved.harnessVersion },
  })
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    configGeneration: ConfigGenerationService
  }
}

/** The ConfigGeneration record service. */
export class ConfigGenerationService extends Service {
  /**
   * Config schema; every field is optional because each one has a resolution
   * order (`flakeUri`, `flakeLockPath`, `vendorRecordPath`, `nixSystem`) or a
   * documented omission (`harnessVersion`).
   */
  static Config: z<Config> = z.object({
    flakeUri: z.string(),
    flakeLockPath: z.string(),
    vendorRecordPath: z.string(),
    harnessVersion: z.string(),
    nixSystem: z.string(),
  })

  private readonly record: ConfigGeneration

  /**
   * @param ctx - owning context.
   * @param config - plugin configuration, resolved here so a deployment whose
   * flake cannot be named fails at load rather than at its first record.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'configGeneration')
    this.record = buildRecord(resolveConfig(config))

    // The session log is the only home for "what did this run execute under":
    // the record is written when the session is announced, before any turn can
    // produce a result that would need it. The listener is global because a
    // nested session ran under the same flake, and the append is effect-scoped,
    // so disposal stops recording.
    ctx.on('session/created', (session) => {
      session.append('config/generation', this.current())
    }, { global: true })
  }

  /**
   * The fingerprint of the environment this process runs under.
   * @returns the record as plain JSON, frozen for the life of the process.
   */
  current(): ConfigGeneration {
    return this.record
  }

  /**
   * A short, stable digest of this record's environment fields, for a task
   * record that needs to group runs by identical environment.
   *
   * Derivation: `sha256:` followed by the first 16 lowercase hex characters of
   * the SHA-256 over the UTF-8 bytes of `JSON.stringify` applied to an object
   * holding the resolved fields in this fixed order — `flakeUri`,
   * `flakeLockHash`, `llmAgentsRev`, `llmAgentsNarHash`, `nixpkgsRev`,
   * `nixSystem`, `system`, `harnessVersion` — with unresolved fields absent.
   * `recordedAt` is excluded because it says when the record was read, not
   * which environment it describes, so two runs of one revision digest equal.
   *
   * @returns the digest, e.g. `sha256:0f1e2d3c4b5a6978`.
   */
  digest(): string {
    const hash = createHash('sha256').update(JSON.stringify(this.environment()), 'utf8').digest('hex')
    return `sha256:${hash.slice(0, DIGEST_LENGTH)}`
  }

  /** The record's resolved environment fields, in the fixed order the digest covers. */
  private environment(): Record<string, string> {
    return {
      flakeUri: this.record.flakeUri,
      ...this.record.flakeLockHash === undefined ? {} : { flakeLockHash: this.record.flakeLockHash },
      ...this.record.llmAgentsRev === undefined ? {} : { llmAgentsRev: this.record.llmAgentsRev },
      ...this.record.llmAgentsNarHash === undefined ? {} : { llmAgentsNarHash: this.record.llmAgentsNarHash },
      ...this.record.nixpkgsRev === undefined ? {} : { nixpkgsRev: this.record.nixpkgsRev },
      nixSystem: this.record.nixSystem,
      system: this.record.system,
      ...this.record.harnessVersion === undefined ? {} : { harnessVersion: this.record.harnessVersion },
    }
  }
}

export default ConfigGenerationService
