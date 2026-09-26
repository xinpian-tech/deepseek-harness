/**
 * `ctx.machines` — the machine registry (§11 item 10). One process runs on one
 * machine, and every durable record the fleet writes is sharded by that
 * machine's id (§7.2), so the id must be stable across reboots and identical
 * for every process on the host.
 *
 * The id is resolved in the order `infra/scripts/machine-id.sh` uses: explicit
 * config, then `DSH_FLEET_MACHINE_ID`, then the hostid files, then the
 * hostname. The nix system is derived from the process platform in nix's own
 * spelling, and a platform this table cannot spell is a load failure rather
 * than a guess that would reach 100 machines.
 *
 * @module @dsh-fleet/machine-registry
 */

import { readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { isAbsolute } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-session'
import type { MachineContext } from './types.ts'

export type * from './types.ts'

/** Configuration of the machine registry. */
export interface Config {
  /** Explicit machine id, for hosts whose hostid is not unique in the fleet. */
  machineId?: string
  /** Human alias reported by {@link MachineRegistry.current}. */
  alias?: string
  /** Absolute path of the durable JSON registry {@link MachineRegistry.list} reads through. */
  registryFile?: string
  /** Nix system override, for a host whose platform triple is not derived. */
  nixSystem?: string
}

/** Environment variable overriding the hostid, as read by `infra/scripts/machine-id.sh`. */
export const MACHINE_ID_ENV = 'DSH_FLEET_MACHINE_ID'

/**
 * Hostid files, in the order the shell resolver reads them. A host without
 * systemd has neither, and then the hostname is the last resort.
 */
const HOSTID_FILES = ['/etc/machine-id', '/var/lib/dbus/machine-id'] as const

/**
 * A machine id names a git ref path segment (`refs/dsh/machines/<id>/…`, §7.2)
 * and a registry key, so its alphabet and length are fixed.
 */
const MACHINE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

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
 * A pair outside the table throws: a host that cannot spell its own nix system
 * cannot build the flake it would run, and a guessed triple would be written
 * into every durable record of that machine.
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
      `@dsh-fleet/machine-registry: no nix system for platform "${platform}" and arch "${arch}"; set the nixSystem config field`,
    )
  }
  return system
}

/** The id sources a resolution reads, in precedence order. */
export interface MachineIdSources {
  /** Explicit `machineId` config value. */
  readonly explicit?: string
  /** Process environment carrying {@link MACHINE_ID_ENV}. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** Hostid files, in the order the resolution reads them. */
  readonly hostidFiles: readonly string[]
  /** Hostname used when no hostid is readable. */
  readonly hostname: string
}

/**
 * Resolve the machine id exactly as `infra/scripts/machine-id.sh` does:
 * explicit config, then `DSH_FLEET_MACHINE_ID`, then each hostid file, then the
 * hostname. Every candidate is stripped of whitespace, and an empty one falls
 * through to the next source.
 *
 * @param sources - candidate id sources.
 * @returns the resolved machine id.
 * @throws {TypeError} when no source yields an id that can name a git ref segment.
 */
export function resolveMachineId(sources: MachineIdSources): string {
  const candidates: readonly (string | undefined)[] = [
    sources.explicit,
    sources.env[MACHINE_ID_ENV],
    ...sources.hostidFiles.map(readHostid),
    sources.hostname,
  ]
  for (const candidate of candidates) {
    if (candidate === undefined) continue
    // `tr -d '[:space:]'` in the shell resolver: an id never contains whitespace.
    const id = candidate.replace(/\s+/gu, '')
    if (id !== '') return assertMachineId(id)
  }
  throw new TypeError(
    '@dsh-fleet/machine-registry resolved no machine id from config, environment, hostid file, or hostname',
  )
}

/**
 * Read one hostid file.
 *
 * @param path - candidate hostid file.
 * @returns the file's content, or undefined when it is absent or unreadable,
 * exactly as the shell resolver skips a candidate it cannot read.
 */
