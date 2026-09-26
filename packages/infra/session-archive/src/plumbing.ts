/**
 * The git plumbing the archiver commits with: `hash-object`, `ls-tree`,
 * `mktree`, `commit-tree`, and `update-ref`.
 *
 * Files are never checked out and the index is never touched. The archive is a
 * ref over objects, not a second working tree: a machine that checked out its
 * archive would need a writable tree per machine, would race the turn's own
 * `git add --all` checkpoint on the shared index, and would materialize
 * gigabytes of session logs that nothing reads from the filesystem. Building
 * the tree from objects keeps the archive a pure write into the object store,
 * so an archive commit and a turn checkpoint can run in either order without
 * seeing each other's half-finished state.
 *
 * @module @dsh-fleet/session-archive/plumbing
 */

import { GitPlumbingError, gitOptional, gitPlumbing, type GitTarget } from './git.ts'

/** One entry of a git tree, as `ls-tree` reports it and `mktree` accepts it. */
interface TreeEntry {
  /** Octal mode, `100644` for a blob and `040000` for a subtree. */
  readonly mode: string
  /** Object type, `blob` or `tree`. */
  readonly type: string
  /** Object id. */
  readonly sha: string
  /** Entry name: one path component, never a path. */
  readonly name: string
}

/**
 * Read one ref's commit id.
 * @param target - the repository and cancellation this command runs under.
 * @param ref - full ref name, or `HEAD`.
 * @returns the commit id, or undefined when the ref does not exist.
 */
