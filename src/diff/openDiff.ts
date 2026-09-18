import * as vscode from 'vscode';
import { GitService } from '../git/gitService';
import { ChangedFile } from '../git/types';
import { EMPTY_REF, toGgitShowUri } from './showContentProvider';

export async function openDiffForFile(gitService: GitService, sha: string, file: ChangedFile): Promise<void> {
	const base = await gitService.getDiffBase(sha);

	const leftRef = file.status === 'A' ? EMPTY_REF : base;
	const rightRef = file.status === 'D' ? EMPTY_REF : sha;

	const leftPath = file.oldPath ?? file.path;
	const rightPath = file.path;

	const leftUri = toGgitShowUri(leftPath, leftRef);
	const rightUri = toGgitShowUri(rightPath, rightRef);

	const fileName = rightPath.split('/').pop() ?? rightPath;
	const title = `${fileName} (${shortSha(leftRef)} ↔ ${shortSha(rightRef)})`;

	await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title);
}

function shortSha(ref: string): string {
	return ref === EMPTY_REF ? 'none' : ref.slice(0, 7);
}
