import * as vscode from 'vscode';
import { GitService, stripRemotePrefix } from './gitService';

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

export function rebaseCurrentBranch(): void {
	void vscode.window.showInformationMessage('Ggit: Rebase isn’t implemented yet.');
}

export function applyStash(): void {
	void vscode.window.showInformationMessage('Ggit: Apply Stash isn’t implemented yet.');
}