export async function resolveRef(target: GitTarget, ref: string): Promise<string | undefined> {
  return await gitOptional(target, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
}

/**
 * List the refs one prefix holds.
 * @param target - the repository and cancellation this command runs under.
 * @param prefix - full ref prefix, ending in `/`.
 * @returns the matching full ref names, in git's reported order.
 * @throws {GitPlumbingError} when git refuses the listing.
 */
export async function listRefs(target: GitTarget, prefix: string): Promise<string[]> {
  const stdout = await gitPlumbing(target, ['for-each-ref', '--format=%(refname)', prefix])
  return stdout.split('\n').filter(line => line !== '')
}

/**
 * Point one ref at a commit.
 *
 * No compare-and-swap is needed: every ref this package writes is inside a
 * machine's own namespace (§7.2), so the only writer of that ref is the
 * machine that owns the shard.
 * @param target - the repository and cancellation this command runs under.
 * @param ref - full ref name to move.
 * @param commit - commit id the ref will name.
 * @throws {GitPlumbingError} when git refuses the update.
 */
export async function updateRef(target: GitTarget, ref: string, commit: string): Promise<void> {
  await gitPlumbing(target, ['update-ref', ref, commit])
}

/**
 * Commit one file into the repository without a checkout or an index write.
 *
 * The commit's tree is the parent commit's tree with one path replaced, so the
 * archive commit carries the repository state it was built on plus this
 * session's log.
 *
 * @param target - the repository and cancellation this command runs under.
 * @param segments - path components of the archived file, relative to the repository root.
 * @param content - the archived file's bytes.
 * @param parent - commit the new commit descends from; omission creates a root commit.
 * @param message - commit message.
 * @returns the new commit id.
 * @throws {GitPlumbingError} when git refuses any step, or reports a tree record this build cannot read.
 */
export async function commitFile(
  target: GitTarget,
  segments: readonly string[],
  content: string,
  parent: string | undefined,
  message: string,
): Promise<string> {
  const name = segments.at(-1)
  if (
    name === undefined
    || name === '.'
    || name === '..'
    || segments.some(segment => segment === '' || segment === '.' || segment === '..' || segment.includes('/'))
  ) {
    throw new GitPlumbingError(
      ['commit-tree'],
      target.repository,
      `archive path is not a list of path components: ${JSON.stringify(segments.join('/'))}`,
    )
  }
  const blob = (await gitPlumbing(target, ['hash-object', '-w', '--stdin'], content)).trim()
  const tree = await writeTree(target, parent, segments.slice(0, -1), {
    mode: '100644',
    type: 'blob',
    sha: blob,
    name,
  })
  const argv = [
    'commit-tree',
    tree,
    ...parent === undefined ? [] : ['-p', parent],
    '-m',
    message,
  ]
  return (await gitPlumbing(target, argv)).trim()
}

/**
 * Write the tree holding one file at one path, keeping every other entry.
 *
 * @param target - the repository and cancellation this command runs under.
 * @param base - tree the parent commit holds, or undefined for no parent.
 * @param segments - remaining directory components; an empty list places the leaf in the base tree.
 * @param leaf - the entry to place at the end of the path.
 * @returns the id of the tree that now holds the entry.
 * @throws {GitPlumbingError} when git refuses the listing or the tree write.
 */
async function writeTree(
  target: GitTarget,
  base: string | undefined,
  segments: readonly string[],
  leaf: TreeEntry,
): Promise<string> {
  const existing = await listTree(target, base)
  const [head, ...rest] = segments
  if (head === undefined) {
    return await makeTree(target, replaceEntry(existing, leaf))
  }
  const child = existing.find(entry => entry.name === head)
  const subtree = await writeTree(target, child?.type === 'tree' ? child.sha : undefined, rest, leaf)
  return await makeTree(target, replaceEntry(existing, { mode: '040000', type: 'tree', sha: subtree, name: head }))
}

/**
 * List one tree's direct entries.
 * @param target - the repository and cancellation this command runs under.
 * @param tree - tree object id, or undefined for a tree with no entries.
 * @returns the entries, in git's stored order.
 * @throws {GitPlumbingError} when git reports a record this build cannot read.
 */
async function listTree(target: GitTarget, tree: string | undefined): Promise<TreeEntry[]> {
  if (tree === undefined) return []
  const argv = ['ls-tree', '-z', tree]
  const stdout = await gitPlumbing(target, argv)
  return stdout
    .split('\0')
    .filter(record => record !== '')
    .map(record => parseTreeRecord(record, argv, target.repository))
}

/**
 * Parse one NUL-terminated `ls-tree -z` record.
 * @param record - `<mode> <type> <sha>\t<name>`, exactly as git wrote it.
 * @param argv - the listing command, for the failure message.
 * @param repository - the repository the listing ran in, for the failure message.
 * @returns the decoded entry.
 * @throws {GitPlumbingError} when the record is not the documented form.
 */
function parseTreeRecord(record: string, argv: readonly string[], repository: string): TreeEntry {
  const tab = record.indexOf('\t')
  const [mode, type, sha] = record.slice(0, tab).split(' ')
  if (tab === -1 || mode === undefined || type === undefined || sha === undefined) {
    throw new GitPlumbingError(argv, repository, `unreadable tree record ${JSON.stringify(record)}`)
  }
  return { mode, type, sha, name: record.slice(tab + 1) }
}

/**
 * Replace or append one entry, leaving every other entry byte-identical.
 * @param entries - the tree's current entries.
 * @param entry - the entry to place, matched by name.
 * @returns the next entry list; `mktree` normalizes its order.
 */
function replaceEntry(entries: readonly TreeEntry[], entry: TreeEntry): TreeEntry[] {
  return [...entries.filter(candidate => candidate.name !== entry.name), entry]
}

/**
 * Write one tree object.
 * @param target - the repository and cancellation this command runs under.
 * @param entries - the tree's complete entry list.
 * @returns the tree object id.
 * @throws {GitPlumbingError} when git refuses the tree.
 */
async function makeTree(target: GitTarget, entries: readonly TreeEntry[]): Promise<string> {
  const input = entries
    .map(entry => `${entry.mode} ${entry.type} ${entry.sha}\t${entry.name}`)
    .join('\0')
    .concat('\0')
  const tree = (await gitPlumbing(target, ['mktree', '-z'], input)).trim()
  if (tree === '') throw new GitPlumbingError(['mktree', '-z'], target.repository, 'git wrote no tree id')
  return tree
}
