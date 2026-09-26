/**
 * `NixShellExecutor` suite. A recording fake `ctx.sandbox` pins the exact argv
 * the executor hands to the deployment's confinement, and stand-in `nix`
 * programs pin argument boundaries and lifecycle behavior through the real
 * subprocess seam. The develop-mode case drives the repository's own flake, so
 * it is skipped where no `nix` resolves.
 */

import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { ShellExecRequest, ShellExecSpec, ShellRunResult } from '@deepseek-ai/dsh-shell'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { NixShellExecutor, nixShellArgv, resolveExecutable, resolveNixConfig, shellCommandLine, shellQuote } from '../src/index.ts'

/** Scratch root: every fixture lives here, and nothing outside it is written. */
const scratch = mkdtempSync(join(tmpdir(), 'dsh-nix-shell-spec-'))

/** A flake directory the load-time check accepts. */
const flakeDir = join(scratch, 'flake')
mkdirSync(flakeDir, { recursive: true })
writeFileSync(join(flakeDir, 'flake.nix'), '{ outputs = { self }: { devShells = { }; }; }\n')

/** A stand-in nix that prints its own argv, one element per line, and runs nothing. */
const echoNix = join(scratch, 'nix-echo')
writeFileSync(echoNix, '#!/bin/sh\nprintf \'%s\\n\' "$0" "$@"\n')
chmodSync(echoNix, 0o755)

/** A stand-in nix that execs whatever follows `-c`, so command behavior can be observed. */
const execNix = join(scratch, 'nix-exec')
writeFileSync(execNix, '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = "-c" ]; then shift; exec "$@"; fi\n  shift\ndone\nexit 64\n')
chmodSync(execNix, 0o755)

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

/** The schema's input side: what a caller may hand to `ctx.plugin`. */
type ExecutorConfig = NonNullable<Parameters<typeof NixShellExecutor.Config>[0]>

/**
 * A validated configuration object, as the loader hands it to the constructor.
 * @param overrides - fields to replace.
 * @returns the post-schema configuration.
 */
function loadConfig(overrides: ExecutorConfig = {}) {
  return NixShellExecutor.Config({ nixBin: echoNix, flakeRef: flakeDir, ...overrides })
}

/** A passthrough confinement: the caller's argv unchanged, reported as fully enforced. */
function passthrough(argv: readonly string[]): ConfinedArgv {
  return { argv: [...argv], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }
}

/** One recorded `confine` call. */
interface ConfineCall {
  argv: string[]
  policy: SandboxPolicy
}

/**
 * Boot every service the executor injects, without the executor itself.
 * @returns the context and the recorded confinement calls.
 */
async function bootContext() {
  const calls: ConfineCall[] = []
  class FakeSandboxProvider extends SandboxProvider {
    override async confine(argv: readonly string[], policy: SandboxPolicy): Promise<ConfinedArgv> {
      calls.push({ argv: [...argv], policy })
      return passthrough(argv)
    }
  }
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(FakeSandboxProvider)
  await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: scratch })
  await ctx.plugin(LocalSubprocessRuntime)
  ;(ctx.subprocess as LocalSubprocessRuntime).internals = { spillDir: join(scratch, 'spill') }
  return { ctx, calls }
}

/**
 * Boot a context with a recording fake `ctx.sandbox` and the executor under
 * test on top of the real subprocess seam.
 * @param config - executor configuration overrides.
 * @returns the context, the recorded confinement calls, and the loaded executor.
 */
async function setup(config: ExecutorConfig = {}) {
  const { ctx, calls } = await bootContext()
  await ctx.plugin(NixShellExecutor, { nixBin: echoNix, flakeRef: flakeDir, ...config })
  return { ctx, calls }
}

/**
 * Run one command through the seam's resolve/execute pair.
 * @param ctx - the loaded context.
 * @param request - the caller's request.
 * @returns the foreground result.
 */
