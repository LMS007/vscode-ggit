export interface BranchInfo {
	name: string;
	isHead: boolean;
	/** Commits on this branch not yet on its upstream, and vice versa — undefined (not 0) when
	 * there's nothing to report, so callers don't need to check both "has an upstream" and "is 0". */
	ahead?: number;
	behind?: number;
	/** Set when this branch is checked out in a worktree other than the one GGit is currently
	 * running against — git refuses to check it out here while that's true. Undefined for the
	 * current worktree's own branch (that's `isHead` instead) and for anything not checked out
	 * anywhere. */
	worktreePath?: string;
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

/** git's progress through an in-progress rebase -- see GitService.getRebaseProgress. */
export interface RebaseProgress {
	/** 1-based index of the commit currently being applied. */
	current: number;
	/** Total commits this rebase is replaying. */
	total: number;
	/** The current commit's subject line -- only available on the modern merge-based rebase backend
	 * (.git/rebase-merge), undefined on the older apply-based one (.git/rebase-apply). */
	subject: string | undefined;
	/** The branch being rebased -- undefined if it can't be determined (e.g. it was a detached HEAD
	 * rebase). `getCurrentBranch()` can't be used for this mid-rebase: HEAD is detached for the whole
	 * span of a rebase, so it would just report no branch at all. */
	branchName: string | undefined;
}

/** An in-progress (stopped) merge -- see GitService.getMergeProgress. */
export interface MergeProgress {
	/** The branch being merged in, parsed from git's own "Merge branch '...'" message -- falls back to
	 * MERGE_HEAD's short hash for anything that message doesn't name (e.g. merging a bare commit). */
	branchName: string | undefined;
	/** The branch receiving the merge (HEAD stays attached for the whole span of a merge, unlike a
	 * rebase, so this is just the current branch). */
	intoBranch: string | undefined;
}

/** What merging `branch` into HEAD would do, worked out before anything is touched -- see
 * GitService.analyzeMerge. */
export interface MergeAnalysis {
	/** Commits on the branch that HEAD doesn't have yet -- 0 means there's nothing to merge. */
	incoming: number;
	/** Commits on HEAD that the branch doesn't have -- 0 (with incoming > 0) means a fast-forward. */
	outgoing: number;
	/** Files a real merge would leave conflicted, predicted with `git merge-tree` -- always empty for a
	 * fast-forward, which can't conflict. */
	conflicts: string[];
}

/** The Merge dialog's choices, mapped onto `git merge` flags in GitService.mergeBranch. */
export interface MergeOptions {
	/** `--squash`: the branch's changes land as one ordinary (non-merge) commit. */
	squash: boolean;
	/** `--no-ff`: create a merge commit even when a fast-forward would do. */
	noFastForward: boolean;
	/** false means `--no-commit` (or, for a squash, stopping before the commit) -- the result is left
	 * staged for review instead. */
	commit: boolean;
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
