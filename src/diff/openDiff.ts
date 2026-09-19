import * as vscode from 'vscode';
import { GitService } from '../git/gitService';
import { ChangedFile } from '../git/types';
import { EMPTY_REF, toGGitShowUri } from './showContentProvider';

type ChangeResource = [vscode.Uri, vscode.Uri | undefined, vscode.Uri | undefined];

/** Opens every changed file in the commit as one multi-file diff editor, so the user can scroll between files instead of stacking a separate tab per file. */
export async function openDiffForCommit(gitService: GitService, sha: string, files: ChangedFile[]): Promise<void> {
	const base = await gitService.getDiffBase(sha);
	const repoRootUri = vscode.Uri.file(gitService.repoRoot);

	const resources: ChangeResource[] = files.map(file => {
		const leftRef = file.status === 'A' ? EMPTY_REF : base;
		const rightRef = file.status === 'D' ? EMPTY_REF : sha;
		const leftPath = file.oldPath ?? file.path;
		const rightPath = file.path;

		return [
			vscode.Uri.joinPath(repoRootUri, rightPath),
			leftRef === EMPTY_REF ? undefined : toGGitShowUri(leftPath, leftRef),
			rightRef === EMPTY_REF ? undefined : toGGitShowUri(rightPath, rightRef),
		];
	});

	const title = `${sha.slice(0, 7)} — ${files.length} file${files.length === 1 ? '' : 's'} changed`;
	await vscode.commands.executeCommand('vscode.changes', title, resources);
}
