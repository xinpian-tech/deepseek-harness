/**
 * The Nix rule as one text, plus the delimited block that carries it into a
 * workspace instruction file.
 *
 * The registered prompt section and the `AGENTS.md` block both read
 * {@link NIX_MANDATE} verbatim, so the text a dsh model receives and the text
 * Codex, Kimi, and Claude read cannot drift apart.
 *
 * @module @dsh-fleet/nix-mandate/mandate
 */

/** Opening delimiter of the instruction-file region this plugin owns. */
export const AGENTS_BLOCK_BEGIN = '<!-- BEGIN dsh-fleet nix mandate -->'

/** Closing delimiter of the instruction-file region this plugin owns. */
export const AGENTS_BLOCK_END = '<!-- END dsh-fleet nix mandate -->'

/**
 * The rule, word for word as a model reads it: the prompt section's complete
 * text and the body of the instruction-file block.
 *
 * It names the dependency source, the command wrapper, the discardability of
 * build outputs, the forbidden installers, and the three commands every task in
 * the workspace is accepted by. It contains no `{{` sequence, so prompt-variable
 * interpolation passes it through unchanged.
 */
export const NIX_MANDATE = [
  'Every dependency of this workspace comes from `flake.nix` and `flake.lock`, and every command runs inside `nix develop -c <command>`.',
  '',
  'Do not run `npm install`, `pip install`, `apt install`, `cargo install`, `go install`, or `curl … | sh`, and do not call a tool the flake does not provide: a tool that happens to exist on this machine is not a dependency of this workspace.',
  '',
  'Build outputs in the workspace are discardable. Delete them, rebuild them from the flake, and the rebuild produces the same result.',
  '',
  'Three commands are machine-checked acceptance items for every task here, and each must exit 0: `nix flake check`, `nix build .#default`, and `nix develop -c <project test command>`. A workspace without a flake fails all three, so no task in such a workspace passes.',
].join('\n')

/** Heading that introduces {@link NIX_MANDATE} inside a Markdown instruction file. */
const AGENTS_BLOCK_HEADING = '## Nix is the only dependency source'

/**
 * Render the complete delimited block, without a trailing newline.
 * @returns the opening delimiter, the heading, {@link NIX_MANDATE}, and the closing delimiter.
 */
export function renderAgentsBlock(): string {
  return [AGENTS_BLOCK_BEGIN, '', AGENTS_BLOCK_HEADING, '', NIX_MANDATE, '', AGENTS_BLOCK_END].join('\n')
}
