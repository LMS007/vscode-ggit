import * as path from 'path';
import * as vscode from 'vscode';
import { CreateBranchPanel } from './branch/createBranchPanel';
import { CommitLauncherViewProvider } from './commit/commitLauncherView';
import { CommitPanel } from './commit/commitPanel';
import { BranchHistoryPanel } from './history/branchHistoryPanel';
import { CommitFilesPanel } from './history/commitFilesPanel';
import { AddRemotePanel } from './remote/addRemotePanel';
import { openDiffForWorkingChange } from './diff/openDiff';
import { GGitShowContentProvider, GGIT_SHOW_SCHEME } from './diff/showContentProvider';
import {
	addPathsToGitignore,
	applyStashWithPicker,
	deleteLocalBranch,
	discardWorkingChanges,
	fetchCurrentBranch,
	pullCurrentBranch,
	pushCurrentBranch,
	rebaseCurrentBranchWithPicker,
	renameLocalBranch,
	stageHunkAtCursor,
	stashAllWithMessage,
	stashPathsWithMessage,
	syncCurrentBranch,
	unstageHunkAtCursor,
} from './git/gitActions';
import { GitService } from './git/gitService';
import { BranchInfo, ConflictedFile, StashInfo, WorkingChangeFile } from './git/types';
import { ActiveBranchDecorationProvider } from './tree/activeBranchDecoration';
import { BranchTreeNode } from './tree/branchTree';
import { BranchesTreeProvider } from './tree/branchesTreeProvider';
import { ConflictsTreeProvider } from './tree/conflictsTreeProvider';
import { RemotesTreeProvider } from './tree/remotesTreeProvider';
import { StashesTreeProvider } from './tree/stashesTreeProvider';
import { WorkingChangeDecorationProvider } from './tree/workingChangeDecoration';
import { isCreateCommitNode, isWorkingChangeFile, WorkingCopyTreeProvider } from './tree/workingCopyTreeProvider';

