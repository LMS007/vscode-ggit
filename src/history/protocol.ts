import type { ChangedFile, CommitInfo } from '../git/types';

export type HostMessage =
	| { type: 'commits'; branchName: string; commits: CommitInfo[] }
	| { type: 'files'; sha: string; files: ChangedFile[] }
	| { type: 'error'; message: string };

export type WebviewMessage =
	| { type: 'ready' }
	| { type: 'selectCommit'; sha: string }
	| { type: 'openDiff'; sha: string; file: ChangedFile };
