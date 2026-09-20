import type { ChangedFile } from '../git/types';

export type CommitFilesHostMessage = {
	type: 'files';
	sha: string;
	commitMessage: string;
	files: ChangedFile[];
	selectedIndex: number;
};

export type CommitFilesWebviewMessage = { type: 'ready' } | { type: 'selectFile'; index: number };
