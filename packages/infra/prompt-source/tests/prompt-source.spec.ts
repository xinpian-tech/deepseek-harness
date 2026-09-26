/**
 * Prompt-source behaviour: the closed label set, the request-scoped registry,
 * the durable `prompt/source` record, the durable read, and disposal.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import PromptSource, {
  PromptSourceError,
  readPromptSourceRecord,
  resolveConfig,
  type PromptTarget,
} from '../src/index.ts'

/** Temporary directories this file created; every one is removed after each test. */
const roots: string[] = []
/** Contexts this file created; every one is disposed after each test. */
const contexts: Context[] = []

/**
 * Create a temporary directory this file owns.
 * @returns the absolute path of the new directory.
 */
async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-prompt-source-'))
  roots.push(root)
  return root
}

/**
 * Mount the session store, an optional persistence backend, and the plugin.
 * @param options - persistence root to mount a stored backend under, and plugin config.
 * @returns the context, the service, its fiber, and the session it delivers into.
 */
async function mount(options: { readonly storage?: string } = {}): Promise<{
  ctx: Context
  service: PromptSource
  fiber: Awaited<ReturnType<Context['plugin']>>
  session: Session
  target: PromptTarget
  delivered: UserMessage[]
}> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  if (options.storage !== undefined) {
    await ctx.plugin(JsonlSessionPersistence, { root: options.storage, compression: 'none' })
  }
  const fiber = await ctx.plugin(PromptSource, {})
  const session = ctx.sessions.create(SessionId('session-1'))
  const delivered: UserMessage[] = []
  const target: PromptTarget = {
    session,
    followup: (message) => { delivered.push(message) },
  }
  return { ctx, service: ctx.promptSource, fiber, session, target, delivered }
}

/**
 * Whether this checkout can store a session at all.
 *
 * The JSONL backend loads a prebuilt native system addon; a source-only
 * workspace does not have it, and the cold-read case is then unexercisable
 * rather than failing on machinery the plugin does not own.
 */
const storageAvailable = await (async (): Promise<boolean> => {
  const ctx = new Context()
  try {
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root: await freshRoot(), compression: 'none' })
    const probe = ctx.sessions.create(SessionId('storage-probe'))
    // Creation alone defers physical materialization; the probe therefore
    // writes, closes, reopens, and reads, which is the cycle the cold-read
    // case depends on.
    const created = await ctx.sessionPersistence.create(probe.header)
    await created.append(probe.snapshotEvents())
    await created.close()
    const reopened = await ctx.sessionPersistence.open(probe.header.id, 'read')
    await reopened.read()
    await reopened.close()
    return true
  } catch {
    return false
  } finally {
    await ctx.fiber.dispose()
  }
})()

/** Every `prompt/source` record one session logged, in log order. */
function records(session: Session): readonly unknown[] {
  // Deprecated synchronous readers are allowed in test files.
  return session.snapshotEvents().filter(event => event.type === 'prompt/source').map(event => event.data)
}

afterEach(async () => {
  vi.useRealTimers()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  await Promise.all(roots.splice(0).map(async (root) => { await rm(root, { recursive: true, force: true }) }))
})

describe('configuration', () => {
  it('accepts the built-in labels and applies the documented defaults', () => {
    expect(resolveConfig({})).toEqual({
      extraKinds: [],
      defaultSource: 'user',
      markTtlMs: 300_000,
      maxPendingMarks: 1024,
      readWindow: 500,
    })
  })

  it('extends the accepted set through extraKinds', () => {
    expect(resolveConfig({ extraKinds: ['curator', 'auditor-2'] }).extraKinds)
      .toEqual(['curator', 'auditor-2'])
  })

  it.each([
    ['a label that is not one lowercase token', { extraKinds: ['Curator'] }],
    ['an empty label', { extraKinds: [''] }],
    ['a label repeating a built-in', { extraKinds: ['leader'] }],
    ['a default outside the accepted set', { defaultSource: 'human' }],
    ['a nonpositive mark lifetime', { markTtlMs: 0 }],
    ['a nonpositive pending bound', { maxPendingMarks: -1 }],
    ['a nonpositive read window', { readWindow: 0 }],
  ])('rejects %s', (_label, override) => {
    expect(() => resolveConfig(override)).toThrow(TypeError)
  })

  it('fails plugin load for an unusable label set', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await expect(ctx.plugin(PromptSource, { extraKinds: ['Leader'] })).rejects.toThrow(/extraKinds/)
  })
})

describe('request-scoped source registry', () => {
  it('rejects a label outside the closed set', async () => {
    const { service } = await mount()
    expect(() => { service.markNext('req-1', 'human') }).toThrow(TypeError)
    expect(() => { service.markNext('req-1', 'human') }).toThrow(/unknown source "human"/)
  })

  it('accepts a configured extra label', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(PromptSource, { extraKinds: ['curator'] })
    ctx.promptSource.markNext('req-1', 'curator')
    expect(ctx.promptSource.take('req-1')?.source).toBe('curator')
  })

  it('consumes a mark exactly once and only for its own request id', async () => {
    const { service } = await mount()
    service.markNext('req-1', 'leader')
    expect(service.take('req-2')).toBeUndefined()
    expect(service.take('req-1')).toEqual({ requestId: 'req-1', source: 'leader' })
    expect(service.take('req-1')).toBeUndefined()
  })

  it('returns a session-bound mark only to that session', async () => {
    const { service } = await mount()
    service.markNext('req-1', 'peer', 'session-9')
    expect(service.take('req-1', 'session-1')).toBeUndefined()
    expect(service.take('req-1', 'session-9')).toEqual({
      requestId: 'req-1',
      source: 'peer',
      sessionId: 'session-9',
    })
  })

  it('expires an unclaimed mark instead of holding it for a later prompt', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(PromptSource, { markTtlMs: 1_000 })
    vi.useFakeTimers()
    ctx.promptSource.markNext('req-1', 'leader')
    vi.setSystemTime(Date.now() + 1_001)
    expect(ctx.promptSource.take('req-1')).toBeUndefined()
  })

  it('refuses to drop a mark once the pending bound is reached', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(PromptSource, { maxPendingMarks: 1 })
    ctx.promptSource.markNext('req-1', 'leader')
    expect(() => { ctx.promptSource.markNext('req-2', 'leader') }).toThrow(/holds 1 unclaimed marks/)
    // The caller's own retry replaces its mark rather than consuming the bound.
    ctx.promptSource.markNext('req-1', 'peer')
    expect(ctx.promptSource.take('req-1')?.source).toBe('peer')
  })
})