async function run(ctx: Context, request: ShellExecRequest): Promise<ShellRunResult> {
  return (await ctx.shell.execute(ctx.shell.resolve(request))).result()
}

/**
 * The argv a stand-in nix printed, one element per line.
 * @param stdout - the stand-in's captured stdout.
 * @returns the printed argv elements.
 */
function printedArgv(stdout: string): string[] {
  return stdout.split('\n').filter(line => line.length > 0)
}

describe('the flake invocation', () => {
  it('maps a command to the exact argv nix runs', () => {
    expect(nixShellArgv(
      { nixBin: '/nix/store/abc-nix/bin/nix', mode: 'develop', flakeRef: '/srv/project', extraArgs: ['--no-write-lock-file'] },
      'ls -la | wc -l',
    )).toEqual([
      '/nix/store/abc-nix/bin/nix',
      'develop',
      '/srv/project',
      '--no-write-lock-file',
      '-c',
      'bash',
      '-lc',
      'ls -la | wc -l',
    ])
  })

  it('selects the shell subcommand when configured for it', () => {
    expect(nixShellArgv(
      { nixBin: 'nix', mode: 'shell', flakeRef: 'nixpkgs#hello', extraArgs: [] },
      'hello',
    )).toEqual(['nix', 'shell', 'nixpkgs#hello', '-c', 'bash', '-lc', 'hello'])
  })

  it('renders the argv as a line with no unquoted word', () => {
    expect(shellCommandLine(['/bin/nix', 'develop', '.', '-c', 'bash', '-lc', 'echo $HOME']))
      .toBe('\'/bin/nix\' \'develop\' \'.\' \'-c\' \'bash\' \'-lc\' \'echo $HOME\'')
    expect(shellQuote("it's")).toBe('\'it\'\\\'\'s\'')
    expect(shellQuote('')).toBe("''")
  })

  it.skipIf(process.platform === 'win32')('keeps quotes, $, and spaces as single argv elements through a real shell', () => {
    const command = 'printf \'%s\\n\' "a b" \'$HOME\' "it\'s" "${UNSET:-x}"'
    const line = shellCommandLine(nixShellArgv(
      { nixBin: echoNix, mode: 'develop', flakeRef: flakeDir, extraArgs: [] },
      command,
    ))
    const spawned = spawnSync('bash', ['-c', line], { encoding: 'utf8' })
    expect(spawned.status).toBe(0)
    expect(printedArgv(spawned.stdout ?? '')).toEqual([
      echoNix,
      'develop',
      flakeDir,
      '-c',
      'bash',
      '-lc',
      command,
    ])
  })
})

