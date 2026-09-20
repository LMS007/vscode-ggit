import * as vscode from 'vscode';
import { GitService, stripRemotePrefix } from './gitService';
import { WorkingChangeFile } from './types';

/** Resolves which remote branch an action should target: the current branch's tracked
 * upstream if it has one, otherwise prompts with a picker. Undefined if there's no upstream
 * and the user cancels the picker. */
async function resolveTargetRemoteBranch(gitService: GitService, current: string): Promise<string | undefined> {
	const upstream = await gitService.getUpstreamBranch(current);
	if (upstream) {
		return upstream;
	}
	const remoteBranches = await gitService.listRemoteBranches('origin');
	return vscode.window.showQuickPick(
		remoteBranches.map(b => b.name),
		{ placeHolder: `"${current}" has no upstream — pick a remote branch`, ignoreFocusOut: true }
	);
}

function requireCurrentBranch(current: string | undefined): asserts current is string {
	if (!current) {
		throw new Error('Cannot do this while HEAD is detached (no current branch).');
	}
}

export async function fetchWithPicker(gitService: GitService): Promise<void> {
	const current = await gitService.getCurrentBranch();
	requireCurrentBranch(current);
	const target = await resolveTargetRemoteBranch(gitService, current);
	if (target) {
		await gitService.fetchBranch(target);
	}
}

export async function pullWithPicker(gitService: GitService): Promise<void> {
	const current = await gitService.getCurrentBranch();
	requireCurrentBranch(current);
	const target = await resolveTargetRemoteBranch(gitService, current);
	if (target) {
		await gitService.pullBranch(target);
	}
}

/** If the current branch is already published, just pushes it; otherwise prompts for a remote name and publishes + tracks it. */
export async function pushCurrentBranch(gitService: GitService): Promise<void> {
	const current = await gitService.getCurrentBranch();
	requireCurrentBranch(current);

	const upstream = await gitService.getUpstreamBranch(current);
	if (upstream) {
		await gitService.pushBranch(current);
		return;
	}

	const remoteName = await vscode.window.showInputBox({
		prompt: `Publish "${current}" to origin as:`,
		value: current,
		validateInput: value => (value.trim() ? undefined : 'Enter a branch name.'),
		ignoreFocusOut: true,
	});
	if (remoteName) {
		await gitService.publishBranch(current, remoteName.trim());
	}
}

/** Pulls from the target remote branch, then pushes back — publishing first if the branch isn't tracked yet. */
export async function syncCurrentBranch(gitService: GitService): Promise<void> {
	const current = await gitService.getCurrentBranch();
	requireCurrentBranch(current);

	const target = await resolveTargetRemoteBranch(gitService, current);
	if (!target) {
		return;
	}
	await gitService.pullBranch(target);

	const upstream = await gitService.getUpstreamBranch(current);
	if (upstream) {
		await gitService.pushBranch(current);
	} else {
		await gitService.publishBranch(current, stripRemotePrefix(target));
	}
}

/** Tries a safe (`-d`) delete first; git itself refuses that when the branch isn't fully merged, so
 * only then do we escalate to a second, explicit force-delete confirmation — that's the "checkbox
 * for --force if needed" from the request, since a modal dialog can only offer buttons, not a
 * checkbox. */
export async function deleteLocalBranch(gitService: GitService, branchName: string): Promise<void> {
	const confirmed = await vscode.window.showWarningMessage(
		`Delete local branch "${branchName}"?`,
		{ modal: true },
		'Delete Branch'
	);
	if (confirmed !== 'Delete Branch') {
		return;
	}

	try {
		await gitService.deleteBranch(branchName);
		return;
	} catch (err) {
		if (!/not fully merged/i.test((err as Error).message)) {
			throw err;
		}
	}

	const forceConfirmed = await vscode.window.showWarningMessage(
		`"${branchName}" isn't fully merged. Force delete anyway? This can permanently lose commits.`,
		{ modal: true },
		'Force Delete'
	);
	if (forceConfirmed !== 'Force Delete') {
		return;
	}
	await gitService.deleteBranch(branchName, true);
}

export async function renameLocalBranch(gitService: GitService, branchName: string): Promise<void> {
	const newName = await vscode.window.showInputBox({
		prompt: `Rename branch "${branchName}" to:`,
		value: branchName,
		ignoreFocusOut: true,
		validateInput: value => {
			const trimmed = value.trim();
			if (!trimmed) {
				return 'Enter a branch name.';
			}
			if (trimmed === branchName) {
				return 'Enter a different name.';
			}
			return undefined;
		},
	});
	if (!newName) {
		return;
	}
	await gitService.renameBranch(branchName, newName.trim());
}

/** "Mixed" (git's default) is offered as the non-scary option since it keeps working-tree files
 * intact — only "hard" gets the stronger warning, since that's the mode that can actually destroy
 * uncommitted work. */
