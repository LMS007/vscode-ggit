export interface RebaseDialogState {
	/** The checked-out branch -- the one being rebased. */
	branch: string;
	/** What it can be rebased onto: every other local branch, then every remote branch. */
	localBranches: string[];
	remoteBranches: string[];
	/** Preselected in Onto: the branch it was opened for, or the repo's mainline. */
	onto: string;
	/** git 2.38+, for --update-refs. */
	supportsUpdateRefs: boolean;
	/** Only changes the note saying what happens to uncommitted changes (they're autostashed). */
	hasLocalChanges: boolean;
}

/** What a rebase with the current choices would do -- recomputed on every change (see
 * GitService.previewRebase). */
export interface RebasePreview {
	/** The commits that would be replayed, newest first, up to a limit; `count` is all of them. */
	commits: { sha: string; shortSha: string; subject: string; branches: string[] }[];
	count: number;
	/** Commits `onto` has that the branch doesn't. 0 with every commit replayed means the branch is
	 * already on top of it. */
	behind: number;
	/** Only when replaying the commits after a cut point: the branch's commits before it, which the
	 * rebase leaves out -- they're no longer on the branch afterwards. */
	leftOut?: { commits: { sha: string; shortSha: string; subject: string; branches: string[] }[]; count: number };
	/** Other local branches whose tips are among the replayed commits -- what "move the branches
	 * stacked under it" moves. */
	stacked: string[];
	/** Suggestions for "only the commits after": the local branches between `onto` and the branch. */
	cutPoints: { name: string; upstreamGone: boolean }[];
}

export type RebaseHostMessage =
	| { type: 'init'; state: RebaseDialogState }
	/** Answers the 'preview' request with the same id; an older answer arriving late is ignored. */
	| { type: 'preview'; requestId: number; preview?: RebasePreview; error?: string }
	| { type: 'error'; message: string };

export type RebaseWebviewMessage =
	| { type: 'ready' }
	| { type: 'preview'; requestId: number; onto: string; upstream?: string }
	| { type: 'rebase'; onto: string; upstream?: string; updateRefs: boolean }
	| { type: 'cancel' };
