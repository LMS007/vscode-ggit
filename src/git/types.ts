export interface BranchInfo {
	name: string;
	isHead: boolean;
	/** Commits on this branch not yet on its upstream, and vice versa — undefined (not 0) when
	 * there's nothing to report, so callers don't need to check both "has an upstream" and "is 0". */
	ahead?: number;
	behind?: number;
}

export interface RemoteBranchInfo {
	name: string;
}

export type RefKind = 'local' | 'remote' | 'tag';

export interface RefBadge {
	name: string;
	kind: RefKind;
}

export interface CommitInfo {
	hash: string;
	parentHashes: string[];
	authorName: string;
	authorEmail: string;
	date: string;
	message: string;
	refs: RefBadge[];
	/** False for a commit that's only reachable from the branch's upstream, not the branch itself
	 * yet (i.e. it's "behind") — shown dimmed rather than left out, same as Tower does. */
	onBranch: boolean;
}

export type FileStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | '?' | 'U';

export interface ChangedFile {
	path: string;
	oldPath?: string;
	status: FileStatus;
	insertions?: number;
	deletions?: number;
	binary?: boolean;
	/** Overrides which commit openDiffForFile diffs this file against — needed for a stash's
	 * untracked files, which live in a separate commit from the stash entry itself. */
	sourceRef?: string;
}

export type WorkingChangeState = 'staged' | 'unstaged';

export interface WorkingChangeFile {
	path: string;
	status: FileStatus;
	state: WorkingChangeState;
}

/** A path git has flagged as having an unresolved merge conflict — mid-rebase, mid-merge, etc. Kept
 * separate from WorkingChangeFile since "staged vs. unstaged" doesn't apply until it's resolved. */
export interface ConflictedFile {
	path: string;
}

export interface StashInfo {
	/** "stash@{0}" — the reflog-style ref git's own stash commands expect. */
	ref: string;
	/** The stash commit's own hash — stable even if the list re-indexes, and generic commit-diffing
	 * code (getCommitFiles, getFileContentAtRevision, openDiffForFile) already accepts any commit-ish. */
	hash: string;
	message: string;
	date: string;
}
