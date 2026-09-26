/**
 * Cross-machine tmux (§11 item 3, requirement §5.3 "跨机器").
 *
 * tmux has no network transport: its server listens on a unix socket, so a
 * pane on machine B is unreachable from machine A by tmux alone. This plugin is
 * the bridge — a TCP listener that accepts one connection and splices its bytes
 * onto the local tmux socket, plus a client that dials such a bridge.
 *
 * The port is dynamic by default (`port: 0`): a fleet machine asks the kernel
 * for a free port and records the assigned one, so two machines never collide
 * over a fixed number and no port has to be reserved by hand. The bridge is
 * deliberately plaintext and unauthenticated, which the deployment accepts
 * because every machine in the fleet is inside one controlled boundary
 * (requirements §13). It must never be exposed outside that boundary.
 *
 * @module @dsh-fleet/tmux-gateway
 */

import { createServer, connect, type Server, type Socket } from 'node:net'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

/** Configuration of the tmux gateway. */
export interface Config {
  /** Whether this machine serves a bridge at all (default false). */
  enabled?: boolean
  /**
   * TCP port to listen on; `0` asks the kernel for a free port and the
   * assigned one is published by {@link TmuxGateway.address} (default 0).
   */
  port?: number
  /** Interface to bind (default `127.0.0.1` — see the module note on trust). */
  host?: string
  /** Absolute path of the tmux server socket this bridge forwards to. */
  socketPath?: string
  /** Bound (ms) on establishing the upstream unix-socket connection (default 5000). */
  connectTimeoutMs?: number
  /** Concurrent connections the bridge accepts (default 16). */
  maxConnections?: number
}

/** Config schema; every field is deployment-reachable. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
  port: z.natural().max(65535).default(0),
  host: z.string().default('127.0.0.1'),
  socketPath: z.string(),
  connectTimeoutMs: z.natural().min(1).default(5000),
  maxConnections: z.natural().min(1).default(16),
})

/** Configuration after schema defaults have been applied. */
export interface ResolvedConfig {
  readonly enabled: boolean
  readonly port: number
  readonly host: string
  readonly socketPath: string
  readonly connectTimeoutMs: number
  readonly maxConnections: number
}

/** The address a served bridge is reachable at. */
export interface GatewayAddress {
  /** Bound interface. */
  readonly host: string
  /** Port the kernel assigned, never the requested `0`. */
  readonly port: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    tmuxGateway: TmuxGateway
  }
}

/**
 * Resolve and validate the gateway configuration.
 * @param config - authored plugin configuration.
 * @returns the configuration with defaults applied.
 * @throws {TypeError} when the socket path is missing or relative.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const resolved: ResolvedConfig = TmuxGateway.Config(config)
  // The schema has no default for this field, so an omitted path arrives as
  // undefined despite the resolved type; report that as a load failure rather
  // than letting it surface later as a property access on undefined.
  if (typeof resolved.socketPath !== 'string' || resolved.socketPath.length === 0) {
    throw new TypeError('@dsh-fleet/tmux-gateway socketPath is required: name the tmux server socket to expose')
  }
  if (!resolved.socketPath.startsWith('/')) {
    throw new TypeError('@dsh-fleet/tmux-gateway socketPath must be an absolute path')
  }
  return resolved
}

/** The TCP-to-tmux-socket bridge. */
export class TmuxGateway extends Service {
  static Config: z<Config, ResolvedConfig> = z.object({
    enabled: z.boolean().default(false),
    port: z.natural().max(65535).default(0),
    host: z.string().default('127.0.0.1'),
    socketPath: z.string(),
    connectTimeoutMs: z.natural().min(1).default(5000),
    maxConnections: z.natural().min(1).default(16),
  })

  private readonly config: ResolvedConfig
  private server: Server | undefined
  private bound: GatewayAddress | undefined
  private readonly live = new Set<Socket>()

