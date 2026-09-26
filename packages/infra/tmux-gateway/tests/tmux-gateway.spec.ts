import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, connect, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import TmuxGateway, { resolveConfig } from '../src/index.ts'

/** A stand-in tmux server: a unix socket that echoes every byte it receives. */
async function fakeTmuxSocket(dir: string): Promise<{ path: string; server: Server }> {
  const path = join(dir, 'tmux.sock')
  const server = createServer((socket) => { socket.pipe(socket) })
  await new Promise<void>((resolve) => { server.listen(path, resolve) })
  return { path, server }
}

/** Send one line and read the echo back through an established connection. */
function exchange(socket: NodeJS.ReadWriteStream & { write: (data: string) => boolean }, line: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const onData = (chunk: Buffer): void => {
      socket.off('data', onData)
      resolve(chunk.toString('utf8'))
    }
    socket.on('data', onData)
    socket.once('error', reject)
    socket.write(line)
  })
}

describe('resolveConfig', () => {
  it('requires an absolute socket path', () => {
    expect(() => resolveConfig({ socketPath: '' })).toThrow(TypeError)
    expect(() => resolveConfig({ socketPath: 'tmux.sock' })).toThrow(TypeError)
    expect(resolveConfig({ socketPath: '/tmp/tmux.sock' }).socketPath).toBe('/tmp/tmux.sock')
  })

  it('defaults the port to a kernel-assigned one and the host to loopback', () => {
    const resolved = resolveConfig({ socketPath: '/tmp/tmux.sock' })
    expect(resolved.port).toBe(0)
    expect(resolved.host).toBe('127.0.0.1')
    expect(resolved.enabled).toBe(false)
  })
})

describe('TmuxGateway', () => {
  let dir: string | undefined
  let ctx: Context | undefined
  let tmux: Server | undefined

  afterEach(async () => {
    await ctx?.fiber.dispose()
    ctx = undefined
    if (tmux !== undefined) {
      await new Promise<void>((resolve) => { tmux?.close(() => { resolve() }) })
      tmux = undefined
    }
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
    dir = undefined
  })

  /** Read the registered service, failing loud when the row did not mount. */
  function gatewayOf(context: Context): TmuxGateway {
    const gateway = context.get('tmuxGateway')
    if (gateway === undefined) throw new Error('ctx.tmuxGateway was not registered')
    return gateway
  }

  async function mount(overrides: Record<string, unknown> = {}) {
    dir = mkdtempSync(join(tmpdir(), 'fleet-gateway-'))
    const fake = await fakeTmuxSocket(dir)
    tmux = fake.server
    ctx = new Context()
    await ctx.plugin(TmuxGateway, { enabled: true, socketPath: fake.path, ...overrides })
    return gatewayOf(ctx)
  }

  it('refuses to serve while disabled', async () => {
    dir = mkdtempSync(join(tmpdir(), 'fleet-gateway-'))
    const fake = await fakeTmuxSocket(dir)
    tmux = fake.server
    ctx = new Context()
    await ctx.plugin(TmuxGateway, { socketPath: fake.path })
    await expect(gatewayOf(ctx).serve()).rejects.toThrow(TypeError)
  })

  it('binds a dynamic port and reports the assigned address', async () => {
    const gateway = await mount()
    expect(gateway.address()).toBeUndefined()
    const address = await gateway.serve()
    expect(address.port).toBeGreaterThan(0)
    expect(address.host).toBe('127.0.0.1')
    expect(gateway.address()).toEqual(address)
    // Serving twice returns the same listener rather than binding another.
    await expect(gateway.serve()).resolves.toEqual(address)
  })

  it('carries bytes between a caller and the tmux socket in both directions', async () => {
    const gateway = await mount()
    const address = await gateway.serve()

    const caller = await gateway.dial(address)
    await expect(exchange(caller, 'list-sessions\n')).resolves.toBe('list-sessions\n')
    expect(gateway.connections()).toBe(1)
    caller.destroy()
  })

  it('closes the listener and its connections on disposal', async () => {
    const gateway = await mount()
    const address = await gateway.serve()
    const caller = await gateway.dial(address)
    await expect(exchange(caller, 'ping\n')).resolves.toBe('ping\n')

    await ctx?.fiber.dispose()
    ctx = undefined
    expect(gateway.address()).toBeUndefined()
    expect(gateway.connections()).toBe(0)
    await expect(gateway.dial(address)).rejects.toThrow()
  })

  it('drops a connection whose upstream socket does not exist', async () => {
    dir = mkdtempSync(join(tmpdir(), 'fleet-gateway-'))
    ctx = new Context()
    await ctx.plugin(TmuxGateway, { enabled: true, socketPath: join(dir, 'missing.sock'), connectTimeoutMs: 500 })
    const address = await gatewayOf(ctx).serve()
    const caller = connect({ host: address.host, port: address.port })
    const closed = new Promise<void>((resolve) => { caller.once('close', () => { resolve() }) })
    await expect(closed).resolves.toBeUndefined()
    caller.destroy()
  })
})