describe('source-carrying prompt path', () => {
  it('records the marked label against the delivered message', async () => {
    const { service, session, target, delivered } = await mount()
    service.markNext('req-1', 'leader')
    const result = service.prompt(target, {
      requestId: 'req-1',
      contentBlocks: [{ type: 'text', text: 'do the work' }],
    })

    expect(result.source).toBe('leader')
    expect(delivered.map(message => message.id)).toEqual([result.messageId])
    // The delivered message is the one the SDK server builds: nothing a model
    // request sees changed, and the label lives in the durable record.
    expect(delivered[0]?.source).toEqual({ kind: 'user' })
    expect(records(session)).toEqual([{
      sessionId: 'session-1',
      messageId: result.messageId,
      requestId: 'req-1',
      source: 'leader',
    }])
    // Plain JSON: the audit trail replays with the log.
    const [record] = records(session)
    expect(JSON.parse(JSON.stringify(record))).toEqual(record)
  })

  it('resolves an unmarked prompt to the configured default', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(PromptSource, { defaultSource: 'peer' })
    const session = ctx.sessions.create(SessionId('session-7'))
    const result = ctx.promptSource.prompt(
      { session, followup: () => {} },
      { requestId: 'req-1', contentBlocks: [{ type: 'text', text: 'hello' }] },
    )
    expect(result.source).toBe('peer')
    expect(records(session)).toEqual([{
      sessionId: 'session-7',
      messageId: result.messageId,
      requestId: 'req-1',
      source: 'peer',
    }])
  })

  it('never lets a mark for another session or request reach a prompt', async () => {
    const { service, session, target } = await mount()
    service.markNext('req-1', 'leader', 'session-9')
    service.markNext('req-2', 'leader')
    const result = service.prompt(target, {
      requestId: 'req-1',
      contentBlocks: [{ type: 'text', text: 'unrelated prompt' }],
    })

    expect(result.source).toBe('user')
    // Both marks are still where their owners left them.
    expect(service.take('req-1', 'session-9')?.source).toBe('leader')
    expect(service.take('req-2')?.source).toBe('leader')
    expect(records(session).map(record => (record as { source: string }).source)).toEqual(['user'])
  })
})

describe('durable read', () => {
  it('finds the record for one message and ignores every other event', async () => {
    const { session } = await mount()
    expect(readPromptSourceRecord(session.snapshotEvents(), 'message-absent')).toBeUndefined()
  })

  it.skipIf(!storageAvailable)('answers from a stored session after the process that wrote it is gone', async () => {
    const root = await freshRoot()
    const first = await mount({ storage: root })
    first.service.markNext('req-1', 'leader')
    const result = first.service.prompt(first.target, {
      requestId: 'req-1',
      contentBlocks: [{ type: 'text', text: 'do the work' }],
    })
    // A bare session has no agent-loop writer, so its durable log is seeded
    // directly through the same persistence backend a resumed session reads.
    const handle = await first.ctx.sessionPersistence.create(first.session.header)
    await handle.append(first.session.snapshotEvents())
    await handle.close()
    await first.ctx.fiber.dispose()

    // A restarted process holds no marks and no live session: the answer can
    // only come from what the stored log recorded.
    const second = new Context()
    contexts.push(second)
    await second.plugin(SessionStore)
    await second.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    await second.plugin(PromptSource, {})
    await expect(second.promptSource.kindOf('session-1', result.messageId)).resolves.toEqual({
      sessionId: 'session-1',
      messageId: result.messageId,
      requestId: 'req-1',
      source: 'leader',
    })
    await expect(second.promptSource.kindOf('session-1', 'message-absent')).resolves.toBeUndefined()
  })

  it('answers undefined for a session this process never stored', async () => {
    const root = await freshRoot()
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    await ctx.plugin(PromptSource, {})
    await expect(ctx.promptSource.kindOf('session-never-stored', 'message-1')).resolves.toBeUndefined()
  })

  it('names the missing persistence service instead of guessing', async () => {
    const { service } = await mount()
    await expect(service.kindOf('session-1', 'message-1'))
      .rejects.toThrow(PromptSourceError)
    await expect(service.kindOf('session-1', 'message-1'))
      .rejects.toThrow(/mount a session-persistence backend/)
  })
})

describe('disposal', () => {
  it('removes the service and everything it held', async () => {
    const { ctx, service, fiber } = await mount()
    service.markNext('req-1', 'leader')
    expect(ctx.get('promptSource')).toBeDefined()

    await fiber.dispose()
    expect(ctx.get('promptSource')).toBeUndefined()

    // A later mount starts from an empty registry: nothing leaked across it.
    await ctx.plugin(PromptSource, {})
    expect(ctx.promptSource.take('req-1')).toBeUndefined()
  })
})
