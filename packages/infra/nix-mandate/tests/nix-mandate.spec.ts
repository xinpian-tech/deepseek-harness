import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { afterEach, describe, expect, it } from 'vitest'
import * as NixMandate from '../src/index.ts'
import { AGENTS_BLOCK_BEGIN, AGENTS_BLOCK_END, NIX_MANDATE } from '../src/index.ts'
import { renderAgentsBlock } from '../src/mandate.ts'

const contexts: Context[] = []
const workspaces: string[] = []

/** One throwaway workspace root; removed with the rest in `afterEach`. */
async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-nix-mandate-'))
  workspaces.push(root)
  return root
}

/**
 * A context with the prompt registry and this row mounted.
 * @param config - plugin configuration under test.
 * @returns the mounted context.
 */
async function mount(config: NixMandate.Config = {}): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  // The harness identity section is noise for these assertions.
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false })
  await ctx.plugin(NixMandate, config)
  return ctx
}

/** @returns whether the path names an existing file. */
async function exists(file: string): Promise<boolean> {
  try {
    await stat(file)
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}

/**
 * Wait for a file the session listener writes after `session/created` returns.
 * @param file - path to wait for.
 * @throws {Error} when the file does not appear within five seconds.
 */
async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (await exists(file)) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${file}`)
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(workspaces.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('the nix mandate prompt section', () => {
  it('registers the canonical rule text between the upstream 600 and 800 sections', async () => {
    const ctx = await mount()
    ctx.systemPrompt.section({ name: 'test:team-policy', order: 600, text: 'team policy' })
    ctx.systemPrompt.section({ name: 'test:ptc-only', order: 800, text: 'ptc only' })
    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.sections.find(section => section.name === 'fleet:nix-mandate')?.text).toBe(NIX_MANDATE)
    expect(renderPrompt(assembly)).toBe(`team policy\n\n${NIX_MANDATE}\n\nptc only`)
  })

  it('moves the section to a configured order', async () => {
    const ctx = await mount({ order: 850 })
    ctx.systemPrompt.section({ name: 'test:ptc-only', order: 800, text: 'ptc only' })
    expect(renderPrompt(await ctx.systemPrompt.assemble())).toBe(`ptc only\n\n${NIX_MANDATE}`)
  })

  it('publishes the same text through the API', async () => {
    const ctx = await mount()
    expect(ctx.nixMandate.render()).toBe(NIX_MANDATE)
  })

  it('contributes nothing when disabled', async () => {
    const ctx = await mount({ enabled: false })
    expect(renderPrompt(await ctx.systemPrompt.assemble())).toBe('')
    expect(ctx.get('nixMandate')).toBeUndefined()
  })

  it('removes the section and the API when its fiber is disposed', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false })
    const fiber = await ctx.plugin(NixMandate, {})
    expect(renderPrompt(await ctx.systemPrompt.assemble())).toBe(NIX_MANDATE)
    expect(ctx.get('nixMandate')).toBeDefined()
    await fiber.dispose()
    expect(renderPrompt(await ctx.systemPrompt.assemble())).toBe('')
    expect(ctx.get('nixMandate')).toBeUndefined()
  })

  const rejected: [NixMandate.Config, string][] = [
    [{ order: Number.POSITIVE_INFINITY }, 'order must be a finite number'],
    [{ workspaceRoot: 'relative/root' }, 'workspaceRoot must be an absolute path'],
    [{ agentsFile: '' }, 'inside the workspace root'],
    [{ agentsFile: '../AGENTS.md' }, 'inside the workspace root'],
    [{ agentsFile: '/etc/AGENTS.md' }, 'inside the workspace root'],
  ]

  it.each(rejected)('fails load on an unusable setting %j', async (config, message) => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false })
    await expect(ctx.plugin(NixMandate, config)).rejects.toThrow(message)
  })
})

describe('maintaining the workspace instruction file', () => {
  it('creates a missing file', async () => {
    const ctx = await mount()
    const root = await workspace()
    await expect(ctx.nixMandate.ensureAgentsFile(root)).resolves.toBe('created')
    expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toBe(`${renderAgentsBlock()}\n`)
  })

  it('appends the block to human content and preserves that content byte for byte', async () => {
    const ctx = await mount()
    const root = await workspace()
    const human = '# Team workspace\n\nHand-written rules for humans.\n'
    await writeFile(join(root, 'AGENTS.md'), human, 'utf8')
    await expect(ctx.nixMandate.ensureAgentsFile(root)).resolves.toBe('updated')
    const content = await readFile(join(root, 'AGENTS.md'), 'utf8')
    expect(content).toBe(`${human}\n${renderAgentsBlock()}\n`)
    expect(content.startsWith(human)).toBe(true)
  })

  it('separates the block from content that has no trailing newline', async () => {
    const ctx = await mount()
    const root = await workspace()
    await writeFile(join(root, 'AGENTS.md'), '# Team workspace', 'utf8')
    await expect(ctx.nixMandate.ensureAgentsFile(root)).resolves.toBe('updated')
    expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toBe(`# Team workspace\n\n${renderAgentsBlock()}\n`)
  })

  it('reports unchanged and does not rewrite an up-to-date file', async () => {
    const ctx = await mount()
    const root = await workspace()
    const file = join(root, 'AGENTS.md')
    await expect(ctx.nixMandate.ensureAgentsFile(root)).resolves.toBe('created')
    const parked = new Date(Date.now() - 60_000)
    await utimes(file, parked, parked)
    await expect(ctx.nixMandate.ensureAgentsFile(root)).resolves.toBe('unchanged')
    expect((await stat(file)).mtimeMs).toBe(parked.getTime())
  })

  it('replaces exactly the delimited region of a stale file', async () => {
    const ctx = await mount()
    const root = await workspace()
    const file = join(root, 'AGENTS.md')
    const head = '# Team workspace\n\nHuman intro.\n\n'
    const tail = '\n\n## Human tail\n\nKept verbatim.\n'
    const stale = `${AGENTS_BLOCK_BEGIN}\n\n## Nix is the only dependency source\n\nStale rule text.\n\n${AGENTS_BLOCK_END}`
    await writeFile(file, `${head}${stale}${tail}`, 'utf8')
    await expect(ctx.nixMandate.ensureAgentsFile(root)).resolves.toBe('updated')
    const content = await readFile(file, 'utf8')
    expect(content).toBe(`${head}${renderAgentsBlock()}${tail}`)
    expect(content).not.toContain('Stale rule text.')
    await expect(ctx.nixMandate.ensureAgentsFile(root)).resolves.toBe('unchanged')
  })

  it('leaves exactly one trailing newline when the block ends the file', async () => {
    const ctx = await mount()
    const root = await workspace()
    const file = join(root, 'AGENTS.md')
    await writeFile(file, `# Team workspace\n\n${AGENTS_BLOCK_BEGIN}\n\nOld rule.\n\n${AGENTS_BLOCK_END}`, 'utf8')
    await expect(ctx.nixMandate.ensureAgentsFile(root)).resolves.toBe('updated')
    expect(await readFile(file, 'utf8')).toBe(`# Team workspace\n\n${renderAgentsBlock()}\n`)
  })

  it('refuses a file whose delimiters are ambiguous', async () => {
    const ctx = await mount()
    const root = await workspace()
    const file = join(root, 'AGENTS.md')
    await writeFile(file, `${AGENTS_BLOCK_BEGIN}\n\nhuman text, no closing delimiter\n`, 'utf8')
    await expect(ctx.nixMandate.ensureAgentsFile(root)).rejects.toThrow('expected exactly one')
    await writeFile(file, `${renderAgentsBlock()}\n\n${renderAgentsBlock()}\n`, 'utf8')
    await expect(ctx.nixMandate.ensureAgentsFile(root)).rejects.toThrow('expected exactly one')
  })

  it('rejects a workspace root that is not absolute', async () => {
    const ctx = await mount()
    await expect(ctx.nixMandate.ensureAgentsFile('relative/root')).rejects.toThrow('workspace must be an absolute path')
  })
})

describe('workspace selection', () => {
  it('writes into the session working directory when no root is configured', async () => {
    const ctx = await mount()
    await ctx.plugin(SessionStore)
    const root = await workspace()
    ctx.sessions.create(SessionId('nix-mandate-default-root'), { meta: { cwd: root } })
    const file = join(root, 'AGENTS.md')
    await waitForFile(file)
    expect(await readFile(file, 'utf8')).toBe(`${renderAgentsBlock()}\n`)
  })

  it('prefers the configured root and file name over the session working directory', async () => {
    const root = await workspace()
    const elsewhere = await workspace()
    const ctx = await mount({ workspaceRoot: root, agentsFile: 'CLAUDE.md' })
    await ctx.plugin(SessionStore)
    ctx.sessions.create(SessionId('nix-mandate-configured-root'), { meta: { cwd: elsewhere } })
    const file = join(root, 'CLAUDE.md')
    await waitForFile(file)
    expect(await readFile(file, 'utf8')).toBe(`${renderAgentsBlock()}\n`)
    expect(await exists(join(elsewhere, 'CLAUDE.md'))).toBe(false)
    expect(await exists(join(elsewhere, 'AGENTS.md'))).toBe(false)
  })
})
