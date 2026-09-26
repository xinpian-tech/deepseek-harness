/**
 * Behavior of `ctx.taskSpec`: the §2.4 template, the machine-decidability gate,
 * acceptance execution against a real shell and a real git repository, the
 * durable records, and disposal.
 */

import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalBashExecutor from '@deepseek-ai/dsh-bash-local'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import TaskSpecService, { resolveConfig } from '../src/index.ts'
import type { Config } from '../src/index.ts'
import type { AcceptanceCriterion, AcceptanceResult, AcceptanceStatus, TaskRunContext, TaskSpec } from '../src/types.ts'

/** Directories and fibers owned by one test, torn down in reverse order. */
const dirs: string[] = []
const disposers: Array<() => Promise<unknown>> = []
let sequence = 0

afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

/**
 * A temporary directory removed after the test.
 * @param prefix - recognizable directory-name prefix.
 * @returns the absolute directory path.
 */
async function scratch(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/**
 * Run git synchronously inside a fixture repository.
 * @param cwd - repository directory.
 * @param args - arguments after the `git` executable.
 * @returns git's stdout.
 */
function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
}

/**
 * A repository with one committed file, ready for a `diff` criterion.
 * @returns the absolute repository path.
 */
async function repository(): Promise<string> {
  const repo = await scratch('dsh-task-spec-repo-')
  git(repo, 'init', '-q', '-b', 'main')
  await writeFile(join(repo, 'notes.txt'), 'one\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'base')
  return repo
}

/** Overrides for the real bash executor the acceptance run goes through. */
interface ExecutorOptions {
  /** Per-stream in-memory output cap, lowered by the capture-cap case. */
  readonly maxOutputBytes?: number
}

/**
 * Mount the service over the real shell and subprocess providers.
 * @param config - plugin configuration.
 * @param executor - bash executor overrides.
 * @returns the live service.
 */
async function setup(config: Config = {}, executor: ExecutorOptions = {}): Promise<TaskSpecService> {
  const ctx = new Context()
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalBashExecutor, { timeoutMs: 30_000, maxTimeoutMs: 60_000, ...executor })
  const fiber = ctx.plugin(TaskSpecService, config)
  await fiber
  disposers.push(() => ctx.fiber.dispose())
  return ctx.taskSpec
}

/**
 * Decode a criterion the way durable task data arrives: parsed JSON the gate must judge.
 * @param json - one criterion encoded as JSON.
 * @returns the decoded criterion, unchecked — deciding it is what the gate is for.
 */
function decodeCriterion(json: string): AcceptanceCriterion {
  return JSON.parse(json) as AcceptanceCriterion
}

/**
 * A decidable task contract, optionally overridden.
 * @param overrides - fields the case replaces.
 * @returns the candidate spec.
 */
function specOf(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id: 'task-1',
    title: 'make the build green',
    acceptance: [{ kind: 'command', run: 'exit 0', expect: { exitCode: 0 } }],
    parentPath: ['root'],
    limits: { reworkRounds: 2, deepenRounds: 1 },
    ...overrides,
  }
}

/**
 * The run context a delegating layer supplies.
 * @param workspace - absolute workspace root.
 * @param taskId - the task the criteria belong to.
 * @returns the run context bound to a fresh session.
 */
function runContext(workspace: string, taskId = 'task-1'): TaskRunContext {
  sequence += 1
  return { workspace, taskId, recordTo: Session.create(SessionId(`run-${String(sequence)}`)) }
}

/** One durable `task/criterion` record, as the log stores it. */
interface CriterionRecord {
  readonly taskId: string
  readonly index: number
  readonly criterion: AcceptanceCriterion
  readonly status: AcceptanceStatus
  readonly detail: string
}

/**
 * Every durable `task/criterion` payload of one run, in log order.
 * @param context - the run's context.
 * @returns the recorded payloads.
 */
function criterionRecords(context: TaskRunContext): CriterionRecord[] {
  const records: CriterionRecord[] = []
  for (const event of context.recordTo.snapshotEvents()) {
    if (event.type !== 'task/criterion') continue
    records.push({
      taskId: event.data.taskId,
      index: event.data.index,
      criterion: event.data.criterion,
      status: event.data.status,
      detail: event.data.detail,
    })
  }
  return records
}

