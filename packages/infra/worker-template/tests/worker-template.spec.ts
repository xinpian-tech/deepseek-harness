/**
 * Worker-template behaviour: hostile-path quoting, the exact launch line and
 * pane environment, the credential report and its warning, the launch over the
 * composed tmux channel, and disposal.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import FleetTmux from '@dsh-fleet/tmux'
import WorkerTemplate, {
  DEFAULT_CREDENTIAL_ENV,
  WorkerTemplateError,
  buildLaunchLine,
  resolveConfig,
  resolvePaneEnv,
  shellQuote,
} from '../src/index.ts'
import type { Config } from '../src/index.ts'

/** One credential variable the tests set and remove again. */
const PRESENT_KEY = 'DSH_FLEET_TEST_KEY'
/** One credential variable the tests never set. */
const ABSENT_KEY = 'DSH_FLEET_ABSENT_KEY'

let dir: string
let argvLog: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fleet-worker-template-'))
  argvLog = join(dir, 'argv.log')
  writeFileSync(argvLog, '')
})

afterEach(() => {
  // `Reflect.deleteProperty` keeps the removal off the dynamic-`delete` rule
  // while still clearing the variable the launch reads.
  Reflect.deleteProperty(process.env, PRESENT_KEY)
  rmSync(dir, { recursive: true, force: true })
})

/** The argv log as one string; every tmux subcommand this suite ran appears in it. */
function issued(): string {
  return readFileSync(argvLog, 'utf8')
}

/**
 * A tmux binary that records its argv and answers the queries the channel
 * asks: which windows the session holds, and which process a pane runs.
 *
 * The window it reports becomes visible only once `new-window` was actually
 * asked for it, so a first launch creates a pane and a later resident launch
 * adopts the one that exists — the same sequence a real tmux server produces.
 *
 * @param window - window name the session should hold, or `''` for a session
 * that never gains one (the pane-never-appears case).
 * @returns the executable path.
 */
