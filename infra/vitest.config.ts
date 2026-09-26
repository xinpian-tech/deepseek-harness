/**
 * Vitest entry point for the fleet packages.
 *
 * The repository config cannot serve them in this checkout: Vite 8 resolves
 * tsconfig paths natively by default, but it reads the root solution
 * `tsconfig.json`, which maps no specifier. The `tsconfig.base.json` aliases
 * that point every `@deepseek-ai/*` specifier at `src` therefore never apply
 * and resolution falls through to `lib/` output that only a full
 * `pnpm run build` produces. This config reads the same alias table and hands
 * it to Vite directly, so a fleet spec resolves exactly the source files the
 * repository aggregates type-check.
 *
 * Run it with:
 *   nix develop -c pnpm exec vitest run --config infra/vitest.config.ts
 *
 * @module infra/vitest.config
 */

import { readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin, vitestExecArgv } from '../vitest.shared.ts'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

/**
 * Read the repository's specifier aliases out of its resolution facade.
 *
 * The file is JSON with comments and a trailing comma, so it is parsed with
 * the same parser the TypeScript build uses rather than a hand-rolled
 * stripping pass that would break on a comment inside a string.
 *
 * @returns Vite alias entries, most specific first so prefix matching cannot
 * let a shorter alias shadow a longer one.
 */
function aliasesFromTsconfig(): { find: string; replacement: string }[] {
  const text = readFileSync(resolve(repoRoot, 'tsconfig.base.json'), 'utf8')
  const parsed = ts.parseConfigFileTextToJson('tsconfig.base.json', text)
  const paths = (parsed.config?.compilerOptions?.paths ?? {}) as Record<string, string[]>
  return Object.entries(paths)
    .flatMap(([specifier, targets]) => {
      const target = targets[0]
      if (target === undefined) return []
      return [{
        find: specifier,
        replacement: isAbsolute(target) ? target : resolve(repoRoot, target),
      }]
    })
    .sort((left, right) => right.find.length - left.find.length)
}

export default defineConfig({
  root: repoRoot,
  // The alias table above replaces Vite's own tsconfig lookup, which resolves
  // against the wrong file in this checkout.
  resolve: { tsconfigPaths: false, alias: aliasesFromTsconfig() },
  plugins: [standardDecoratorPlugin()],
  test: {
    name: 'fleet',
    execArgv: vitestExecArgv,
    // Fleet specs own real processes and temporary git repositories, so they
    // run in forked workers like every other process-bound suite.
    pool: 'forks',
    // A spec that places a pane, or drives one tmux subcommand per assertion,
    // pays several process spawns; the repository default assumes a pure unit.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // The repository's invariant host is deliberately absent: it reads
    // `FiberState`, which cordis declares as a const enum, so the value exists
    // only in compiled output and is `undefined` for any spec that loads
    // cordis from source. The fleet packages publish no `./invariant`
    // companion, so nothing here needs that host.
    setupFiles: [
      './scripts/test-proxy-environment.ts',
      './scripts/test-dom-environment.ts',
    ],
    include: [
      'packages/infra/*/tests/**/*.spec.ts',
      'packages/bundle/fleet/tests/**/*.spec.ts',
    ],
  },
})