describe('nix acceptance template', () => {
  it('carries the three §2.4 criteria in fixed order', async () => {
    const taskSpec = await setup()
    expect(taskSpec.nixAcceptance('pnpm test')).toEqual([
      { kind: 'command', run: 'nix flake check', expect: { exitCode: 0 } },
      { kind: 'command', run: 'nix build .#default', expect: { exitCode: 0 } },
      { kind: 'command', run: 'nix develop -c pnpm test', expect: { exitCode: 0 } },
    ])
  })

  it('uses the configured test command when the caller names none', async () => {
    const taskSpec = await setup({ defaultTestCommand: 'pnpm test' })
    const expected: AcceptanceCriterion = { kind: 'command', run: 'nix develop -c pnpm test', expect: { exitCode: 0 } }
    expect(taskSpec.nixAcceptance().at(-1)).toEqual(expected)
    expect(taskSpec.nixAcceptance('   ').at(-1)).toEqual(expected)
  })

  it('refuses to generate a set without a project test command', async () => {
    const taskSpec = await setup()
    expect(() => { taskSpec.nixAcceptance() }).toThrow(/defaultTestCommand/)
  })
})

describe('validate', () => {
  it('accepts a decidable spec', async () => {
    const taskSpec = await setup({ workspaceRoot: process.cwd() })
    expect(() => { taskSpec.validate(specOf()) }).not.toThrow()
  })

  it('names the offending field of an undecidable spec', async () => {
    const taskSpec = await setup({ workspaceRoot: process.cwd() })
    expect(() => { taskSpec.validate(specOf({ id: '  ' })) }).toThrow(/TaskSpec\.id/)
    expect(() => { taskSpec.validate(specOf({ title: '' })) }).toThrow(/TaskSpec\.title/)
    expect(() => { taskSpec.validate(specOf({ acceptance: [] })) }).toThrow(/TaskSpec\.acceptance/)
    expect(() => { taskSpec.validate(specOf({ limits: { reworkRounds: 0, deepenRounds: 1 } })) }).toThrow(/reworkRounds/)
    expect(() => { taskSpec.validate(specOf({ limits: { reworkRounds: 1, deepenRounds: -1 } })) }).toThrow(/deepenRounds/)
  })

  it('refuses a spec carrying more criteria than the configured bound', async () => {
    const taskSpec = await setup({ workspaceRoot: process.cwd(), maxCriteria: 2 })
    const acceptance: AcceptanceCriterion[] = [
      { kind: 'command', run: 'exit 0', expect: { exitCode: 0 } },
      { kind: 'diff', scope: 'src/**', maxLines: 10 },
      { kind: 'diff', scope: 'test/**', maxLines: 10 },
    ]
    expect(() => { taskSpec.validate(specOf({ acceptance })) }).toThrow(/maxCriteria of 2/)
  })

  it('refuses command criteria a machine could not decide', async () => {
    const taskSpec = await setup({ workspaceRoot: process.cwd() })
    const field = (criterion: AcceptanceCriterion): TaskSpec => specOf({ acceptance: [criterion] })
    expect(() => { taskSpec.validate(field({ kind: 'command', run: '  ', expect: { exitCode: 0 } })) }).toThrow(/acceptance\[0\]\.run/)
    expect(() => { taskSpec.validate(field({ kind: 'command', run: 'exit 0', expect: { exitCode: 1.5 } })) })
      .toThrow(/acceptance\[0\]\.expect\.exitCode/)
    expect(() => { taskSpec.validate(field({ kind: 'command', run: 'exit 0', expect: { exitCode: 0, stdoutMatches: '[' } })) })
      .toThrow(/acceptance\[0\]\.expect\.stdoutMatches/)
    expect(() => { taskSpec.validate(field({ kind: 'command', run: 'exit 0', expect: { exitCode: 0, timeoutMs: 0 } })) })
      .toThrow(/acceptance\[0\]\.expect\.timeoutMs/)
  })

  it('refuses schema and diff criteria a machine could not decide', async () => {
    const workspaceRoot = await scratch('dsh-task-spec-ws-')
    const taskSpec = await setup({ workspaceRoot })
    const field = (criterion: AcceptanceCriterion): TaskSpec => specOf({ acceptance: [criterion] })
    const schema = { type: 'object' as const, properties: { ok: { type: 'boolean' as const } }, required: ['ok'], additionalProperties: false }
    expect(() => { taskSpec.validate(field({ kind: 'schema', target: '/etc/passwd', schema })) }).toThrow(/acceptance\[0\]\.target/)
    expect(() => { taskSpec.validate(field({ kind: 'schema', target: '../outside.json', schema })) })
      .toThrow(/acceptance\[0\]\.target escapes the workspace root/)
    expect(() => { taskSpec.validate(field(decodeCriterion('{"kind":"schema","target":"out.json","schema":{"type":"string"}}'))) })
      .toThrow(/acceptance\[0\]\.schema/)
    expect(() => { taskSpec.validate(field({ kind: 'diff', scope: '', maxLines: 10 })) }).toThrow(/acceptance\[0\]\.scope/)
    expect(() => { taskSpec.validate(field({ kind: 'diff', scope: 'src/**', maxLines: 0 })) }).toThrow(/acceptance\[0\]\.maxLines/)
  })
})