  /**
   * @param ctx - owning context.
   * @param config - authored plugin configuration, validated here.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'tmuxGateway')
    this.config = resolveConfig(config)
    // The listener is owned by this fiber: disposing the plugin closes the
    // bridge and every connection it accepted.
    ctx.effect(() => () => { void this.close() }, 'tmux-gateway: listener')
  }

  /**
   * Start serving the bridge.
   *
   * Idempotent: a second call returns the address already in use rather than
   * binding a second listener.
   *
   * @returns the address the bridge is reachable at.
   * @throws {TypeError} when the plugin is configured with `enabled: false`.
   */
  async serve(): Promise<GatewayAddress> {
    if (this.bound !== undefined) return this.bound
    if (!this.config.enabled) {
      throw new TypeError('@dsh-fleet/tmux-gateway is disabled; set enabled: true to serve the bridge')
    }
    const server = createServer((client) => { this.accept(client) })
    server.maxConnections = this.config.maxConnections
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off('listening', onListening)
        reject(error)
      }
      const onListening = (): void => {
        server.off('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(this.config.port, this.config.host)
    })
    const address = server.address()
    if (address === null || typeof address === 'string') {
      server.close()
      throw new Error('@dsh-fleet/tmux-gateway bound without a TCP address')
    }
    this.server = server
    this.bound = { host: this.config.host, port: address.port }
    this.ctx.logger.info(
      `tmux-gateway: forwarding ${this.bound.host}:${String(this.bound.port)} to ${this.config.socketPath}`,
    )
    return this.bound
  }

  /**
   * The address currently served.
   * @returns the bound address, or undefined while the bridge is closed.
   */
  address(): GatewayAddress | undefined {
    return this.bound
  }

  /**
   * Number of connections this bridge currently carries.
   * @returns the count of accepted, still-open connections.
   */
  connections(): number {
    return this.live.size
  }

  /**
   * Stop serving and drop every connection.
   *
   * Idempotent, and safe to call when the bridge never started.
   */
  async close(): Promise<void> {
    for (const socket of this.live) socket.destroy()
    this.live.clear()
    const server = this.server
    this.server = undefined
    this.bound = undefined
    if (server === undefined) return
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  }

  /**
   * Dial a remote bridge.
   *
   * The returned socket carries the remote tmux server's bytes verbatim, so a
   * caller drives a remote pane exactly as it drives a local one.
   *
   * @param address - the remote bridge's host and port.
   * @returns a connected duplex socket, or a rejection when the bridge is unreachable.
   */
  async dial(address: GatewayAddress): Promise<Socket> {
    return await new Promise<Socket>((resolve, reject) => {
      const socket = connect({ host: address.host, port: address.port })
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error(`tmux-gateway: ${address.host}:${String(address.port)} did not answer in time`))
      }, this.config.connectTimeoutMs)
      socket.once('connect', () => {
        clearTimeout(timer)
        resolve(socket)
      })
      socket.once('error', (error: Error) => {
        clearTimeout(timer)
        reject(error)
      })
    })
  }

  /** Splice one accepted TCP connection onto the tmux socket. */
  private accept(client: Socket): void {
    this.live.add(client)
    const upstream = connect({ path: this.config.socketPath })
    // Both halves of the bridge are bounded: a tmux server that accepts the
    // socket but never answers must not hold a caller open indefinitely.
    const timer = setTimeout(() => {
      this.ctx.logger.warn(`tmux-gateway: upstream ${this.config.socketPath} did not answer in time`)
      client.destroy()
      upstream.destroy()
      this.live.delete(client)
    }, this.config.connectTimeoutMs)
    upstream.once('connect', () => { clearTimeout(timer) })
    upstream.once('close', () => { clearTimeout(timer) })
    const drop = (): void => {
      client.destroy()
      upstream.destroy()
      this.live.delete(client)
    }
    client.on('error', drop)
    upstream.on('error', (error: Error) => {
      // tmux is not running, or the socket path is wrong: the caller observes a
      // closed connection rather than a silent half-open one.
      this.ctx.logger.warn(`tmux-gateway: upstream ${this.config.socketPath} failed: ${error.message}`)
      drop()
    })
    client.on('close', drop)
    upstream.on('close', drop)
    client.pipe(upstream)
    upstream.pipe(client)
  }
}

export default TmuxGateway