function readHostid(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    // A host without systemd has neither hostid file; an unreadable one is
    // skipped here for the same reason the shell resolver skips it, because the
    // hostname fallback below is still a usable identity.
    return undefined
  }
}

/**
 * Validate a machine id against the ref-segment alphabet.
 *
 * @param id - candidate machine id.
 * @returns the id, unchanged.
 * @throws {TypeError} when the id cannot name a git ref segment.
 */
function assertMachineId(id: string): string {
  if (!MACHINE_ID_PATTERN.test(id)) {
    throw new TypeError(
      `@dsh-fleet/machine-registry machine id must match ${MACHINE_ID_PATTERN.source}: ${JSON.stringify(id)}`,
    )
  }
  return id
}

/**
 * Read and validate the durable machine registry.
 *
 * @param path - absolute path of the registry file.
 * @returns the registered machines in file order.
 * @throws {TypeError} when the file cannot be read, is not a JSON object with a
 * `machines` array, holds a malformed entry, or names one id twice.
 */
export function readRegistry(path: string): readonly MachineContext[] {
  const parsed: unknown = readJson(path)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TypeError(`@dsh-fleet/machine-registry registry ${path} must be a JSON object`)
  }
  const machines = (parsed as Partial<Record<'machines', unknown>>).machines
  if (!Array.isArray(machines)) {
    throw new TypeError(`@dsh-fleet/machine-registry registry ${path} must hold a "machines" array`)
  }
  const entries: MachineContext[] = []
  const seen = new Set<string>()
  for (const [index, entry] of machines.entries()) {
    const machine = readMachineEntry(entry, path, index)
    if (seen.has(machine.id)) {
      throw new TypeError(
        `@dsh-fleet/machine-registry registry ${path} names machine "${machine.id}" twice (entry ${index})`,
      )
    }
    seen.add(machine.id)
    entries.push(machine)
  }
  return entries
}

/**
 * Parse one registry file.
 *
 * @param path - absolute path of the registry file.
 * @returns the parsed JSON value.
 * @throws {TypeError} when the file cannot be read or does not parse.
 */