describe('run', () => {
  it('decides a nonzero exit as a failed item carrying the observed status', async () => {
    const taskSpec = await setup()
    const context = runContext(await scratch('dsh-task-spec-ws-'))
    const results = await taskSpec.run([{ kind: 'command', run: 'exit 7', expect: { exitCode: 0 } }], context)
    expect(results).toHaveLength(1)
    expect(results[0]?.status).toBe('failed')
    expect(results[0]?.detail).toContain('exit status 7')
    expect(criterionRecords(context)).toEqual([
      { taskId: 'task-1', index: 0, criterion: results[0]?.criterion, status: 'failed', detail: results[0]?.detail },
    ])
  })

  it('carries stderr into the failed item', async () => {
    const taskSpec = await setup()
    const context = runContext(await scratch('dsh-task-spec-ws-'))
    const results = await taskSpec.run([
      { kind: 'command', run: 'printf "boom\\n" >&2; exit 2', expect: { exitCode: 0 } },
    ], context)
    expect(results[0]?.status).toBe('failed')
    expect(results[0]?.detail).toContain('stderr: boom')
  })

  it('matches captured stdout when the criterion names a pattern', async () => {
    const taskSpec = await setup()
    const context = runContext(await scratch('dsh-task-spec-ws-'))
    const results = await taskSpec.run([
      { kind: 'command', run: 'printf "ready\\n"', expect: { exitCode: 0, stdoutMatches: '^ready\\n$' } },
      { kind: 'command', run: 'printf "ready\\n"', expect: { exitCode: 0, stdoutMatches: '^absent$' } },
    ], context)
    expect(results.map(result => result.status)).toEqual(['passed', 'failed'])
    expect(results[1]?.detail).toContain('stdout did not match')
  }, 20_000)

  it('decides a timeout as a failed item', async () => {
    const taskSpec = await setup()
    const context = runContext(await scratch('dsh-task-spec-ws-'))
    const results = await taskSpec.run([
      { kind: 'command', run: 'sleep 5', expect: { exitCode: 0, timeoutMs: 50 } },
    ], context)
    expect(results[0]?.status).toBe('failed')
    expect(results[0]?.detail).toContain('did not finish within')
  })

  it('refuses a stdout pattern a capture cap made undecidable', async () => {
    const taskSpec = await setup({}, { maxOutputBytes: 16 })
    const context = runContext(await scratch('dsh-task-spec-ws-'))
    const results = await taskSpec.run([
      { kind: 'command', run: 'printf "abcdefghijklmnopqrstuvwxyz\\n"', expect: { exitCode: 0, stdoutMatches: 'z' } },
    ], context)
    expect(results[0]?.status).toBe('error')
    expect(results[0]?.detail).toContain('capture cap')
  }, 20_000)

  it('decides a missing or unparsable schema target as failed', async () => {
    const workspace = await scratch('dsh-task-spec-ws-')
    const taskSpec = await setup()
    await writeFile(join(workspace, 'broken.json'), '{ not json')
    const schema = { type: 'object' as const, properties: { ok: { type: 'boolean' as const } }, required: ['ok'], additionalProperties: false }
    const context = runContext(workspace)
    const results = await taskSpec.run([
      { kind: 'schema', target: 'missing.json', schema },
      { kind: 'schema', target: 'broken.json', schema },
    ], context)
    expect(results.map(result => result.status)).toEqual(['failed', 'failed'])
    expect(results[0]?.detail).toContain('does not exist')
    expect(results[1]?.detail).toContain('not valid JSON')
  })

  it('decides schema violations with the first violations and a remainder count', async () => {
    const workspace = await scratch('dsh-task-spec-ws-')
    const taskSpec = await setup()
    await writeFile(join(workspace, 'report.json'), '{}')
    const properties = Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f'].map(key => [key, { type: 'boolean' as const }]))
    const schema = { type: 'object' as const, properties, required: Object.keys(properties), additionalProperties: false }
    const context = runContext(workspace)
    const results = await taskSpec.run([{ kind: 'schema', target: 'report.json', schema }], context)
    expect(results[0]?.status).toBe('failed')
    expect(results[0]?.detail).toContain('(+1 more)')
  })

  it('passes a schema target that satisfies the criterion', async () => {
    const workspace = await scratch('dsh-task-spec-ws-')
    const taskSpec = await setup()
    await writeFile(join(workspace, 'report.json'), '{"ok":true}')
    const context = runContext(workspace)
    const results = await taskSpec.run([
      {
        kind: 'schema',
        target: 'report.json',
        schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
      },
    ], context)
    expect(results[0]?.status).toBe('passed')
  })

  it('refuses a schema target that escapes the workspace root', async () => {
    const workspace = await scratch('dsh-task-spec-ws-')
    const taskSpec = await setup()
    const context = runContext(workspace)
    const schema = { type: 'object' as const, additionalProperties: true }
    const results = await taskSpec.run([
      { kind: 'schema', target: '../outside.json', schema },
      { kind: 'schema', target: '/etc/passwd', schema },
    ], context)
    expect(results.map(result => result.status)).toEqual(['error', 'error'])
    expect(results[0]?.detail).toContain('escapes the workspace root')
    expect(results[1]?.detail).toContain('must be relative to the workspace root')
  })

  it('counts changed lines in a real repository and fails over maxLines', async () => {
    const repo = await repository()
    await writeFile(join(repo, 'notes.txt'), 'one\ntwo\nthree\n')
    await writeFile(join(repo, 'outside.txt'), 'not in the scope\n')
    const taskSpec = await setup()
    const context = runContext(repo)
    const results = await taskSpec.run([
      { kind: 'diff', scope: 'notes.txt', maxLines: 1 },
      { kind: 'diff', scope: 'notes.txt', maxLines: 5 },
      { kind: 'diff', scope: 'nothing-here/**', maxLines: 1 },
    ], context)
    expect(results.map(result => result.status)).toEqual(['failed', 'passed', 'passed'])
    expect(results[0]?.detail).toContain('changed 2 lines, over maxLines 1')
    expect(results[1]?.detail).toContain('changed 2 of 5 allowed lines')
  }, 30_000)

  it('decides a workspace without a repository as an error item', async () => {
    const taskSpec = await setup()
    const context = runContext(await scratch('dsh-task-spec-plain-'))
    const results = await taskSpec.run([{ kind: 'diff', scope: 'src/**', maxLines: 10 }], context)
    expect(results[0]?.status).toBe('error')
    expect(results[0]?.detail).toContain('git diff failed')
  }, 30_000)

  it('refuses a changed-line count cut short by the capture cap', async () => {
    const repo = await repository()
    const longDir = join(repo, 'd'.repeat(200))
    await mkdir(longDir)
    const names = Array.from({ length: 200 }, (_, index) => `${'f'.repeat(200)}${String(index).padStart(3, '0')}`)
    await Promise.all(names.map(name => writeFile(join(longDir, name), 'one\n')))
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', 'many')
    await Promise.all(names.map(name => writeFile(join(longDir, name), 'one\ntwo\n')))
    const taskSpec = await setup()
    const context = runContext(repo)
    const results = await taskSpec.run([{ kind: 'diff', scope: '.', maxLines: 1 }], context)
    expect(results[0]?.status).toBe('error')
    expect(results[0]?.detail).toContain('capture cap')
  }, 30_000)

  it('returns one result per criterion in the criteria order, re-readable from the log', async () => {
    const repo = await repository()
    await writeFile(join(repo, 'notes.txt'), 'one\ntwo\n')
    const taskSpec = await setup()
    const criteria: AcceptanceCriterion[] = [
      { kind: 'command', run: 'exit 0', expect: { exitCode: 0 } },
      { kind: 'command', run: 'exit 9', expect: { exitCode: 0 } },
      { kind: 'diff', scope: 'notes.txt', maxLines: 10 },
      { kind: 'schema', target: 'absent.json', schema: { type: 'object', additionalProperties: true } },
      { kind: 'diff', scope: 'notes.txt', maxLines: 10 },
    ]
    const context = runContext(repo, 'task-order')
    const results = await taskSpec.run(criteria, context)
    expect(results.map(result => result.criterion)).toEqual(criteria)
    expect(results.map(result => result.status)).toEqual(['passed', 'failed', 'passed', 'failed', 'passed'])
    const replayed: AcceptanceResult[] = criterionRecords(context)
      .map(record => ({ criterion: record.criterion, status: record.status, detail: record.detail }))
    expect(replayed).toEqual(results)
  }, 30_000)
})

