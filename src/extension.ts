import * as path from 'path';
import * as vscode from 'vscode';
import { CreateBranchPanel } from './branch/createBranchPanel';
import { BranchHistoryPanel } from './history/branchHistoryPanel';
import { openDiffForWorkingChange } from './diff/openDiff';
import { GGitShowContentProvider, GGIT_SHOW_SCHEME } from './diff/showContentProvider';
import {
	applyStash,
	deleteLocalBranch,
	fetchWithPicker,
	pullWithPicker,
	pushCurrentBranch,
	rebaseCurrentBranch,
	renameLocalBranch,
	syncCurrentBranch,
} from './git/gitActions';
import { GitService } from './git/gitService';
import { BranchInfo, WorkingChangeFile } from './git/types';
import { ActiveBranchDecorationProvider } from './tree/activeBranchDecoration';
import { BranchTreeNode } from './tree/branchTree';
import { BranchesTreeProvider } from './tree/branchesTreeProvider';
import { RemotesTreeProvider } from './tree/remotesTreeProvider';
import { WorkingChangeDecorationProvider } from './tree/workingChangeDecoration';
import { WorkingCopyTreeProvider } from './tree/workingCopyTreeProvider';

export function activate(context: vscode.ExtensionContext): void {
	const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
	if (!workspaceFolder) {
		console.log('GGit: no workspace folder open, nothing to activate.');
		return;
	}

	const gitService = new GitService(workspaceFolder.uri.fsPath);

	const branchesProvider = new BranchesTreeProvider(gitService, context.extensionUri);
	const remotesProvider = new RemotesTreeProvider(gitService);
	const workingCopyProvider = new WorkingCopyTreeProvider(gitService);

	const activeBranchDecorations = new ActiveBranchDecorationProvider(gitService);
	const workingChangeDecorations = new WorkingChangeDecorationProvider();

	const refreshAll = () => {
		branchesProvider.refresh();
		remotesProvider.refresh();
		workingCopyProvider.refresh();
		activeBranchDecorations.refresh();
		workingChangeDecorations.refresh();
	};

	const isLocalBranchDoubleClick = createDoubleClickGuard();
	const isRemoteBranchDoubleClick = createDoubleClickGuard();

	const workingCopyView = vscode.window.createTreeView('ggitWorkingCopy', {
		treeDataProvider: workingCopyProvider,
		canSelectMany: true,
	});
	workingCopyView.onDidChangeCheckboxState(async e => {
		for (const [file, state] of e.items) {
			try {
				if (state === vscode.TreeItemCheckboxState.Checked) {
					await gitService.stageFile(file.path);
				} else {
					await gitService.unstageFile(file.path);
				}
			} catch (err) {
				vscode.window.showErrorMessage(`GGit: ${(err as Error).message}`);
			}
		}
		refreshAll();
	});

	context.subscriptions.push(
		workingCopyView,
		vscode.window.createTreeView('ggitBranches', { treeDataProvider: branchesProvider }),
		vscode.window.createTreeView('ggitRemotes', { treeDataProvider: remotesProvider }),
		vscode.workspace.registerTextDocumentContentProvider(GGIT_SHOW_SCHEME, new GGitShowContentProvider(gitService)),
		vscode.window.registerFileDecorationProvider(activeBranchDecorations),
		vscode.window.registerFileDecorationProvider(workingChangeDecorations),

		vscode.commands.registerCommand('ggit.openBranchHistory', (branchName: string) => {
			BranchHistoryPanel.createOrShow(context, gitService, branchName);
		}),

		vscode.commands.registerCommand('ggit.branchClicked', (branchName: string) => {
			BranchHistoryPanel.createOrShow(context, gitService, branchName);
			if (isLocalBranchDoubleClick(branchName)) {
				void runGitOperation(`Switching to ${branchName}…`, () => gitService.checkoutBranch(branchName), refreshAll);
			}
		}),

		vscode.commands.registerCommand('ggit.remoteBranchClicked', (remoteBranchName: string) => {
			if (isRemoteBranchDoubleClick(remoteBranchName)) {
				void runGitOperation(
					`Checking out ${remoteBranchName}…`,
					() => gitService.checkoutRemoteBranch(remoteBranchName),
					refreshAll
				);
			}
		}),

		vscode.commands.registerCommand('ggit.refresh', () => {
			refreshAll();
		}),

		vscode.commands.registerCommand('ggit.createBranch', () => {
			CreateBranchPanel.createOrShow(context, gitService, refreshAll);
		}),

		vscode.commands.registerCommand('ggit.fetch', () =>
			runGitOperation('Fetching…', () => fetchWithPicker(gitService), refreshAll)
		),

		vscode.commands.registerCommand('ggit.pull', () =>
			runGitOperation('Pulling…', () => pullWithPicker(gitService), refreshAll)
		),

		vscode.commands.registerCommand('ggit.push', () =>
			runGitOperation('Pushing…', () => pushCurrentBranch(gitService), refreshAll)
		),

		vscode.commands.registerCommand('ggit.sync', () =>
			runGitOperation('Syncing…', () => syncCurrentBranch(gitService), refreshAll)
		),

		vscode.commands.registerCommand('ggit.rebase', () => rebaseCurrentBranch()),

		vscode.commands.registerCommand('ggit.openWorkingChangeDiff', async (file: WorkingChangeFile) => {
			try {
				await openDiffForWorkingChange(gitService, file);
			} catch (err) {
				vscode.window.showErrorMessage(`Failed to open diff: ${(err as Error).message}`);
			}
		}),

		vscode.commands.registerCommand('ggit.stageAll', () =>
			runGitOperation('Staging all changes…', () => gitService.stageAll(), refreshAll)
		),

		vscode.commands.registerCommand('ggit.unstageAll', () =>
			runGitOperation('Unstaging all changes…', () => gitService.unstageAll(), refreshAll)
		),

		vscode.commands.registerCommand('ggit.stashAll', () =>
			runGitOperation('Stashing all changes…', () => gitService.stashAll(), refreshAll)
		),

		vscode.commands.registerCommand('ggit.applyStash', () => applyStash()),

		// The context-menu convention for a multi-select tree: when the right-clicked row is part of
		// the current selection, VS Code passes the full selection as the 2nd argument; otherwise
		// (right-clicking a row outside the selection) it's undefined and we just act on that one row.
		vscode.commands.registerCommand(
			'ggit.stashSelectedFiles',
			(file: WorkingChangeFile, selectedFiles?: WorkingChangeFile[]) => {
				const files = selectedFiles && selectedFiles.length > 0 ? selectedFiles : [file];
				return runGitOperation(
					`Stashing ${files.length} file${files.length === 1 ? '' : 's'}…`,
					() => gitService.stashPaths(files.map(f => f.path)),
					refreshAll
				);
			}
		),

		vscode.commands.registerCommand('ggit.openWorkingChangeFile', async (file: WorkingChangeFile) => {
			try {
				const uri = vscode.Uri.file(path.join(gitService.repoRoot, file.path));
				await vscode.commands.executeCommand('vscode.open', uri);
			} catch (err) {
				vscode.window.showErrorMessage(`Failed to open file: ${(err as Error).message}`);
			}
		}),

		vscode.commands.registerCommand(
			'ggit.discardChanges',
			async (file: WorkingChangeFile, selectedFiles?: WorkingChangeFile[]) => {
				// New/untracked files have nothing to revert to — discarding them is a no-op even if
				// one slips through (e.g. as part of a mixed multi-select), matching the "discarding
				// local changes on new files does nothing" behavior asked for.
				const files = (selectedFiles && selectedFiles.length > 0 ? selectedFiles : [file]).filter(
					f => f.status !== 'A' && f.status !== '?'
				);
				if (files.length === 0) {
					return;
				}

				const label =
					files.length === 1 ? files[0].path.split('/').pop() : `${files.length} files`;
				const confirmed = await vscode.window.showWarningMessage(
					`Discard changes in ${label}? This is irreversible.`,
					{ modal: true },
					'Discard Changes'
				);
				if (confirmed !== 'Discard Changes') {
					return;
				}

				await runGitOperation(
					`Discarding changes in ${files.length} file${files.length === 1 ? '' : 's'}…`,
					async () => {
						for (const f of files) {
							await gitService.discardChanges(f.path);
						}
					},
					refreshAll
				);
			}
		),

		vscode.commands.registerCommand('ggit.createBranchFrom', (node: BranchTreeNode<BranchInfo>) => {
			if (node.kind === 'leaf') {
				CreateBranchPanel.createOrShow(context, gitService, refreshAll, node.item.name);
			}
		}),

		vscode.commands.registerCommand('ggit.deleteLocalBranch', (node: BranchTreeNode<BranchInfo>) => {
			if (node.kind !== 'leaf') {
				return;
			}
			return runGitOperation(
				`Deleting ${node.item.name}…`,
				() => deleteLocalBranch(gitService, node.item.name),
				refreshAll
			);
		}),

		vscode.commands.registerCommand('ggit.renameLocalBranch', (node: BranchTreeNode<BranchInfo>) => {
			if (node.kind !== 'leaf') {
				return;
			}
			return runGitOperation(
				`Renaming ${node.item.name}…`,
				() => renameLocalBranch(gitService, node.item.name),
				refreshAll
			);
		}),

		vscode.commands.registerCommand('ggit.copyBranchName', async (node: BranchTreeNode<BranchInfo>) => {
			if (node.kind === 'leaf') {
				await vscode.env.clipboard.writeText(node.item.name);
			}
		})
	);

	// Keep the trees (and any open history tab) in sync with out-of-band changes, e.g. a branch checkout
	// or fetch run from the integrated terminal. Note this only catches staging changes (.git/index) —
	// edits to tracked working-tree files don't touch anything under .git, so the Working Copy list only
	// picks those up on an explicit Refresh for now.
	const gitDirWatcher = vscode.workspace.createFileSystemWatcher(
		new vscode.RelativePattern(vscode.Uri.joinPath(workspaceFolder.uri, '.git'), '{HEAD,refs/**,packed-refs,index}')
	);
	let debounceTimer: ReturnType<typeof setTimeout> | undefined;
	const onGitDirChange = () => {
		clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			refreshAll();
			BranchHistoryPanel.refreshIfOpen();
		}, 300);
	};
	gitDirWatcher.onDidChange(onGitDirChange);
	gitDirWatcher.onDidCreate(onGitDirChange);
	gitDirWatcher.onDidDelete(onGitDirChange);
	context.subscriptions.push(gitDirWatcher);
}

/** Tree items don't have a native double-click event, so we detect one ourselves: two clicks on the
 * same key within the threshold. Returns whether *this* click completed a double-click. */
function createDoubleClickGuard(thresholdMs = 400): (key: string) => boolean {
	let lastKey: string | undefined;
	let lastTime = 0;
	return (key: string) => {
		const now = Date.now();
		const isDouble = lastKey === key && now - lastTime < thresholdMs;
		lastKey = isDouble ? undefined : key;
		lastTime = now;
		return isDouble;
	};
}

async function runGitOperation(title: string, op: () => Promise<void>, onSuccess: () => void): Promise<void> {
	try {
		await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, op);
		onSuccess();
		BranchHistoryPanel.refreshIfOpen();
	} catch (err) {
		vscode.window.showErrorMessage(`GGit: ${(err as Error).message}`);
	}
}

export function deactivate(): void {}
