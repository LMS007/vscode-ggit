export interface BranchInfo {
	name: string;
	isHead: boolean;
}

export interface RemoteBranchInfo {
	name: string;
}

export interface CommitInfo {
	hash: string;
	parentHashes: string[];
	authorName: string;
	authorEmail: string;
	date: string;
	message: string;
}

export type FileStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T';

export interface ChangedFile {
	path: string;
	oldPath?: string;
	status: FileStatus;
}