describe('attach and report', () => {
  it('records the spec and the failed-item report on the session', async () => {
    const taskSpec = await setup({ workspaceRoot: process.cwd() })
    const session = Session.create(SessionId('attach'))
    const spec = specOf()
    taskSpec.attach(session, spec)
    const attached = session.snapshotEvents().find(event => event.type === 'task/spec')
    expect(attached?.data).toEqual({
      taskId: 'task-1',
      title: 'make the build green',
      parentPath: ['root'],
      acceptance: spec.acceptance,
      limits: { reworkRounds: 2, deepenRounds: 1 },
    })
    const failed: AcceptanceResult[] = [
      { criterion: spec.acceptance[0]!, status: 'failed', detail: 'exit status 7, expected 0' },
    ]
    taskSpec.report(session, { taskId: 'task-1', status: 'failed', failed })
    taskSpec.report(session, { taskId: 'task-1', status: 'done', failed: [], cost: { tokens: 1200, usd: 0.4 } })
    const reports = session.snapshotEvents().filter(event => event.type === 'task/report').map(event => event.data)
    expect(reports[0]).toEqual({ taskId: 'task-1', status: 'failed', failed })
    expect(Object.hasOwn(reports[1] ?? {}, 'cost')).toBe(true)
    expect(reports[1]?.cost).toEqual({ tokens: 1200, usd: 0.4 })
  })

  it('refuses an undecidable spec before anything reaches the log', async () => {
    const taskSpec = await setup({ workspaceRoot: process.cwd() })
    const session = Session.create(SessionId('attach-refused'))
    expect(() => { taskSpec.attach(session, specOf({ acceptance: [] })) }).toThrow(/TaskSpec\.acceptance/)
    expect(session.snapshotEvents().filter(event => event.type === 'task/spec')).toEqual([])
  })
})

