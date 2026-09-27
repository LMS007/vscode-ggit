import { ConflictedFile } from '../git/types';

export interface RebaseHostState {
	branchName: string | undefined;
	/** 1-based index of the commit currently being applied. */
	current: number;
	/** Total commits this rebase is replaying. */
	total: number;
	subject: string | undefined;
	/** The current commit's still-unresolved files -- shrinks as each is checked off (see
	 * rebaseConflictsPanel.ts); once empty, Continue/Finish becomes clickable. */
	files: ConflictedFile[];
	/** Frozen the moment this commit's pause was first seen -- the denominator for "Staged files:
	 * n/m" doesn't shrink alongside `files`, so it reads as progress rather than a fixed instant. */
	totalFilesThisCommit: number;
}

export type RebaseHostMessage = { type: 'state'; state: RebaseHostState } | { type: 'error'; message: string };

export type RebaseWebviewMessage =
	| { type: 'ready' }
	/** A file's checkbox was checked -- saves it (if open and dirty) and stages it. There's no
	 * "unresolve" affordance, so this is fire-and-forget: the row just disappears once the next
	 * 'state' message no longer lists it as conflicted. */
	| { type: 'setResolved'; path: string }
	| { type: 'openFile'; path: string }
	| { type: 'continue' }
	| { type: 'skip' }
	| { type: 'abort' };