function fakeTmux(window: string): string {
  const path = join(dir, 'tmux')
  const state = join(dir, 'window-state')
  writeFileSync(path, [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> ${JSON.stringify(argvLog)}`,
    'case "$1" in',
    `  new-window) [ -n ${JSON.stringify(window)} ] && : > ${JSON.stringify(state)} ;;`,
    `  list-windows) [ -f ${JSON.stringify(state)} ] && printf '%s\\n' ${JSON.stringify(window)} ;;`,
    "  list-panes) case \"$*\" in *pane_current_command*) printf '%s\\n' 'dsh' ;; *) printf '%s\\n' '4321' ;; esac ;;",
    'esac',
    'exit 0',
    '',
  ].join('\n'))
  chmodSync(path, 0o755)
  return path
}

/**
 * Mount the composed channel and the template over one fake tmux.
 *
 * Both rows receive the same launch specification: the channel builds the
 * pane's command from its own configuration, so a deployment that configures
 * them differently would run a different line than the one this template
 * reports.
 *
 * @param options - window the fake server reports, the shared launch specification, and template config overrides.
 * @returns the context, the template service, and the fiber that owns it.
 */
async function mount(
  options: {
    readonly window?: string
    readonly launch?: { readonly dshBin?: string; readonly profile?: string; readonly patches?: string[] }
    readonly config?: Partial<Config>
  } = {},
): Promise<{ ctx: Context; template: WorkerTemplate; fiber: Awaited<ReturnType<Context['plugin']>> }> {
  const launch = {
    dshBin: '/opt/harness/bin/dsh',
    profile: 'sdk',
    patches: [] as string[],
    ...options.launch,
  }
  const ctx = new Context()
  await ctx.plugin(SubprocessLocal)
  await ctx.plugin(FleetTmux, {
    tmuxBin: fakeTmux(options.window ?? 'w-worker-1'),
    dshBin: launch.dshBin,
    profile: launch.profile,
    patches: launch.patches,
    dshHome: dir,
    machineId: 'machine-1',
    credentialEnv: [],
  })
  const fiber = await ctx.plugin(WorkerTemplate, {
    dshHome: dir,
    dshBin: launch.dshBin,
    profile: launch.profile,
    patches: launch.patches,
    ...options.config,
  })
  return { ctx, template: ctx.workerTemplate, fiber }
}

describe('shell quoting', () => {
  it.each([
    ['a plain path', '/opt/harness/bin/dsh'],
    ['a space', '/opt/harness bin/dsh'],
    ['a single quote', "/opt/it's/dsh"],
    ['a dollar sign', '/opt/$HOME/dsh'],
    ['a newline', '/opt/two\nlines/dsh'],
    ['a command separator', '/opt/a; rm -rf /'],
    ['a backtick', '/opt/`id`/dsh'],
    ['a double quote', '/opt/"quoted"/dsh'],
  ])('reproduces %s byte for byte through a shell', (_label, value) => {
    const quoted = shellQuote(value)
    const printed = execFileSync('/bin/sh', ['-c', `printf '%s' ${quoted}`], { encoding: 'utf8' })
    expect(printed).toBe(value)
  })

  it('keeps a hostile path inside one word of the launch line', () => {
    const line = buildLaunchLine({
      dshBin: '/opt/harness bin/dsh',
      profile: 'sdk',
      patches: ["/etc/fleet/it's; rm -rf /.yml", '/etc/fleet/two\nlines.yml'],
    })
    expect(line).toBe(
      "stty -echo -icanon; exec '/opt/harness bin/dsh' --profile 'sdk' --patch '/etc/fleet/it'\\''s; rm -rf /.yml' "
      + "--patch '/etc/fleet/two\nlines.yml'",
    )
  })
})

describe('launch line', () => {
  it('execs the harness with its profile and ordered patches', () => {
    expect(buildLaunchLine({ dshBin: 'dsh', profile: 'sdk', patches: [] }))
      .toBe("stty -echo -icanon; exec 'dsh' --profile 'sdk'")
    expect(buildLaunchLine({
      dshBin: '/opt/harness/bin/dsh',
      profile: 'sdk-minimal',
      patches: ['/etc/fleet/no-messaging.cordis.patch.yml', '/etc/fleet/fleet.cordis.patch.yml'],
    })).toBe(
      "stty -echo -icanon; exec '/opt/harness/bin/dsh' --profile 'sdk-minimal' "
      + "--patch '/etc/fleet/no-messaging.cordis.patch.yml' --patch '/etc/fleet/fleet.cordis.patch.yml'",
    )
  })
})

describe('pane environment', () => {
  it('forwards only the credentials the launching process holds', () => {
    const resolved = resolvePaneEnv({
      dshHome: '/var/lib/dsh',
      credentialEnv: [PRESENT_KEY, ABSENT_KEY],
      extraEnv: {},
      env: { [PRESENT_KEY]: 'secret-value', [ABSENT_KEY]: '' },
    })
    expect(resolved.env).toEqual({ DSH_HOME: '/var/lib/dsh', [PRESENT_KEY]: 'secret-value' })
    expect(resolved.missing).toEqual([ABSENT_KEY])
  })

  it('lays explicit pairs over the credential allowlist', () => {
    const resolved = resolvePaneEnv({
      dshHome: '/var/lib/dsh',
      credentialEnv: [PRESENT_KEY],
      extraEnv: { [PRESENT_KEY]: 'explicit', DSH_FLEET_ROLE: 'worker' },
      env: { [PRESENT_KEY]: 'ambient' },
    })
    expect(resolved.env).toEqual({
      DSH_HOME: '/var/lib/dsh',
      [PRESENT_KEY]: 'explicit',
      DSH_FLEET_ROLE: 'worker',
    })
    expect(resolved.missing).toEqual([])
  })
})

describe('configuration', () => {
  const base: Config = {
    profile: 'sdk',
    patches: [],
    dshBin: 'dsh',
    dshHome: '/var/lib/dsh',
    credentialEnv: [...DEFAULT_CREDENTIAL_ENV],
    extraEnv: {},
    enableStty: true,
    startTimeoutMs: 15_000,
    confirmPollMs: 50,
  }

  it('defaults the profile, binary, and credential allowlist', () => {
    const resolved = resolveConfig({ dshHome: '/var/lib/dsh' })
    expect(resolved.profile).toBe('sdk')
    expect(resolved.dshBin).toBe('dsh')
    expect(resolved.credentialEnv).toEqual([...DEFAULT_CREDENTIAL_ENV])
    expect(resolved.patches).toEqual([])
    expect(resolved.enableStty).toBe(true)
  })

  it.each([
    ['a relative harness home', { dshHome: 'var/lib/dsh' }],
    ['a relative patch', { dshHome: '/var/lib/dsh', patches: ['patches/fleet.yml'] }],
    ['an empty binary', { dshHome: '/var/lib/dsh', dshBin: '' }],
    ['an empty profile', { dshHome: '/var/lib/dsh', profile: '' }],
    ['a credential name that is not a name', { dshHome: '/var/lib/dsh', credentialEnv: ['DEEPSEEK-API-KEY'] }],
    ['an extra name that is not a name', { dshHome: '/var/lib/dsh', extraEnv: { '1ROLE': 'worker' } }],
    ['a nonpositive start bound', { dshHome: '/var/lib/dsh', startTimeoutMs: 0 }],
    ['a nonpositive confirm interval', { dshHome: '/var/lib/dsh', confirmPollMs: 0 }],
  ])('rejects %s', (_label, override) => {
    expect(() => resolveConfig({ ...base, ...override })).toThrow(TypeError)
  })

  it('refuses a configuration that claims the pane needs no echo suppression', () => {
    expect(() => resolveConfig({ ...base, enableStty: false })).toThrow(/requires tty echo suppression/)
  })
})

describe('launch over the composed channel', () => {
  it('reports the line and environment the pane received', async () => {
    process.env[PRESENT_KEY] = 'secret-value'
    const { ctx, template, fiber } = await mount({
      launch: { dshBin: '/opt/harness bin/dsh', patches: ["/etc/fleet/it's.yml"] },
      config: {
        credentialEnv: [PRESENT_KEY, ABSENT_KEY],
        extraEnv: { DSH_FLEET_ROLE: 'worker' },
      },
    })
    const warnings: string[] = []
    ctx.logger.exporter({
      colors: false,
      // The default exporter threshold is info; a warning needs its own level.
      levels: { default: 3 },
      export: (message) => { if (message.type === 'warn') warnings.push(String(message.args[0])) },
    })
    try {
      const handle = await template.launch('worker-1', { cwd: dir })
      const expectedEnv = {
        DSH_HOME: dir,
        [PRESENT_KEY]: 'secret-value',
        DSH_FLEET_ROLE: 'worker',
      }
      expect(handle.reused).toBe(false)
      expect(handle.placement.target).toBe('dsh-fleet:w-worker-1')
      expect(handle.env).toEqual(expectedEnv)
      expect(handle.launchLine)
        .toBe("stty -echo -icanon; exec '/opt/harness bin/dsh' --profile 'sdk' --patch '/etc/fleet/it'\\''s.yml'")

      const ran = issued()
      // The pane received exactly the reported entries, and the pane ran
      // exactly the reported line after its tty was made non-echoing.
      expect(ran).toContain(`-e DSH_HOME=${dir}`)
      expect(ran).toContain(`-e ${PRESENT_KEY}=secret-value`)
      expect(ran).toContain('-e DSH_FLEET_ROLE=worker')
      expect(ran).not.toContain(`${ABSENT_KEY}=`)
      // The line the channel handed tmux as the pane's command is the line
      // this launch reported, tty setup included.
      expect(ran).toContain(handle.launchLine)
      expect(warnings.some(line => line.includes(ABSENT_KEY))).toBe(true)
    } finally {
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('reports each configured credential without ever returning a value', async () => {
    process.env[PRESENT_KEY] = 'secret-value'
    const { ctx, template } = await mount({ config: { credentialEnv: [PRESENT_KEY, ABSENT_KEY] } })
    try {
      const report = template.credentialReport()
      expect(report).toEqual([
        { name: PRESENT_KEY, present: true },
        { name: ABSENT_KEY, present: false },
      ])
      expect(JSON.stringify(report)).not.toContain('secret-value')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reuses a resident pane instead of placing a second one', async () => {
    const { ctx, template } = await mount()
    try {
      const first = await template.launch('worker-1', { cwd: dir })
      const second = await template.launch('worker-1', { cwd: dir })
      expect(second.reused).toBe(true)
      expect(second.placement.target).toBe(first.placement.target)
      expect(issued().match(/new-window -d -t dsh-fleet -n w-worker-1/gu)).toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects a working directory that is not absolute', async () => {
    const { ctx, template } = await mount()
    try {
      await expect(template.launch('worker-1', { cwd: '.dsh-fleet/frames' })).rejects.toThrow(TypeError)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('fails a launch whose pane never appears, and leaves no pane behind', async () => {
    const { ctx, template } = await mount({
      window: '',
      config: { startTimeoutMs: 200, confirmPollMs: 5 },
    })
    try {
      await expect(template.launch('worker-1', { cwd: dir })).rejects.toThrow(WorkerTemplateError)
      expect(issued()).toContain('kill-window -t dsh-fleet:w-worker-1')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('disposal', () => {
  it('removes the service registration', async () => {
    const { ctx, fiber } = await mount()
    expect(ctx.get('workerTemplate')).toBeDefined()
    await fiber.dispose()
    expect(ctx.get('workerTemplate')).toBeUndefined()
    await ctx.fiber.dispose()
  })
})