describe('disposal', () => {
  it('removes the service registration when its fiber is disposed', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(LocalBashExecutor)
    const fiber = ctx.plugin(TaskSpecService, {})
    await fiber
    expect(ctx.get('taskSpec')).toBeInstanceOf(TaskSpecService)
    await fiber.dispose()
    expect(ctx.get('taskSpec')).toBeUndefined()
    await ctx.fiber.dispose()
  })
})

describe('resolveConfig', () => {
  it('applies the documented defaults', () => {
    expect(resolveConfig({})).toEqual({
      defaultTestCommand: undefined,
      defaultTimeoutMs: 600_000,
      maxCriteria: 64,
      workspaceRoot: process.cwd(),
    })
  })

  it('resolves a relative workspace root once against the launch directory', async () => {
    const dir = await scratch('dsh-task-spec-root-')
    expect(resolveConfig({ workspaceRoot: '.' }).workspaceRoot).toBe(process.cwd())
    expect(resolveConfig({ workspaceRoot: dir, defaultTestCommand: '  pnpm test  ' })).toEqual({
      defaultTestCommand: 'pnpm test',
      defaultTimeoutMs: 600_000,
      maxCriteria: 64,
      workspaceRoot: dir,
    })
  })

  it('fails loud on a misconfigured root or bound', async () => {
    const missing = join(await scratch('dsh-task-spec-gone-'), 'absent')
    expect(() => { resolveConfig({ workspaceRoot: missing }) }).toThrow(/workspaceRoot does not exist/)
    expect(() => { resolveConfig({ workspaceRoot: process.cwd(), maxCriteria: 0 }) }).toThrow(/maxCriteria/)
    expect(() => { resolveConfig({ workspaceRoot: process.cwd(), defaultTimeoutMs: -1 }) }).toThrow(/defaultTimeoutMs/)
    expect(() => { resolveConfig({ workspaceRoot: process.cwd(), defaultTestCommand: '   ' }) }).toThrow(/defaultTestCommand/)
  })
})