describe('load-time validation', () => {
  it('resolves a relative flake reference against the launch directory once', () => {
    const resolved = resolveNixConfig(loadConfig({ flakeRef: 'flake' }), scratch)
    expect(resolved.flakeRef).toBe(flakeDir)
    expect(resolved.nixBin).toBe(echoNix)
  })

  it('hands URL and fragment references to nix unchecked', () => {
    expect(resolveNixConfig(loadConfig({ flakeRef: 'path:/srv/flake' }), scratch).flakeRef).toBe('path:/srv/flake')
    expect(resolveNixConfig(loadConfig({ flakeRef: 'github:owner/repo' }), scratch).flakeRef).toBe('github:owner/repo')
    expect(resolveNixConfig(loadConfig({ flakeRef: 'nixpkgs#hello' }), scratch).flakeRef).toBe('nixpkgs#hello')
  })

  it('rejects a flake reference that is not a directory containing flake.nix', () => {
    expect(() => resolveNixConfig(loadConfig({ flakeRef: 'missing' }), scratch))
      .toThrow(/flakeRef "missing" resolves to .*missing, which is not a directory containing flake\.nix/u)
    expect(() => resolveNixConfig(loadConfig({ flakeRef: '' }), scratch)).toThrow(/flakeRef must be a non-empty/u)
  })

  it('rejects a nix binary that is on neither PATH nor a resolvable path', () => {
    expect(() => resolveNixConfig(loadConfig({ nixBin: 'dsh-nix-shell-absent-binary' }), scratch))
      .toThrow(/nixBin "dsh-nix-shell-absent-binary" is neither an executable/u)
    expect(() => resolveNixConfig(loadConfig({ nixBin: join(scratch, 'absent') }), scratch))
      .toThrow(/is neither an executable/u)
    expect(() => resolveNixConfig(loadConfig({ nixBin: scratch }), scratch)).toThrow(/is neither an executable/u)
  })

  it('rejects a nonpositive or oversized develop budget', () => {
    expect(() => resolveNixConfig(loadConfig({ developTimeoutMs: 0 }), scratch))
      .toThrow(/developTimeoutMs must be a positive finite number/u)
    expect(() => resolveNixConfig(loadConfig({ developTimeoutMs: -1 }), scratch))
      .toThrow(/developTimeoutMs must be a positive finite number/u)
    expect(() => resolveNixConfig(loadConfig({ developTimeoutMs: MAX_TIMER_DELAY_MS + 1 }), scratch))
      .toThrow(/developTimeoutMs must be a positive finite number/u)
  })

  it('rejects an unusable inherited command budget and empty extra arguments', () => {
    expect(() => resolveNixConfig(loadConfig({ timeoutMs: 0 }), scratch)).toThrow(/timeoutMs must be a positive finite number/u)
    expect(() => resolveNixConfig(loadConfig({ graceMs: MAX_TIMER_DELAY_MS + 1 }), scratch)).toThrow(/graceMs must be no greater/u)
    expect(() => resolveNixConfig(loadConfig({ extraArgs: [''] }), scratch)).toThrow(/extraArgs entries must be non-empty/u)
  })

  it('fails the plugin load rather than the first command', async () => {
    const { ctx } = await bootContext()
    await expect(ctx.plugin(NixShellExecutor, { nixBin: echoNix, flakeRef: 'missing' }))
      .rejects.toThrow(/is not a directory containing flake\.nix/u)
  })

  it('removes the shell service when its fiber is disposed', async () => {
    const { ctx } = await setup()
    expect(ctx.get('shell')).toBeDefined()
    await ctx.fiber.dispose()
    expect(ctx.get('shell')).toBeUndefined()
  })
})