export async function resetHeadToCommit(gitService: GitService, sha: string, mode: 'mixed' | 'hard'): Promise<void> {
	const shortSha = sha.slice(0, 7);
	if (mode === 'hard') {
		const confirmed = await vscode.window.showWarningMessage(
			`Hard reset to ${shortSha}? This discards all uncommitted changes and permanently removes this branch's commits after this point (if they aren't reachable from anywhere else). This cannot be undone.`,
			{ modal: true },
			'Hard Reset'
		);
		if (confirmed !== 'Hard Reset') {
			return;
		}
	} else {
		const confirmed = await vscode.window.showWarningMessage(
			`Reset to ${shortSha}? This branch's commits after this point will no longer be part of it (your working tree changes are kept, and nothing staged is lost either — that's what "mixed" means here).`,
			{ modal: true },
			'Reset'
		);
		if (confirmed !== 'Reset') {
			return;
		}
	}
	await gitService.resetHead(sha, mode);
}

/** Confirms, with wording tailored to what's actually about to happen — a new/untracked file gets
 * permanently deleted (there's no committed state to fall back to), a deleted file gets restored,
 * and anything else just gets its edits reverted to HEAD/index. A mixed selection gets a single
 * combined confirmation covering every category present. */
export async function discardWorkingChanges(gitService: GitService, files: WorkingChangeFile[]): Promise<void> {
	if (files.length === 0) {
		return;
	}

	const newFiles = files.filter(f => f.status === 'A' || f.status === '?');
	const deletedFiles = files.filter(f => f.status === 'D');
	const otherFiles = files.filter(f => f.status !== 'A' && f.status !== '?' && f.status !== 'D');

	let message: string;
	let confirmLabel: string;
	if (files.length === 1) {
		const fileName = files[0].path.split('/').pop() ?? files[0].path;
		if (newFiles.length === 1) {
			message = `Delete "${fileName}"? It's a new file with no commit history, so this can't be undone.`;
			confirmLabel = 'Delete File';
		} else if (deletedFiles.length === 1) {
			message = `Restore "${fileName}"?`;
			confirmLabel = 'Restore File';
		} else {
			message = `Discard changes in "${fileName}"? This is irreversible.`;
			confirmLabel = 'Discard Changes';
		}
	} else {
		const parts: string[] = [];
		if (otherFiles.length > 0) {
			parts.push(`discard changes in ${otherFiles.length} file${otherFiles.length === 1 ? '' : 's'}`);
		}
		if (deletedFiles.length > 0) {
			parts.push(`restore ${deletedFiles.length} deleted file${deletedFiles.length === 1 ? '' : 's'}`);
		}
		if (newFiles.length > 0) {
			parts.push(`permanently delete ${newFiles.length} new file${newFiles.length === 1 ? '' : 's'}`);
		}
		message = `This will ${joinWithAnd(parts)}. This is irreversible.`;
		confirmLabel = 'Continue';
	}

	const confirmed = await vscode.window.showWarningMessage(message, { modal: true }, confirmLabel);
	if (confirmed !== confirmLabel) {
		return;
	}

	for (const f of files) {
		if (f.status === 'A' || f.status === '?') {
			await gitService.discardNewFile(f.path);
		} else {
			await gitService.discardChanges(f.path);
		}
	}
}

function joinWithAnd(parts: string[]): string {
	if (parts.length <= 1) {
		return parts.join('');
	}
	return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

export function rebaseCurrentBranch(): void {
	void vscode.window.showInformationMessage('Ggit: Rebase isn’t implemented yet.');
}

export async function applyStashWithPicker(gitService: GitService): Promise<void> {
	const stashes = await gitService.listStashes();
	if (stashes.length === 0) {
		void vscode.window.showInformationMessage('GGit: No stashes to apply.');
		return;
	}

	const picked = await vscode.window.showQuickPick(
		stashes.map(stash => ({
			label: stash.message,
			description: stash.ref,
			detail: new Date(stash.date).toLocaleString(),
			stash,
		})),
		{ placeHolder: 'Select a stash to apply', ignoreFocusOut: true }
	);
	if (picked) {
		await gitService.applyStash(picked.stash.ref);
	}
}

/** A single free-text field, so a plain InputBox is the right-sized UI here — no need for a
 * Create-Branch-style custom form. Escape cancels the stash entirely; submitting empty text stashes
 * with git's own default message. */
export async function stashAllWithMessage(gitService: GitService): Promise<void> {
	const message = await vscode.window.showInputBox({
		prompt: 'Stash message (optional)',
		placeHolder: 'e.g. WIP on feature X',
		ignoreFocusOut: true,
	});
	if (message === undefined) {
		return;
	}
	await gitService.stashAll(message.trim() || undefined);
}

export async function stashPathsWithMessage(gitService: GitService, paths: string[]): Promise<void> {
	const message = await vscode.window.showInputBox({
		prompt: `Stash message for ${paths.length} file${paths.length === 1 ? '' : 's'} (optional)`,
		ignoreFocusOut: true,
	});
	if (message === undefined) {
		return;
	}
	await gitService.stashPaths(paths, message.trim() || undefined);
}
