import * as path from 'path';
import * as vscode from 'vscode';
import { GitService } from '../git/gitService';
import { ChangedFile, WorkingChangeFile } from '../git/types';
import { EMPTY_REF, GGIT_SHOW_SCHEME, INDEX_REF, toGGitShowUri } from './showContentProvider';

export async function openDiffForFile(gitService: GitService, sha: string, file: ChangedFile): Promise<void> {
	const base = await gitService.getDiffBase(sha);

	const leftRef = file.status === 'A' ? EMPTY_REF : base;
	const rightRef = file.status === 'D' ? EMPTY_REF : sha;

	const leftPath = file.oldPath ?? file.path;
	const rightPath = file.path;

	const leftUri = toGGitShowUri(leftPath, leftRef);
	const rightUri = toGGitShowUri(rightPath, rightRef);

	const fileName = rightPath.split('/').pop() ?? rightPath;
	const title = `${fileName} (${shortSha(leftRef)} ↔ ${shortSha(rightRef)})`;

	// Beside the History panel, by design — the two are meant to stay open together.
	await showDiff(leftUri, rightUri, title, vscode.ViewColumn.Beside);
}

/** Diffs a Working Copy row against HEAD/index — staged files compare HEAD to the index, unstaged
 * files compare the index to the real on-disk file (so the right side is live and editable, same as
 * the built-in Git extension's "Open Changes"). Renames aren't tracked here, so a renamed file's old
 * path is never looked up — it'll just show as added. */
export async function openDiffForWorkingChange(gitService: GitService, file: WorkingChangeFile): Promise<void> {
	const isNew = file.status === 'A' || file.status === '?';
	const isDeleted = file.status === 'D';

	const leftRef = isNew ? EMPTY_REF : file.state === 'staged' ? 'HEAD' : INDEX_REF;
	const leftUri = toGGitShowUri(file.path, leftRef);

	const rightUri = isDeleted
		? toGGitShowUri(file.path, EMPTY_REF)
		: file.state === 'staged'
			? toGGitShowUri(file.path, INDEX_REF)
			: vscode.Uri.file(path.join(gitService.repoRoot, file.path));

	const fileName = file.path.split('/').pop() ?? file.path;
	const title = `${fileName} (${file.state === 'staged' ? 'Staged Changes' : 'Working Tree'})`;

	// No companion panel to sit beside here (unlike the History view), so open full-width instead
	// of splitting.
	await showDiff(leftUri, rightUri, title, vscode.ViewColumn.Active);
}

/** VS Code's "preview tab" reuse doesn't reliably replace one diff editor with another, so we manage
 * that ourselves — but close the old tab only *after* the new one is open, so the group it lives in
 * never goes empty. Closing first (then reopening "beside") tears the group down and recreates it,
 * which is what caused the History panel to visibly flicker/reflow.
 *
 * The target column always comes from `preferredColumn`, never from wherever a leftover diff tab
 * happens to already be sitting — reusing `existing`'s column here was the bug behind diffs
 * occasionally opening in the same column as the History panel instead of beside it: closing the
 * History tab while a diff tab was still open elsewhere collapses/renumbers editor groups (VS Code
 * removes an emptied group and shifts the rest over), so that stale tab's column could silently
 * become the *same* column History reopens into later. `existing` is only used for cleanup (closing
 * the stale tab afterward), never for placement. */
async function showDiff(leftUri: vscode.Uri, rightUri: vscode.Uri, title: string, preferredColumn: vscode.ViewColumn): Promise<void> {
	const existing = findExistingGGitDiffTab();

	await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title, {
		viewColumn: preferredColumn,
		preview: true,
		// Keep focus in the History webview so its arrow-key file navigation keeps working —
		// without this, opening the diff steals focus and the next keypress goes to the editor.
		preserveFocus: true,
	} satisfies vscode.TextDocumentShowOptions);

	if (existing) {
		try {
			await vscode.window.tabGroups.close(existing.tab);
		} catch {
			// VS Code's own preview-tab reuse (see comment above) sometimes beats us to closing the
			// old tab itself — most reliably when one side of the diff is empty (an added/deleted
			// file), for reasons that aren't fully clear. Either way, if it's already gone there's
			// nothing left to clean up, so this isn't a real failure.
		}
	}
}

function findExistingGGitDiffTab(): { tab: vscode.Tab; group: vscode.TabGroup } | undefined {
	for (const group of vscode.window.tabGroups.all) {
		const tab = group.tabs.find(
			t =>
				t.input instanceof vscode.TabInputTextDiff &&
				(t.input.original.scheme === GGIT_SHOW_SCHEME || t.input.modified.scheme === GGIT_SHOW_SCHEME)
		);
		if (tab) {
			return { tab, group };
		}
	}
	return undefined;
}

function shortSha(ref: string): string {
	return ref === EMPTY_REF ? 'none' : ref.slice(0, 7);
}