describe('the executor', () => {
  it('adds the flake-preparation budget to the resolved deadline', async () => {
    const { ctx } = await setup({ timeoutMs: 1_000, maxTimeoutMs: 10_000, developTimeoutMs: 5_000 })
    expect(ctx.shell.resolve({ command: 'ls' }).timeoutMs).toBe(6_000)
    expect(ctx.shell.resolve({ command: 'ls', timeoutMs: 2_000 }).timeoutMs).toBe(7_000)
    await ctx.fiber.dispose()
  })

  it('clamps the deadline to the largest schedulable timer', async () => {
    const { ctx } = await setup({ timeoutMs: 1_000, maxTimeoutMs: MAX_TIMER_DELAY_MS, developTimeoutMs: MAX_TIMER_DELAY_MS })
    expect(ctx.shell.resolve({ command: 'ls' }).timeoutMs).toBe(MAX_TIMER_DELAY_MS)
    await ctx.fiber.dispose()
  })

  it('leaves the caller command in the resolved spec and wraps it at execution', async () => {
    const { ctx, calls } = await setup()
    const spec = ctx.shell.resolve({ command: 'ls -la', workdir: scratch })
    expect(spec.command).toBe('ls -la')
    const result = await (await ctx.shell.execute(spec)).result()
    expect(result.exitCode).toBe(0)
    expect(calls[0]?.argv).toEqual([
      'bash',
      '-c',
      shellCommandLine(nixShellArgv({ nixBin: echoNix, mode: 'develop', flakeRef: flakeDir, extraArgs: [] }, 'ls -la')),
    ])
    expect(calls[0]?.policy.mode).toBe('workspace-write')
    expect(calls[0]?.policy.workspaceRoot).toBe(scratch)
    await ctx.fiber.dispose()
  })

  it('wraps a spec that never passed through resolve', async () => {
    const { ctx, calls } = await setup()
    const handBuilt: ShellExecSpec = {
      command: 'ls -la',
      workdir: scratch,
      timeoutMs: 5_000,
      onExpiry: 'kill',
      stdoutMaxBytes: 64_000,
      sandboxPolicy: { mode: 'workspace-write', workspaceRoot: scratch },
    }
    const execution = await ctx.shell.execute(handBuilt)
    await execution.done
    expect(calls[0]?.argv[2]).toBe(
      shellCommandLine(nixShellArgv({ nixBin: echoNix, mode: 'develop', flakeRef: flakeDir, extraArgs: [] }, 'ls -la')),
    )
    await ctx.fiber.dispose()
  })

  it('spawns exactly the flake argv through the subprocess seam', async () => {
    const { ctx } = await setup()
    const result = await run(ctx, { command: 'printf \'%s\\n\' "a b" \'$HOME\'', workdir: scratch })
    expect(result.exitCode).toBe(0)
    expect(printedArgv(result.stdout.text)).toEqual([
      echoNix,
      'develop',
      flakeDir,
      '-c',
      'bash',
      '-lc',
      'printf \'%s\\n\' "a b" \'$HOME\'',
    ])
    await ctx.fiber.dispose()
  })

  it('runs the command inside the environment the stand-in nix selects', async () => {
    const { ctx } = await setup({ nixBin: execNix })
    const result = await run(ctx, { command: 'printf %s "$PWD"', workdir: scratch })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.text).toBe(scratch)
    await ctx.fiber.dispose()
  })

  it('reports a nonzero exit as a result, not a rejection', async () => {
    const { ctx } = await setup({ nixBin: execNix })
    const result = await run(ctx, { command: 'exit 3' })
    expect(result.exitCode).toBe(3)
    expect(result.timedOut).toBe(false)
    await ctx.fiber.dispose()
  })

  it('kills the command at its deadline and reports the timeout as a result', async () => {
    const { ctx } = await setup({ nixBin: execNix, timeoutMs: 1_000, maxTimeoutMs: 1_000, developTimeoutMs: 1 })
    const result = await run(ctx, { command: 'sleep 30', timeoutMs: 200 })
    expect(result.timedOut).toBe(true)
    expect(result.stdout.text).toBe('')
    await ctx.fiber.dispose()
  })
})

/** The repository's own flake: the one development environment this suite can rely on existing. */
const repoRoot = dirname(fileURLToPath(new URL('../../../../flake.nix', import.meta.url)))

/** Develop mode needs a nix binary and a real flake; without them the seam cannot be observed end to end. */
const developFlake = resolveExecutable('nix', process.cwd()) !== undefined && existsSync(join(repoRoot, 'flake.nix'))

describe('end to end through the flake', () => {
  it.skipIf(!developFlake)('runs the command inside the flake development environment', { timeout: 180_000 }, async () => {
    const { ctx, calls } = await setup({ nixBin: 'nix', flakeRef: repoRoot, timeoutMs: 60_000 })
    // The seam environment clears IN_NIX_SHELL, so only a command that really
    // ran under `nix develop` can report the value nix sets for its own shell.
    const result = await run(ctx, {
      command: 'printf %s "MARKER:$IN_NIX_SHELL"',
      workdir: repoRoot,
      env: { IN_NIX_SHELL: '' },
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.text).toContain('MARKER:impure')
    expect(calls[0]?.argv.slice(0, 2)).toEqual(['bash', '-c'])
    await ctx.fiber.dispose()
  })
})