export function activate(context: vscode.ExtensionContext): void {
	const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
	if (!workspaceFolder) {
		console.log('GGit: no workspace folder open, nothing to activate.');
		return;
	}

	// View > Output > "GGit" — mainly for diagnosing the odd git-command failures that only show up
	// against real, large, long-lived repos (e.g. branches whose upstream is in some inconsistent
	// state) rather than the clean throwaway repos used to test this stuff in isolation.
	const output = vscode.window.createOutputChannel('GGit');
	context.subscriptions.push(output);
	output.appendLine(`GGit: activated at ${new Date().toISOString()}, repoRoot=${workspaceFolder.uri.fsPath}`);

	const gitService = new GitService(workspaceFolder.uri.fsPath, message => output.appendLine(message));

	const branchesProvider = new BranchesTreeProvider(gitService, context.extensionUri);
	const remotesProvider = new RemotesTreeProvider(gitService);
	const workingCopyProvider = new WorkingCopyTreeProvider(gitService);
	const stashesProvider = new StashesTreeProvider(gitService);
	const conflictsProvider = new ConflictsTreeProvider(gitService);
	const commitLauncherProvider = new CommitLauncherViewProvider(gitService, () =>
		vscode.commands.executeCommand('ggit.commit')
	);

	const activeBranchDecorations = new ActiveBranchDecorationProvider();
	const workingChangeDecorations = new WorkingChangeDecorationProvider();
	const showContentProvider = new GGitShowContentProvider(gitService);

	const workingCopyView = vscode.window.createTreeView('ggitWorkingCopy', {
		treeDataProvider: workingCopyProvider,
		canSelectMany: true,
	});

	const branchesView = vscode.window.createTreeView('ggitBranches', { treeDataProvider: branchesProvider });
	// The workspace folder name, mirroring how Working Copy's description shows the active branch —
	// static for now since GGit only ever looks at a single workspace folder (see the worktree
	// discussion: there's no "switch worktree" yet, so this never needs to change mid-session).
	branchesView.description = workspaceFolder.name;

	const remotesView = vscode.window.createTreeView('ggitRemotes', { treeDataProvider: remotesProvider });
	// See branchesView above -- description here gets temporarily overridden by the search-filter
	// status instead (see ggit.searchRemotes below), which falls back to this same folder name once
	// the filter's cleared.
	remotesView.description = workspaceFolder.name;

	// Multi-select is for bulk delete only — Apply always acts on just the row you right-clicked,
	// ignoring the rest of the selection (see ggit.applyStashItem below).
	const stashesView = vscode.window.createTreeView('ggitStashes', { treeDataProvider: stashesProvider, canSelectMany: true });
	stashesView.description = workspaceFolder.name;

	// Mirrors the built-in Source Control icon's badge — VS Code aggregates a view's `badge` up onto
	// its container's activity-bar icon automatically, so setting this on just the Working Copy view
	// is enough to badge the whole "GGit" icon.
	const updateWorkingCopyBadge = async () => {
		const files = await gitService.time('updateWorkingCopyBadge: getWorkingChanges', () => gitService.getWorkingChanges());
		// Distinct paths, not rows -- a partially-staged file produces two rows (see
		// GitService.getWorkingChanges) but is still only one changed file for this count.
		const count = new Set(files.map(f => f.path)).size;
		workingCopyView.badge = count > 0 ? { value: count, tooltip: `${count} changed file${count === 1 ? '' : 's'}` } : undefined;
	};

	// There's no public API to change the "GGit" text at the very top of the container itself — that
	// comes from the static viewsContainers title in package.json and can't be set at runtime. The
	// Working Copy view's own header is the closest thing to it (it's the topmost row, directly below
	// "GGit"), and TreeView.description is explicitly documented as safe to update dynamically, so the
	// repo folder name (what "GGit - <folder>" would've shown, if that were possible) and the active
	// branch both go there instead, folder first since that's the more stable/identifying of the two.
	const updateActiveBranchLabel = async () => {
		const current = await gitService.getCurrentBranch();
		workingCopyView.description = current ? `${workspaceFolder.name} · ${current}` : workspaceFolder.name;
	};

	// The Conflicts view only shows at all while a rebase is in progress (see its `when` clause in
	// package.json) — this is what flips that on/off, checked on every refresh so entering/leaving a
	// conflicted rebase state (via GGit's own actions or the integrated terminal) is picked up promptly.
	const updateRebaseContext = async () => {
		const inProgress = await gitService.isRebaseInProgress();
		void vscode.commands.executeCommand('setContext', 'ggit.rebaseInProgress', inProgress);
	};

	const refreshAll = () => {
		branchesProvider.refresh();
		remotesProvider.refresh();
		workingCopyProvider.refresh();
		stashesProvider.refresh();
		conflictsProvider.refresh();
		activeBranchDecorations.refresh();
		workingChangeDecorations.refresh();
		showContentProvider.refresh();
		void updateWorkingCopyBadge();
		void updateRebaseContext();
		void updateActiveBranchLabel();
		CommitPanel.refreshIfOpen();
		void commitLauncherProvider.refresh();
	};

	const isLocalBranchDoubleClick = createDoubleClickGuard();
	const isRemoteBranchDoubleClick = createDoubleClickGuard();

	workingCopyView.onDidChangeCheckboxState(async e => {
		for (const [node, state] of e.items) {
			const stateLabel = state === vscode.TreeItemCheckboxState.Checked ? 'Checked' : 'Unchecked';
			try {
				if (isCreateCommitNode(node)) {
					// The pinned row's checkbox is a check-all/uncheck-all for staging, not a
					// per-file toggle.
					output.appendLine(`checkbox: Create Commit row -> ${stateLabel}`);
					if (state === vscode.TreeItemCheckboxState.Checked) {
						await gitService.stageAll();
					} else {
						await gitService.unstageAll();
					}
				} else if (isWorkingChangeFile(node)) {
					output.appendLine(`checkbox: "${node.path}" (row was ${node.state}) -> ${stateLabel}`);
					if (state === vscode.TreeItemCheckboxState.Checked) {
						await gitService.stageFile(node.path);
					} else {
						await gitService.unstageFile(node.path);
					}
				}
			} catch (err) {
				output.appendLine(`checkbox: error -- ${(err as Error).message}`);
				vscode.window.showErrorMessage(`GGit: ${(err as Error).message}`);
			}
		}
		refreshAll();
	});
	void updateWorkingCopyBadge();
	void updateRebaseContext();
	void updateActiveBranchLabel();

	context.subscriptions.push(
		workingCopyView,
		branchesView,
		remotesView,
		vscode.window.createTreeView('ggitConflicts', { treeDataProvider: conflictsProvider, canSelectMany: true }),
		vscode.window.registerWebviewViewProvider('ggitCommitLauncher', commitLauncherProvider),
		stashesView,
		vscode.workspace.registerTextDocumentContentProvider(GGIT_SHOW_SCHEME, showContentProvider),
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

		// createInputBox (not the simpler showInputBox) specifically because onDidChangeValue fires on
		// every keystroke -- that's what makes the tree filter live as you type rather than only once
		// you submit. Pre-filled with whatever filter's already active, so reopening it to tweak a term
		// doesn't start you back at empty.
		vscode.commands.registerCommand('ggit.searchRemotes', () => {
			const inputBox = vscode.window.createInputBox();
			inputBox.placeholder = 'Filter remote branches by name…';
			inputBox.value = remotesProvider.filter;
			inputBox.onDidChangeValue(value => {
				remotesProvider.setFilter(value);
				const trimmed = value.trim();
				remotesView.description = trimmed ? `Filter: "${trimmed}"` : workspaceFolder.name;
			});
			inputBox.onDidHide(() => inputBox.dispose());
			inputBox.show();
		}),

		vscode.commands.registerCommand('ggit.addRemote', () => {
			AddRemotePanel.createOrShow(context, gitService, refreshAll);
		}),

		vscode.commands.registerCommand('ggit.createBranch', () => {
			CreateBranchPanel.createOrShow(context, gitService, refreshAll);
		}),

		// The optional `remote` arg on fetch/pull/push/sync is only ever supplied by the History tab's
		// own remote dropdown (see branchHistoryPanel.ts's 'runAction' handling) -- every other
		// trigger, like the Branches view's toolbar, calls these with no args and each falls back to
		// its own sensible default (see pickDefaultRemote/pickRemote in gitActions.ts).
		vscode.commands.registerCommand('ggit.fetch', (remote?: string) =>
			runGitOperation('Fetching…', () => fetchCurrentBranch(gitService, remote), refreshAll)
		),

		vscode.commands.registerCommand('ggit.pull', (remote?: string) =>
			runGitOperation('Pulling…', () => pullCurrentBranch(gitService, remote), refreshAll)
		),

		vscode.commands.registerCommand('ggit.push', (remote?: string) =>
			runGitOperation('Pushing…', () => pushCurrentBranch(gitService, remote), refreshAll)
		),

		vscode.commands.registerCommand('ggit.sync', (remote?: string) =>
			runGitOperation('Syncing…', () => syncCurrentBranch(gitService, remote), refreshAll)
		),

		vscode.commands.registerCommand('ggit.rebase', () =>
			runGitOperation('Rebasing…', () => rebaseCurrentBranchWithPicker(gitService), refreshAll)
		),

		vscode.commands.registerCommand('ggit.rebaseContinue', () =>
			runGitOperation('Continuing rebase…', () => gitService.rebaseContinue(), refreshAll)
		),

		vscode.commands.registerCommand('ggit.rebaseSkip', () =>
			runGitOperation('Skipping commit…', () => gitService.rebaseSkip(), refreshAll)
		),

		vscode.commands.registerCommand('ggit.rebaseAbort', async () => {
			const confirmed = await vscode.window.showWarningMessage(
				'Abort the rebase in progress? This restores the branch to its state before the rebase started.',
				{ modal: true },
				'Abort Rebase'
			);
			if (confirmed !== 'Abort Rebase') {
				return;
			}
			return runGitOperation('Aborting rebase…', () => gitService.rebaseAbort(), refreshAll);
		}),

		// Once a conflicted file's markers are resolved by hand, it still needs to be staged before
		// `rebase --continue` will treat it as done — this is that, applied to the whole selection when
		// one was right-clicked (same convention as ggit.discardChanges / ggit.stashSelectedFiles).
		vscode.commands.registerCommand(
			'ggit.markConflictResolved',
			(file: ConflictedFile, selectedFiles?: ConflictedFile[]) => {
				const files = selectedFiles && selectedFiles.length > 0 ? selectedFiles : [file];
				return runGitOperation(
					`Marking ${files.length} file${files.length === 1 ? '' : 's'} as resolved…`,
					async () => {
						for (const f of files) {
							await gitService.stageFile(f.path);
						}
					},
					refreshAll
				);
			}
		),

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

		// Not routed through runGitOperation -- a hunk stage/unstage is effectively instant, so a
		// progress notification would just flash uselessly. Logged directly instead, since this is
		// the fiddliest bit of git plumbing in the extension and worth being able to see exactly what
		// happened (see GitService.stageHunkAtLine/unstageHunkAtLine for the "why" on both commands).
		vscode.commands.registerCommand('ggit.stageHunkAtCursor', async () => {
			console.log('[GGit] ggit.stageHunkAtCursor invoked');
			try {
				await stageHunkAtCursor(gitService);
				output.appendLine('ggit.stageHunkAtCursor: succeeded');
				refreshAll();
			} catch (err) {
				output.appendLine(`ggit.stageHunkAtCursor: error -- ${(err as Error).message}`);
				vscode.window.showErrorMessage(`GGit: ${(err as Error).message}`);
			}
		}),

		vscode.commands.registerCommand('ggit.unstageHunkAtCursor', async () => {
			console.log('[GGit] ggit.unstageHunkAtCursor invoked');
			try {
				await unstageHunkAtCursor(gitService);
				output.appendLine('ggit.unstageHunkAtCursor: succeeded');
				refreshAll();
			} catch (err) {
				output.appendLine(`ggit.unstageHunkAtCursor: error -- ${(err as Error).message}`);
				vscode.window.showErrorMessage(`GGit: ${(err as Error).message}`);
			}
		}),

		vscode.commands.registerCommand('ggit.commit', () => {
			CommitPanel.createOrShow(context, gitService, refreshAll, async () => {
				const branch = await gitService.getCurrentBranch();
				if (branch) {
					BranchHistoryPanel.createOrShow(context, gitService, branch);
				}
			});
		}),

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
				// selectedFiles can include the pinned Create Commit row when it's part of a multi-select
				// that also includes the right-clicked file — filtered out since it isn't a real file.
				const files =
					selectedFiles && selectedFiles.length > 0 ? selectedFiles.filter(isWorkingChangeFile) : [file];
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
				const files =
					selectedFiles && selectedFiles.length > 0 ? selectedFiles.filter(isWorkingChangeFile) : [file];
				return runGitOperation(
					`Discarding ${files.length} file${files.length === 1 ? '' : 's'}…`,
					() => discardWorkingChanges(gitService, files),
					refreshAll
				);
			}
		),

		// Three granularities, mirroring Tower's own "Ignore" submenu: the exact path, the bare
		// filename (a gitignore pattern with no "/" matches that name at any depth, not just here), or
		// the extension (a "*.ext" pattern, also unanchored).
		vscode.commands.registerCommand(
			'ggit.ignoreThisItem',
			async (file: WorkingChangeFile, selectedFiles?: WorkingChangeFile[]) => {
				const files =
					selectedFiles && selectedFiles.length > 0 ? selectedFiles.filter(isWorkingChangeFile) : [file];
				try {
					await addPathsToGitignore(gitService, files.map(f => f.path));
					refreshAll();
				} catch (err) {
					vscode.window.showErrorMessage(`GGit: ${(err as Error).message}`);
				}
			}
		),

		vscode.commands.registerCommand(
			'ggit.ignoreByName',
			async (file: WorkingChangeFile, selectedFiles?: WorkingChangeFile[]) => {
				const files =
					selectedFiles && selectedFiles.length > 0 ? selectedFiles.filter(isWorkingChangeFile) : [file];
				try {
					await addPathsToGitignore(gitService, files.map(f => path.basename(f.path)));
					refreshAll();
				} catch (err) {
					vscode.window.showErrorMessage(`GGit: ${(err as Error).message}`);
				}
			}
		),

		vscode.commands.registerCommand(
			'ggit.ignoreByType',
			async (file: WorkingChangeFile, selectedFiles?: WorkingChangeFile[]) => {
				const files =
					selectedFiles && selectedFiles.length > 0 ? selectedFiles.filter(isWorkingChangeFile) : [file];
				const patterns = new Set<string>();
				let anyWithoutExtension = false;
				for (const f of files) {
					const ext = path.extname(f.path);
					if (ext) {
						patterns.add(`*${ext}`);
					} else {
						anyWithoutExtension = true;
					}
				}
				if (patterns.size === 0) {
					// Never fall through to an empty pattern set -- that would silently no-op addPathsToGitignore,
					// but a blind "*" (extname of a file with no dot) would instead ignore the entire repo.
					void vscode.window.showInformationMessage(
						`GGit: ${files.length === 1 ? 'This file has' : 'None of these files have'} an extension to ignore by type.`
					);
					return;
				}
				if (anyWithoutExtension) {
					void vscode.window.showInformationMessage('GGit: Skipped one or more files with no extension.');
				}
				try {
					await addPathsToGitignore(gitService, [...patterns]);
					refreshAll();
				} catch (err) {
					vscode.window.showErrorMessage(`GGit: ${(err as Error).message}`);
				}
			}
		),

		// Relative to the repo root (== this extension's one workspace folder, see the top of
		// activate()) with OS-native separators -- file.path itself is always "/"-separated (that's
		// what git prints), which would be a lie to paste into a Windows path field as-is.
		vscode.commands.registerCommand('ggit.copyRelativePath', (file: WorkingChangeFile) => {
			void vscode.env.clipboard.writeText(file.path.split('/').join(path.sep));
		}),

		vscode.commands.registerCommand('ggit.copyPath', (file: WorkingChangeFile) => {
			void vscode.env.clipboard.writeText(path.join(gitService.repoRoot, file.path));
		}),

		vscode.commands.registerCommand('ggit.revealInExplorerView', (file: WorkingChangeFile) => {
			const uri = vscode.Uri.file(path.join(gitService.repoRoot, file.path));
			void vscode.commands.executeCommand('revealInExplorer', uri);
		}),

		// Three commands, not one, purely so each can carry the OS-appropriate label VS Code's own
		// Explorer uses ("Reveal in Finder" / "Reveal in File Explorer" / "Open Containing Folder") --
		// package.json menu titles are static, so the isMac/isWindows/isLinux `when` clauses on these
		// three (see package.json) are what actually pick the one that shows up on a given OS.
		vscode.commands.registerCommand('ggit.revealInOS', (file: WorkingChangeFile) => {
			const uri = vscode.Uri.file(path.join(gitService.repoRoot, file.path));
			void vscode.commands.executeCommand('revealFileInOS', uri);
		}),

		vscode.commands.registerCommand('ggit.revealInFileExplorer', (file: WorkingChangeFile) => {
			const uri = vscode.Uri.file(path.join(gitService.repoRoot, file.path));
			void vscode.commands.executeCommand('revealFileInOS', uri);
		}),

		vscode.commands.registerCommand('ggit.openContainingFolder', (file: WorkingChangeFile) => {
			const uri = vscode.Uri.file(path.join(gitService.repoRoot, file.path));
			void vscode.commands.executeCommand('revealFileInOS', uri);
		}),

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
		new vscode.RelativePattern(
			vscode.Uri.joinPath(workspaceFolder.uri, '.git'),
			// rebase-merge/rebase-apply are the directories git creates for the duration of an
			// in-progress rebase (conflicted or not) — watching them is what lets the Conflicts view
			// and its `ggit.rebaseInProgress` context key react promptly to a rebase starting, pausing
			// on a conflict, or finishing/aborting, including one driven from the integrated terminal.
			// worktrees/** is git's per-linked-worktree admin dir — a subdirectory appears/disappears
			// on `git worktree add`/`remove`, and each one's own HEAD file changes when that worktree
			// switches branches, which is exactly the state Branches' blue/"checked out elsewhere"
			// styling depends on. This only sees other worktrees because GGit's own workspace folder is
			// always the *main* checkout today (no worktree-switching UI yet) — its .git is the real,
			// shared git dir, not a per-worktree pointer file. If GGit ever opens from inside a linked
			// worktree instead, this would need to watch the resolved git-common-dir rather than a
			// hardcoded ".git" under the workspace folder.
			'{HEAD,refs/**,packed-refs,index,rebase-merge/**,rebase-apply/**,worktrees/**}'
		)
	);
	let debounceTimer: ReturnType<typeof setTimeout> | undefined;
	// Logged unconditionally (not just on a cache-miss) so a silent watcher -- e.g. `files.watcherExclude`
	// quietly excluding `.git` in a config tuned for a huge repo -- shows up as "GGit: activated" in the
	// output followed by nothing, rather than looking identical to a working one that just wasn't
	// triggered during a given session.
	const onGitDirChange = (uri: vscode.Uri) => {
		output.appendLine(`gitDirWatcher fired: ${uri.fsPath}`);
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
	const refreshWorkingCopy = (reason: string) => {
		output.appendLine(`refreshWorkingCopy: ${reason}`);
		workingCopyProvider.refresh();
		workingChangeDecorations.refresh();
		void updateWorkingCopyBadge();
	};
	context.subscriptions.push(
		vscode.workspace.onDidSaveTextDocument(doc => {
			if (vscode.workspace.getWorkspaceFolder(doc.uri)) {
				refreshWorkingCopy(`saved ${doc.uri.fsPath}`);
			}
		}),
		vscode.workspace.onDidDeleteFiles(e => {
			if (e.files.some(uri => vscode.workspace.getWorkspaceFolder(uri))) {
				refreshWorkingCopy(`deleted ${e.files.map(f => f.fsPath).join(', ')}`);
			}
		})
	);

	// The above two only catch changes made *through VS Code's own editor/Explorer* -- confirmed via
	// a live test against this exact repo that a file written by an external tool (not a VS Code save)
	// is invisible to both of them and to the .git-dir watcher, so Working Copy silently goes stale
	// while the built-in Git extension (which has its own broader watch) keeps up fine. This recursive
	// watcher is what closes that gap. It's the kind of watcher VS Code's own docs caution against
	// using carelessly on a large repo -- but the built-in Git extension clearly needs (and does)
	// exactly this to work at all, so the answer is to scope and debounce it, not avoid it entirely:
	// `files.watcherExclude`'s defaults (.git/objects/**, etc.) plus whatever a repo/user already
	// excludes (node_modules, build output, ...) apply here the same as for any other extension's
	// recursive watcher, and this only ever triggers the cheap `git status`-based refresh above, never
	// the full branches/remotes/stashes refreshAll.
	const workingTreeWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(workspaceFolder, '**/*'));
	let workingTreeDebounce: ReturnType<typeof setTimeout> | undefined;
	const onWorkingTreeChange = (uri: vscode.Uri) => {
		if (uri.fsPath.includes(`${path.sep}.git${path.sep}`) || uri.fsPath.endsWith(`${path.sep}.git`)) {
			// Already covered by gitDirWatcher above -- skip to avoid double-refreshing on every commit/checkout.
			return;
		}
		output.appendLine(`workingTreeWatcher fired: ${uri.fsPath}`);
		clearTimeout(workingTreeDebounce);
		workingTreeDebounce = setTimeout(() => refreshWorkingCopy(`external change: ${uri.fsPath}`), 500);
	};
	workingTreeWatcher.onDidChange(onWorkingTreeChange);
	workingTreeWatcher.onDidCreate(onWorkingTreeChange);
	workingTreeWatcher.onDidDelete(onWorkingTreeChange);
	context.subscriptions.push(workingTreeWatcher);
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
