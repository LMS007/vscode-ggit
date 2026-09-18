import * as vscode from 'vscode';
import { BranchHistoryPanel } from './history/branchHistoryPanel';
import { GgitShowContentProvider, GGIT_SHOW_SCHEME } from './diff/showContentProvider';
import { GitService } from './git/gitService';
import { BranchesTreeProvider } from './tree/branchesTreeProvider';
import { RemotesTreeProvider } from './tree/remotesTreeProvider';

export function activate(context: vscode.ExtensionContext): void {
	const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
	if (!workspaceFolder) {
		console.log('Ggit: no workspace folder open, nothing to activate.');
		return;
	}

	const gitService = new GitService(workspaceFolder.uri.fsPath);

	const branchesProvider = new BranchesTreeProvider(gitService);
	const remotesProvider = new RemotesTreeProvider(gitService);

	const refreshAll = () => {
		branchesProvider.refresh();
		remotesProvider.refresh();
	};

	context.subscriptions.push(
		vscode.window.createTreeView('ggitBranches', { treeDataProvider: branchesProvider }),
		vscode.window.createTreeView('ggitRemotes', { treeDataProvider: remotesProvider }),
		vscode.workspace.registerTextDocumentContentProvider(GGIT_SHOW_SCHEME, new GgitShowContentProvider(gitService)),

		vscode.commands.registerCommand('ggit.openBranchHistory', (branchName: string) => {
			BranchHistoryPanel.createOrShow(context, gitService, branchName);
		}),

		vscode.commands.registerCommand('ggit.refresh', () => {
			refreshAll();
		}),

		vscode.commands.registerCommand('ggit.fetch', () =>
			runGitOperation('Fetching from origin…', () => gitService.fetch(), refreshAll)
		),

		vscode.commands.registerCommand('ggit.pull', () =>
			runGitOperation('Pulling from origin…', () => gitService.pull(), refreshAll)
		)
	);

	// Keep the trees (and any open history tab) in sync with out-of-band changes,
	// e.g. a branch checkout or fetch run from the integrated terminal.
	const gitDirWatcher = vscode.workspace.createFileSystemWatcher(
		new vscode.RelativePattern(vscode.Uri.joinPath(workspaceFolder.uri, '.git'), '{HEAD,refs/**,packed-refs}')
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

async function runGitOperation(title: string, op: () => Promise<void>, onSuccess: () => void): Promise<void> {
	try {
		await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, op);
		onSuccess();
		BranchHistoryPanel.refreshIfOpen();
	} catch (err) {
		vscode.window.showErrorMessage(`Ggit: ${(err as Error).message}`);
	}
}

export function deactivate(): void {}