function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new TypeError(
      `@dsh-fleet/machine-registry cannot read registry ${path}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/**
 * Validate one registry entry into a machine context.
 *
 * @param entry - candidate entry from the parsed file.
 * @param path - registry path, for the failure message.
 * @param index - entry position, for the failure message.
 * @returns the validated machine context.
 * @throws {TypeError} when a required field is absent or not a non-empty string.
 */
function readMachineEntry(entry: unknown, path: string, index: number): MachineContext {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw new TypeError(`@dsh-fleet/machine-registry registry ${path} entry ${index} must be a JSON object`)
  }
  const record = entry as Record<string, unknown>
  const id = requireText(record['id'], path, index, 'id')
  assertMachineId(id)
  const alias = record['alias']
  if (alias !== undefined && (typeof alias !== 'string' || alias === '')) {
    throw new TypeError(`@dsh-fleet/machine-registry registry ${path} entry ${index} alias must be a non-empty string`)
  }
  return Object.freeze({
    id,
    nixSystem: requireText(record['nixSystem'], path, index, 'nixSystem'),
    hostname: requireText(record['hostname'], path, index, 'hostname'),
    ...alias === undefined ? {} : { alias },
  })
}

/**
 * Read one required registry field.
 *
 * @param value - candidate field value.
 * @param path - registry path, for the failure message.
 * @param index - entry position, for the failure message.
 * @param field - field name, for the failure message.
 * @returns the non-empty string value.
 * @throws {TypeError} when the field is absent, empty, or not a string.
 */
function requireText(value: unknown, path: string, index: number, field: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new TypeError(`@dsh-fleet/machine-registry registry ${path} entry ${index} needs a non-empty ${field}`)
  }
  return value
}

/** The configuration after every resolution order ran. */
export interface ResolvedConfig {
  /** Resolved machine id. */
  readonly machineId: string
  /** Configured alias, absent when the deployment names none. */
  readonly alias?: string
  /** Absolute registry path, absent when the deployment configures none. */
  readonly registryFile?: string
  /** Resolved nix system. */
  readonly nixSystem: string
  /** Observed hostname. */
  readonly hostname: string
}

/**
 * Resolve the id and nix system and validate everything this service depends on.
 *
 * A misconfigured fleet fails here — at load, once — rather than at the first
 * durable record, where the failure would look like a worker fault.
 *
 * @param config - raw plugin configuration.
 * @returns the validated configuration.
 * @throws {TypeError} when a configured value is empty, a path is relative or
 * unreadable, the platform triple is unknown, or the resolved id cannot name a
 * git ref segment.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  if (config.alias !== undefined && config.alias.trim() === '') {
    throw new TypeError('@dsh-fleet/machine-registry alias must be a non-empty string')
  }
  if (config.nixSystem !== undefined && config.nixSystem.trim() === '') {
    throw new TypeError('@dsh-fleet/machine-registry nixSystem must be a non-empty nix system')
  }
  if (config.registryFile !== undefined && !isAbsolute(config.registryFile)) {
    throw new TypeError(`@dsh-fleet/machine-registry registryFile must be an absolute path: ${config.registryFile}`)
  }
  const observedHostname = hostname()
  const machineId = resolveMachineId({
    ...config.machineId === undefined ? {} : { explicit: config.machineId },
    env: process.env,
    hostidFiles: HOSTID_FILES,
    hostname: observedHostname,
  })
  const nixSystem = config.nixSystem?.trim() ?? nixSystemFor(process.platform, process.arch)
  // Reading the registry now turns a broken file into a load failure instead of
  // a report that silently omits every other machine.
  if (config.registryFile !== undefined) readRegistry(config.registryFile)
  const alias = config.alias?.trim()
  return {
    machineId,
    nixSystem,
    hostname: observedHostname,
    ...alias === undefined ? {} : { alias },
    ...config.registryFile === undefined ? {} : { registryFile: config.registryFile },
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    machines: MachineRegistry
  }
}

/** The machine registry service. */
export class MachineRegistry extends Service {
  /**
   * Config schema; every field is optional because each one has a resolution
   * order (`machineId`, `nixSystem`) or a documented omission (`alias`,
   * `registryFile`).
   */
  static Config: z<Config> = z.object({
    machineId: z.string(),
    alias: z.string(),
    registryFile: z.string(),
    nixSystem: z.string(),
  })

  private readonly identity: MachineContext
  private readonly registry: string | undefined

  /**
   * @param ctx - owning context.
   * @param config - plugin configuration, validated here so a host that cannot
   * name itself fails at load rather than at its first durable record.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'machines')
    const resolved = resolveConfig(config)
    this.registry = resolved.registryFile
    this.identity = Object.freeze({
      id: resolved.machineId,
      nixSystem: resolved.nixSystem,
      hostname: resolved.hostname,
      ...resolved.alias === undefined ? {} : { alias: resolved.alias },
    })

    // The session log is this machine's only durable home: nothing else in the
    // harness can tell a later reader which host produced a result (§7.2). The
    // listener is global because a nested session is still this machine's run,
    // and the append is effect-scoped, so disposal stops recording.
    ctx.on('session/created', (session) => {
      session.append('machine/context', this.current())
    }, { global: true })
  }

  /**
   * This machine's identity.
   * @returns the machine context as plain JSON, frozen for the life of the process.
   */
  current(): MachineContext {
    return this.identity
  }

  /**
   * Every machine the configured registry file holds, read at call time.
   * @returns the registry entries in file order; nothing is derived or added to them.
   * @throws {TypeError} when no registry file is configured, or the file no
   * longer holds a valid registry.
   */
  list(): readonly MachineContext[] {
    if (this.registry === undefined) {
      throw new TypeError(
        '@dsh-fleet/machine-registry has no registryFile configured and knows only its own machine; use current()',
      )
    }
    return readRegistry(this.registry)
  }
}

export default MachineRegistry
