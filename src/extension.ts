import * as path from 'path';
import * as vscode from 'vscode';
import { CreateBranchPanel } from './branch/createBranchPanel';
import { BranchHistoryPanel } from './history/branchHistoryPanel';
import { CommitFilesPanel } from './history/commitFilesPanel';
import { openDiffForWorkingChange } from './diff/openDiff';
import { GGitShowContentProvider, GGIT_SHOW_SCHEME } from './diff/showContentProvider';
import {
	applyStashWithPicker,
	deleteLocalBranch,
	discardWorkingChanges,
	fetchWithPicker,
	pullWithPicker,
	pushCurrentBranch,
	rebaseCurrentBranch,
	renameLocalBranch,
	stashAllWithMessage,
	stashPathsWithMessage,
	syncCurrentBranch,
} from './git/gitActions';
import { GitService } from './git/gitService';
import { BranchInfo, StashInfo, WorkingChangeFile } from './git/types';
import { ActiveBranchDecorationProvider } from './tree/activeBranchDecoration';
import { BranchTreeNode } from './tree/branchTree';
import { BranchesTreeProvider } from './tree/branchesTreeProvider';
import { RemotesTreeProvider } from './tree/remotesTreeProvider';
import { StashesTreeProvider } from './tree/stashesTreeProvider';
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
	const stashesProvider = new StashesTreeProvider(gitService);

	const activeBranchDecorations = new ActiveBranchDecorationProvider(gitService);
	const workingChangeDecorations = new WorkingChangeDecorationProvider();

	const workingCopyView = vscode.window.createTreeView('ggitWorkingCopy', {
		treeDataProvider: workingCopyProvider,
		canSelectMany: true,
	});

	// Mirrors the built-in Source Control icon's badge — VS Code aggregates a view's `badge` up onto
	// its container's activity-bar icon automatically, so setting this on just the Working Copy view
	// is enough to badge the whole "GGit" icon.
	const updateWorkingCopyBadge = async () => {
		const files = await gitService.getWorkingChanges();
		workingCopyView.badge =
			files.length > 0 ? { value: files.length, tooltip: `${files.length} changed file${files.length === 1 ? '' : 's'}` } : undefined;
	};

	const refreshAll = () => {
		branchesProvider.refresh();
		remotesProvider.refresh();
		workingCopyProvider.refresh();
		stashesProvider.refresh();
		activeBranchDecorations.refresh();
		workingChangeDecorations.refresh();
		void updateWorkingCopyBadge();
	};

	const isLocalBranchDoubleClick = createDoubleClickGuard();
	const isRemoteBranchDoubleClick = createDoubleClickGuard();

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
	void updateWorkingCopyBadge();

	context.subscriptions.push(
		workingCopyView,
		vscode.window.createTreeView('ggitBranches', { treeDataProvider: branchesProvider }),
		vscode.window.createTreeView('ggitRemotes', { treeDataProvider: remotesProvider }),
		// Multi-select is for bulk delete only — Apply always acts on just the row you right-clicked,
		// ignoring the rest of the selection (see ggit.applyStashItem below).
		vscode.window.createTreeView('ggitStashes', { treeDataProvider: stashesProvider, canSelectMany: true }),
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
			runGitOperation('Stashing all changes…', () => stashAllWithMessage(gitService), refreshAll)
		),

		vscode.commands.registerCommand('ggit.applyStash', () =>
			runGitOperation('Applying stash…', () => applyStashWithPicker(gitService), refreshAll)
		),

		// The context-menu convention for a multi-select tree: when the right-clicked row is part of
		// the current selection, VS Code passes the full selection as the 2nd argument; otherwise
		// (right-clicking a row outside the selection) it's undefined and we just act on that one row.
		vscode.commands.registerCommand(
			'ggit.stashSelectedFiles',
			(file: WorkingChangeFile, selectedFiles?: WorkingChangeFile[]) => {
				const files = selectedFiles && selectedFiles.length > 0 ? selectedFiles : [file];
				return runGitOperation(
					`Stashing ${files.length} file${files.length === 1 ? '' : 's'}…`,
					() => stashPathsWithMessage(gitService, files.map(f => f.path)),
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
			(file: WorkingChangeFile, selectedFiles?: WorkingChangeFile[]) => {
				const files = selectedFiles && selectedFiles.length > 0 ? selectedFiles : [file];
				return runGitOperation(
					`Discarding ${files.length} file${files.length === 1 ? '' : 's'}…`,
					() => discardWorkingChanges(gitService, files),
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
		}),

		vscode.commands.registerCommand('ggit.stashClicked', async (stash: StashInfo) => {
			try {
				const files = await gitService.getStashFiles(stash.hash);
				CommitFilesPanel.showForCommit(context, gitService, stash.hash, stash.message, files, -1);
			} catch (err) {
				vscode.window.showErrorMessage(`GGit: ${(err as Error).message}`);
			}
		}),

		// Deliberately ignores any multi-selection — Apply only ever makes sense for one stash at a
		// time, so this always acts on just the row that was actually right-clicked.
		vscode.commands.registerCommand('ggit.applyStashItem', (stash: StashInfo) =>
			runGitOperation(`Applying ${stash.ref}…`, () => gitService.applyStash(stash.ref), refreshAll)
		),

		vscode.commands.registerCommand('ggit.deleteStash', async (stash: StashInfo, selectedStashes?: StashInfo[]) => {
			const stashes = selectedStashes && selectedStashes.length > 0 ? selectedStashes : [stash];
			const label = stashes.length === 1 ? stashes[0].ref : `${stashes.length} stashes`;
			const confirmed = await vscode.window.showWarningMessage(
				`Delete ${label}? This is irreversible.`,
				{ modal: true },
				'Delete Stash'
			);
			if (confirmed !== 'Delete Stash') {
				return;
			}
			// Dropping a stash shifts every *older* stash's index down by one, which would invalidate
			// the rest of this batch's stash@{N} refs if we deleted newest-first — oldest-first avoids
			// that, since removing an older entry never renumbers the newer ones still queued up.
			const parseIndex = (ref: string) => Number(ref.match(/\{(\d+)\}/)?.[1] ?? 0);
			const oldestFirst = [...stashes].sort((a, b) => parseIndex(b.ref) - parseIndex(a.ref));
			return runGitOperation(
				`Deleting ${stashes.length} stash${stashes.length === 1 ? '' : 'es'}…`,
				async () => {
					for (const s of oldestFirst) {
						await gitService.dropStash(s.ref);
					}
				},
				refreshAll
			);
		})
	);

	// Keep the trees (and any open history tab) in sync with out-of-band changes, e.g. a branch checkout
	// or fetch run from the integrated terminal.
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

	// Editing or deleting a tracked file never touches anything under .git, so the watcher above
	// can't see it — this is what actually keeps Working Copy's status/badges in sync with a plain
	// Cmd+S or an Explorer delete. getWorkspaceFolder (rather than a manual fsPath.startsWith check)
	// is what VS Code itself uses to answer "is this URI inside a workspace folder", so it's immune
	// to the trailing-slash/symlink mismatches a string-prefix check can silently get wrong.
	const refreshWorkingCopy = () => {
		workingCopyProvider.refresh();
		workingChangeDecorations.refresh();
		void updateWorkingCopyBadge();
	};
	context.subscriptions.push(
		vscode.workspace.onDidSaveTextDocument(doc => {
			if (vscode.workspace.getWorkspaceFolder(doc.uri)) {
				refreshWorkingCopy();
			}
		}),
		vscode.workspace.onDidDeleteFiles(e => {
			if (e.files.some(uri => vscode.workspace.getWorkspaceFolder(uri))) {
				refreshWorkingCopy();
			}
		})
	);
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
