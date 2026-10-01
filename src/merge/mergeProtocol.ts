import { MergeAnalysis } from '../git/types';

export interface MergeDialogState {
	/** The branch that was dragged -- fixed for this dialog, since the drag itself is what chose it. */
	sourceBranch: string;
	/** The current HEAD branch, the one being merged into. */
	intoBranch: string;
	analysis: MergeAnalysis;
	/** Whether the working tree has uncommitted changes -- only changes the note explaining what
	 * happens to them (see GitService.mergeBranch's autostash comment). */
	hasLocalChanges: boolean;
}

export type MergeHostMessage = { type: 'init'; state: MergeDialogState } | { type: 'error'; message: string };

export type MergeWebviewMessage =
	| { type: 'ready' }
	| { type: 'merge'; squash: boolean; noFastForward: boolean; commit: boolean }
	| { type: 'cancel' };
