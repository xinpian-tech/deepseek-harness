/**
 * Command construction for the flake-environment executor: the exact argv one
 * command runs as, and the single-quoted shell line that carries that argv
 * through the `bash -c` layer the shell seam spawns.
 * @module @dsh-fleet/nix-shell/command
 */

/** Which nix subcommand supplies the environment a command runs in. */
export type NixShellMode = 'develop' | 'shell'

/** Everything that names the environment one command runs in. */
export interface NixShellInvocation {
  /** Absolute path of the nix executable. */
  readonly nixBin: string
  /** Subcommand selecting the environment (`nix develop` or `nix shell`). */
  readonly mode: NixShellMode
  /** Flake reference the environment is realised from. */
  readonly flakeRef: string
  /** Extra nix arguments inserted between the flake reference and `-c`. */
  readonly extraArgs: readonly string[]
}

/**
 * The exact argv that runs one command inside the flake environment.
 *
 * `nix <mode> <flakeRef> <extraArgs…> -c bash -lc <command>` hands the command
 * to the login shell as one argv element, so `ls` and a pipeline both reach
 * the shell exactly as written and nothing in the command text is parsed by
 * nix. `-c` is nix's command separator: everything after it is exec'd inside
 * the environment, which is what makes a package installation land in a
 * throwaway environment instead of on the machine.
 *
 * @param invocation - nix binary, environment selector, and extra arguments.
 * @param command - the caller's command text, passed through verbatim.
 * @returns the argv to spawn, ending with the command as one element.
 */
export function nixShellArgv(invocation: NixShellInvocation, command: string): string[] {
  return [
    invocation.nixBin,
    invocation.mode,
    invocation.flakeRef,
    ...invocation.extraArgs,
    '-c',
    'bash',
    '-lc',
    command,
  ]
}

/**
 * Quote one value as a single-quoted POSIX shell word.
 * @param value - arbitrary text, including quotes, `$`, and whitespace.
 * @returns the value wrapped so a POSIX shell reproduces it byte for byte.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/**
 * Render an argv as one POSIX shell command line with no unquoted word.
 *
 * This line is what the shell seam's own `bash -c` layer parses before the
 * flake invocation runs, so every element is quoted: an argument that carries
 * a space, a quote, or `$` survives as the same argv element rather than being
 * re-split or expanded.
 *
 * @param argv - the exact argv the line must reproduce.
 * @returns every element as one single-quoted word, joined by single spaces.
 */
export function shellCommandLine(argv: readonly string[]): string {
  return argv.map(shellQuote).join(' ')
}
