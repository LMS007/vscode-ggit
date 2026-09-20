export interface BranchInfo {
	name: string;
	isHead: boolean;
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
}

export type FileStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | '?';

export interface ChangedFile {
	path: string;
	oldPath?: string;
	status: FileStatus;
	insertions?: number;
	deletions?: number;
	binary?: boolean;
}

export type WorkingChangeState = 'staged' | 'unstaged';

export interface WorkingChangeFile {
	path: string;
	status: FileStatus;
	state: WorkingChangeState;
}
