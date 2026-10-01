import { ConflictedFile } from '../git/types';

/** Which kind of stopped operation the Conflicts tab is working through -- both pause the same way
 * (conflicted files to resolve and stage, then continue or abort), so one tab serves either. */
export type ConflictOperation = 'rebase' | 'merge';

export interface ConflictsHostState {
	operation: ConflictOperation;
	/** Rebase: the branch being rebased. Merge: the branch being merged in. */
	branchName: string | undefined;
	/** Merge only: the branch receiving the merge (HEAD). */
	intoBranch: string | undefined;
	/** Rebase only: 1-based index of the commit currently being applied (0 for a merge). */
	current: number;
	/** Rebase only: total commits this rebase is replaying (0 for a merge). */
	total: number;
	/** Rebase only: the paused commit's subject line. */
	subject: string | undefined;
	/** The still-unresolved files -- shrinks as each is checked off (see conflictsPanel.ts); once
	 * empty, Continue/Finish/Commit Merge becomes clickable. */
	files: ConflictedFile[];
	/** Frozen the moment this pause was first seen -- the denominator for "Staged files: n/m" doesn't
	 * shrink alongside `files`, so it reads as progress rather than a fixed instant. */
	totalFilesThisCommit: number;
}

export type ConflictsHostMessage = { type: 'state'; state: ConflictsHostState } | { type: 'error'; message: string };

export type ConflictsWebviewMessage =
	| { type: 'ready' }
	/** A file's checkbox was checked -- saves it (if open and dirty) and stages it. There's no
	 * "unresolve" affordance, so this is fire-and-forget: the row just disappears once the next
	 * 'state' message no longer lists it as conflicted. */
	| { type: 'setResolved'; path: string }
	| { type: 'openFile'; path: string }
	/** Rebase: next commit / finish. Merge: commit the merge. */
	| { type: 'continue' }
	/** Rebase only. */
	| { type: 'skip' }
	| { type: 'abort' };
