import { FileStatus } from '../git/types';

export interface CommitStagedFile {
	path: string;
	status: FileStatus;
	/** Whether this row is currently staged — the file list shows both staged and unstaged changes
	 * (like Working Copy does) so a file can be staged/unstaged from here too, not just committed. */
	staged: boolean;
}

export type CommitHostMessage =
	| {
			type: 'staged';
			files: CommitStagedFile[];
			insertions: number;
			deletions: number;
			/** The current HEAD commit's message, split subject/body — what Amend pre-fills the form
			 * with. */
			lastCommitSubject: string;
			lastCommitBody: string;
			/** False for a brand-new repo with no commits yet — nothing to amend. */
			hasHead: boolean;
			/** Undefined for a detached HEAD — there's no branch name to show in that case. */
			branch: string | undefined;
	  }
	| { type: 'error'; message: string }
	| { type: 'committed' };

export type CommitWebviewMessage =
	| { type: 'ready' }
	| { type: 'commit'; subject: string; body: string; amend: boolean }
	| { type: 'setStaged'; path: string; staged: boolean }
	| { type: 'setAllStaged'; staged: boolean };
