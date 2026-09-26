/**
 * Vocabulary of the bypass session archiver: where one archived session lives,
 * and the grouping view reconstructed from archived headers.
 *
 * There is deliberately no session event here. An archiver that appended a
 * record of its own run into the log it archives would change the artifact it
 * just committed, so the ref and the commit are the durable record (§7.2).
 *
 * @module @dsh-fleet/session-archive/types
 */

/** Where one archived session's commit lives. */
export interface ArchivedRef {
  /** Full ref name, `refs/dsh/machines/<machine>/sessions/<session>` by default. */
  readonly ref: string
  /** Commit carrying this session's archived log. */
  readonly commit: string
}

/**
 * One archived session, as the grouping view reconstructs it from the archived
 * headers rather than from the ref layout.
 */
export interface ArchivedSession {
  /** Session id, read from the archived header. */
  readonly id: string
  /**
   * Session this one was forked from, read from the archived header. A parent
   * that is not archived anywhere in this checkout keeps its link here and
   * contributes no ancestor.
   */
  readonly parentSession?: string
  /** Creation time from the archived header, which orders sibling sessions. */
  readonly createdAt: number
  /** Machine that archived this session: the shard directory the file was found under. */
  readonly machine: string
  /** Absolute path of the archived log in this checkout. */
  readonly archivePath: string
  /** Direct children in this checkout, ordered by `createdAt` then id. */
  readonly children: readonly ArchivedSession[]
}

/** The parent/child tree one archived session belongs to. */
export interface SessionFamily {
  /** Top-most archived ancestor; its `children` reach every archived descendant. */
  readonly root: ArchivedSession
  /** The queried session, with its own subtree. */
  readonly session: ArchivedSession
  /** Archived ancestors from {@link root} down to the queried session's parent. */
  readonly ancestors: readonly ArchivedSession[]
}
