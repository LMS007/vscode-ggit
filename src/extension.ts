import * as path from 'path';
import * as vscode from 'vscode';
import { CreateBranchPanel } from './branch/createBranchPanel';
import { CommitLauncherViewProvider } from './commit/commitLauncherView';
import { CommitPanel } from './commit/commitPanel';
import { BranchHistoryPanel } from './history/branchHistoryPanel';
import { CommitFilesPanel } from './history/commitFilesPanel';
import { AddRemotePanel } from './remote/addRemotePanel';
import { ConflictOperation } from './conflicts/conflictsProtocol';
import { ConflictsPanel } from './conflicts/conflictsPanel';
import { MergePanel } from './merge/mergePanel';
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
import { BranchInfo, StashInfo, WorkingChangeFile } from './git/types';
import { ActiveBranchDecorationProvider } from './tree/activeBranchDecoration';
import { BranchTreeNode } from './tree/branchTree';
import { BranchesDragAndDropController } from './tree/branchesDragAndDrop';
import { BranchesTreeProvider } from './tree/branchesTreeProvider';
import { ConflictsTreeProvider } from './tree/conflictsTreeProvider';
import { MAX_PINNED_BRANCH_COUNT, MIN_PINNED_BRANCH_COUNT, RecentBranches } from './tree/recentBranches';
import { RemotesTreeProvider } from './tree/remotesTreeProvider';
import { StashesTreeProvider } from './tree/stashesTreeProvider';
import { TagNode, TagsTreeProvider } from './tree/tagsTreeProvider';
import { CreateTagPanel } from './tag/createTagPanel';
import { TagPanel } from './tag/tagPanel';
import { TagDialogMode } from './tag/tagProtocol';
import { WorkingChangeDecorationProvider } from './tree/workingChangeDecoration';
import { isCreateCommitNode, isWorkingChangeFile, WorkingCopyNode, WorkingCopyTreeProvider } from './tree/workingCopyTreeProvider';

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

	const recentBranches = new RecentBranches(context.workspaceState);
	const branchesProvider = new BranchesTreeProvider(gitService, context.extensionUri, recentBranches);
	const remotesProvider = new RemotesTreeProvider(gitService);
	const workingCopyProvider = new WorkingCopyTreeProvider(gitService);
	const stashesProvider = new StashesTreeProvider(gitService);
	const tagsProvider = new TagsTreeProvider(gitService);
	const conflictsProvider = new ConflictsTreeProvider();
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
	// VS Code only shows a context-menu item when its `when` clause holds for *every* row in the
	// right-clicked selection, so gating Working Copy's items on `viewItem != 'createCommitAction'`
	// alone would hide the whole menu the moment Create Commit is part of a select-all. This key lets
	// package.json exempt that row only while it's selected alongside real files -- right-clicked on
	// its own it still gets no menu, and the handlers drop it (see resolveWorkingChangeSelection).
	workingCopyView.onDidChangeSelection(e => {
		const mixed = e.selection.some(isCreateCommitNode) && e.selection.some(isWorkingChangeFile);
		void vscode.commands.executeCommand('setContext', 'ggit.workingCopyMixedSelection', mixed);
	});

	const branchesView = vscode.window.createTreeView('ggitBranches', {
		treeDataProvider: branchesProvider,
		// startMerge is defined further down -- only ever called from a drop, well after activate() is done.
		dragAndDropController: new BranchesDragAndDropController((sourceBranch, intoBranch) => void startMerge(sourceBranch, intoBranch)),
	});
	// The workspace folder name, mirroring how Working Copy's description shows the active branch —
	// static for now since GGit only ever looks at a single workspace folder (see the worktree
	// discussion: there's no "switch worktree" yet, so this never needs to change mid-session).
	branchesView.description = workspaceFolder.name;

	// Single fixed row, no multi-select/checkboxes needed -- see ConflictsTreeProvider.
	const conflictsView = vscode.window.createTreeView('ggitConflicts', { treeDataProvider: conflictsProvider });

	const remotesView = vscode.window.createTreeView('ggitRemotes', { treeDataProvider: remotesProvider });
	// See branchesView above -- description here gets temporarily overridden by the search-filter
	// status instead (see ggit.searchRemotes below), which falls back to this same folder name once
	// the filter's cleared.
	remotesView.description = workspaceFolder.name;

	// Same folder-name description as the views above, except while remotes are being checked for
	// their tags (or couldn't be reached) -- see TagsTreeProvider.
	const tagsView = vscode.window.createTreeView('ggitTags', { treeDataProvider: tagsProvider });
	tagsView.description = workspaceFolder.name;
	tagsProvider.onDidChangeRemoteStatus(status => {
		tagsView.description = status ?? workspaceFolder.name;
	});
	tagsProvider.onDidChangeRemoteTags(names => BranchHistoryPanel.setRemoteTags(names));

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
		// Recorded here rather than only around GGit's own checkout commands, so a checkout run from the
		// integrated terminal still updates Recents -- same "pick this up regardless of source" approach
		// already used for rebase state above. Only actually refreshes the tree again on top of whatever
		// refreshAll pass got us here when the branch genuinely changed, not on every routine refresh.
		if (await recentBranches.syncCurrentBranch(current)) {
			branchesProvider.refresh();
		}
	};

	// The Conflicts view only shows at all while a rebase or merge is stopped (see its `when` clause in
	// package.json) — this is what flips that on/off, checked on every refresh so entering/leaving that
	// state (via GGit's own actions or the integrated terminal) is picked up promptly. Also what
	// auto-opens the Conflicts tab the moment either one stops (including one already stopped when VS
	// Code itself starts up, since this runs once at activation too, below) -- activeConflictOperation
	// starts undefined, so only a genuine none-to-something transition opens it, not every refresh
	// while it's already open.
	let activeConflictOperation: ConflictOperation | undefined;
	const updateConflictContext = async () => {
		const [rebasing, merging] = await Promise.all([gitService.isRebaseInProgress(), gitService.isMergeInProgress()]);
		void vscode.commands.executeCommand('setContext', 'ggit.rebaseInProgress', rebasing);
		void vscode.commands.executeCommand('setContext', 'ggit.mergeInProgress', merging);
		const operation: ConflictOperation | undefined = rebasing ? 'rebase' : merging ? 'merge' : undefined;
		if (operation && operation !== activeConflictOperation) {
			// refreshAll's own conflictsProvider.refresh() already ran before this resolved, with the
			// old wording -- so refresh again now that it knows which operation this is.
			conflictsProvider.setOperation(operation);
			conflictsProvider.refresh();
			if (!activeConflictOperation) {
				ConflictsPanel.createOrShow(context, gitService, refreshAll);
			}
		}
		activeConflictOperation = operation;
	};

	const refreshAll = () => {
		branchesProvider.refresh();
		remotesProvider.refresh();
		workingCopyProvider.refresh();
		stashesProvider.refresh();
		tagsProvider.refresh();
		conflictsProvider.refresh();
		activeBranchDecorations.refresh();
		workingChangeDecorations.refresh();
		showContentProvider.refresh();
		void updateWorkingCopyBadge();
		void updateConflictContext();
		void updateActiveBranchLabel();
		CommitPanel.refreshIfOpen();
		void commitLauncherProvider.refresh();
		ConflictsPanel.refreshIfOpen();
	};

	// refreshAll plus re-asking each remote which tags it has -- a network call, so only after
	// operations that talk to a remote anyway (see TagsTreeProvider), not on every refreshAll.
	const refreshAllAndRemoteTags = () => {
		refreshAll();
		tagsProvider.refreshRemotes();
	};

	const openTagDialog = (mode: TagDialogMode, node: TagNode | undefined) => {
		if (node) {
			TagPanel.createOrShow(context, gitService, mode, node, remoteChanged => {
				refreshAll();
				if (remoteChanged) {
					tagsProvider.refreshRemotes();
				}
				BranchHistoryPanel.refreshIfOpen();
			});
		}
	};

	// A local branch dropped onto the HEAD branch (see BranchesDragAndDropController). Everything is
	// re-checked against live git state -- the drop only knows what the tree looked like when it last
	// rendered. A pure fast-forward gets a plain confirmation, since there's nothing to decide beyond
	// "yes" (its Options button still reaches the full dialog, for --no-ff or a squash); anything that
	// needs a real merge commit goes straight to the Merge dialog. If the merge then stops -- on
	// conflicts, or --no-commit -- updateConflictContext opens the Conflicts tab from the refresh.
	const startMerge = async (sourceBranch: string, intoBranch: string) => {
		try {
			if ((await gitService.getCurrentBranch()) !== intoBranch) {
				// The row dropped on was HEAD when it last rendered but isn't any more -- the same no-op
				// as a drop on any other branch.
				return;
			}
			if (await gitService.isRebaseInProgress()) {
				void vscode.window.showWarningMessage('GGit: Finish or abort the rebase in progress before merging.');
				return;
			}
			if (await gitService.isMergeInProgress()) {
				void vscode.window.showWarningMessage('GGit: Finish or abort the merge in progress before starting another.');
				return;
			}
			const analysis = await gitService.analyzeMerge(sourceBranch);
			if (analysis.incoming === 0) {
				void vscode.window.showInformationMessage(`GGit: ${intoBranch} already has everything on ${sourceBranch} -- nothing to merge.`);
				return;
			}
			const onMerged = () => {
				refreshAll();
				BranchHistoryPanel.refreshIfOpen();
			};
			if (analysis.outgoing > 0) {
				MergePanel.createOrShow(context, gitService, sourceBranch, intoBranch, analysis, onMerged);
				return;
			}
			const commits = `${analysis.incoming} commit${analysis.incoming === 1 ? '' : 's'}`;
			const choice = await vscode.window.showInformationMessage(
				`Merge "${sourceBranch}" into "${intoBranch}"?`,
				{
					modal: true,
					detail: `This is a fast-forward: ${intoBranch} moves ahead ${commits} to match ${sourceBranch}, with no merge commit.`,
				},
				'Merge',
				'Merge Options…'
			);
			if (choice === 'Merge') {
				await runGitOperation(`Merging ${sourceBranch} into ${intoBranch}…`, () => gitService.fastForwardTo(sourceBranch), refreshAll);
			} else if (choice === 'Merge Options…') {
				MergePanel.createOrShow(context, gitService, sourceBranch, intoBranch, analysis, onMerged);
			}
		} catch (err) {
			vscode.window.showErrorMessage(`GGit: ${(err as Error).message}`);
		}
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
	void updateConflictContext();
	void updateActiveBranchLabel();

	context.subscriptions.push(
		workingCopyView,
		branchesView,
		remotesView,
		tagsView,
		conflictsView,
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

		vscode.commands.registerCommand('ggit.setPinnedBranchCount', async () => {
			const input = await vscode.window.showInputBox({
				prompt: `How many recently-used branches to pin at the top of the Branches view (${MIN_PINNED_BRANCH_COUNT}-${MAX_PINNED_BRANCH_COUNT})`,
				value: String(recentBranches.getPinnedCount()),
				validateInput: value => {
					const n = Number(value);
					return Number.isInteger(n) && n >= MIN_PINNED_BRANCH_COUNT && n <= MAX_PINNED_BRANCH_COUNT
						? undefined
						: `Enter a whole number between ${MIN_PINNED_BRANCH_COUNT} and ${MAX_PINNED_BRANCH_COUNT}.`;
				},
			});
			if (input === undefined) {
				return;
			}
			await recentBranches.setPinnedCount(Number(input));
			branchesProvider.refresh();
		}),

		// The optional `remote` arg on fetch/pull/push/sync is only ever supplied by the History tab's
		// own remote dropdown (see branchHistoryPanel.ts's 'runAction' handling) -- every other
		// trigger, like the Branches view's toolbar, calls these with no args and each falls back to
		// its own sensible default (see pickDefaultRemote/pickRemote in gitActions.ts).
		vscode.commands.registerCommand('ggit.fetch', (remote?: string) =>
			runGitOperation('Fetching…', () => fetchCurrentBranch(gitService, remote), refreshAllAndRemoteTags)
		),

		vscode.commands.registerCommand('ggit.pull', (remote?: string) =>
			runGitOperation('Pulling…', () => pullCurrentBranch(gitService, remote), refreshAllAndRemoteTags)
		),

		vscode.commands.registerCommand('ggit.push', (remote?: string) =>
			runGitOperation('Pushing…', () => pushCurrentBranch(gitService, remote), refreshAll)
		),

		vscode.commands.registerCommand('ggit.sync', (remote?: string) =>
			runGitOperation('Syncing…', () => syncCurrentBranch(gitService, remote), refreshAllAndRemoteTags)
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

		vscode.commands.registerCommand('ggit.mergeCommit', () =>
			runGitOperation('Committing merge…', () => gitService.mergeCommit(), refreshAll)
		),

		vscode.commands.registerCommand('ggit.mergeAbort', async () => {
			const confirmed = await vscode.window.showWarningMessage(
				'Abort the merge in progress? This throws away the merge, including any conflicts already resolved, and restores the branch (and any uncommitted changes) to their state before it started.',
				{ modal: true },
				'Abort Merge'
			);
			if (confirmed !== 'Abort Merge') {
				return;
			}
			return runGitOperation('Aborting merge…', () => gitService.mergeAbort(), refreshAll);
		}),

		// The sidebar Conflicts view's only row -- opens (or refocuses) the Conflicts tab, where resolving
		// actually happens. See conflictsTreeProvider.ts and conflictsPanel.ts.
		vscode.commands.registerCommand('ggit.openConflictsTab', () => {
			ConflictsPanel.createOrShow(context, gitService, refreshAll);
		}),

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
			(file: WorkingCopyNode, selectedFiles?: WorkingCopyNode[]) => {
				const files = resolveWorkingChangeSelection(file, selectedFiles);
				if (files.length === 0) {
					// Nothing real in play -- e.g. the pinned Create Commit row was the only thing
					// clicked (or selected). See resolveWorkingChangeSelection.
					return;
				}
				return runGitOperation(
					`Stashing ${files.length} file${files.length === 1 ? '' : 's'}…`,
					() => stashPathsWithMessage(gitService, files.map(f => f.path)),
					refreshAll
				);
			}
		),

		vscode.commands.registerCommand('ggit.openWorkingChangeFile', async (file: WorkingCopyNode) => {
			if (!isWorkingChangeFile(file)) {
				// The pinned Create Commit row -- its own row command opens the Commit panel, not this.
				return;
			}
			try {
				const uri = vscode.Uri.file(path.join(gitService.repoRoot, file.path));
				await vscode.commands.executeCommand('vscode.open', uri);
			} catch (err) {
				vscode.window.showErrorMessage(`Failed to open file: ${(err as Error).message}`);
			}
		}),

		vscode.commands.registerCommand(
			'ggit.discardChanges',
			(file: WorkingCopyNode, selectedFiles?: WorkingCopyNode[]) => {
				const files = resolveWorkingChangeSelection(file, selectedFiles);
				if (files.length === 0) {
					return;
				}
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
			async (file: WorkingCopyNode, selectedFiles?: WorkingCopyNode[]) => {
				const files = resolveWorkingChangeSelection(file, selectedFiles);
				if (files.length === 0) {
					return;
				}
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
			async (file: WorkingCopyNode, selectedFiles?: WorkingCopyNode[]) => {
				const files = resolveWorkingChangeSelection(file, selectedFiles);
				if (files.length === 0) {
					return;
				}
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
			async (file: WorkingCopyNode, selectedFiles?: WorkingCopyNode[]) => {
				const files = resolveWorkingChangeSelection(file, selectedFiles);
				if (files.length === 0) {
					return;
				}
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
		// The History tab narrowed to this file, on the checked-out branch -- the one the Working Copy
		// file belongs to. Detached HEAD has no branch name, so "HEAD" itself stands in.
		vscode.commands.registerCommand('ggit.showFileHistory', async (node: WorkingCopyNode, selectedFiles?: WorkingCopyNode[]) => {
			const file = resolveSingleWorkingChangeFile(node, selectedFiles);
			if (!file) {
				return;
			}
			const branch = (await gitService.getCurrentBranch()) ?? 'HEAD';
			BranchHistoryPanel.createOrShow(context, gitService, branch, file.path);
		}),

		vscode.commands.registerCommand('ggit.copyRelativePath', (node: WorkingCopyNode, selectedFiles?: WorkingCopyNode[]) => {
			const file = resolveSingleWorkingChangeFile(node, selectedFiles);
			if (!file) {
				return;
			}
			void vscode.env.clipboard.writeText(file.path.split('/').join(path.sep));
		}),

		vscode.commands.registerCommand('ggit.copyPath', (node: WorkingCopyNode, selectedFiles?: WorkingCopyNode[]) => {
			const file = resolveSingleWorkingChangeFile(node, selectedFiles);
			if (!file) {
				return;
			}
			void vscode.env.clipboard.writeText(path.join(gitService.repoRoot, file.path));
		}),

		vscode.commands.registerCommand('ggit.revealInExplorerView', (node: WorkingCopyNode, selectedFiles?: WorkingCopyNode[]) => {
			const file = resolveSingleWorkingChangeFile(node, selectedFiles);
			if (!file) {
				return;
			}
			const uri = vscode.Uri.file(path.join(gitService.repoRoot, file.path));
			void vscode.commands.executeCommand('revealInExplorer', uri);
		}),

		// Three commands, not one, purely so each can carry the OS-appropriate label VS Code's own
		// Explorer uses ("Reveal in Finder" / "Reveal in File Explorer" / "Open Containing Folder") --
		// package.json menu titles are static, so the isMac/isWindows/isLinux `when` clauses on these
		// three (see package.json) are what actually pick the one that shows up on a given OS.
		vscode.commands.registerCommand('ggit.revealInOS', (node: WorkingCopyNode, selectedFiles?: WorkingCopyNode[]) => {
			const file = resolveSingleWorkingChangeFile(node, selectedFiles);
			if (!file) {
				return;
			}
			const uri = vscode.Uri.file(path.join(gitService.repoRoot, file.path));
			void vscode.commands.executeCommand('revealFileInOS', uri);
		}),

		vscode.commands.registerCommand('ggit.revealInFileExplorer', (node: WorkingCopyNode, selectedFiles?: WorkingCopyNode[]) => {
			const file = resolveSingleWorkingChangeFile(node, selectedFiles);
			if (!file) {
				return;
			}
			const uri = vscode.Uri.file(path.join(gitService.repoRoot, file.path));
			void vscode.commands.executeCommand('revealFileInOS', uri);
		}),

		vscode.commands.registerCommand('ggit.openContainingFolder', (node: WorkingCopyNode, selectedFiles?: WorkingCopyNode[]) => {
			const file = resolveSingleWorkingChangeFile(node, selectedFiles);
			if (!file) {
				return;
			}
			const uri = vscode.Uri.file(path.join(gitService.repoRoot, file.path));
			void vscode.commands.executeCommand('revealFileInOS', uri);
		}),

		vscode.commands.registerCommand('ggit.createBranchFrom', (node: BranchTreeNode<BranchInfo>) => {
			if (node.kind === 'leaf') {
				CreateBranchPanel.createOrShow(context, gitService, refreshAll, node.item.name);
			}
		}),

		// Tags the branch's tip, not HEAD -- the right-clicked branch needn't be the checked-out one.
		vscode.commands.registerCommand('ggit.createTagFrom', (node?: BranchTreeNode<BranchInfo>) => {
			if (node?.kind === 'leaf') {
				CreateTagPanel.createOrShow(context, gitService, node.item.name, refreshAll);
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

		// A tag's history, same as a branch's -- the tagged commit first, then everything older.
		vscode.commands.registerCommand('ggit.tagClicked', (tagName: string) => {
			BranchHistoryPanel.createOrShow(context, gitService, tagName);
		}),

		vscode.commands.registerCommand('ggit.refreshTags', () => {
			tagsProvider.refresh();
			tagsProvider.refreshRemotes();
		}),

		vscode.commands.registerCommand('ggit.publishTag', (node?: TagNode) => openTagDialog('publish', node)),
		vscode.commands.registerCommand('ggit.pushTag', (node?: TagNode) => openTagDialog('push', node)),
		vscode.commands.registerCommand('ggit.deleteTag', (node?: TagNode) => openTagDialog('delete', node)),

		vscode.commands.registerCommand('ggit.copyTagName', async (node?: TagNode) => {
			if (node) {
				await vscode.env.clipboard.writeText(node.name);
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
			// MERGE_HEAD does the same for a stopped merge (`ggit.mergeInProgress`).
			// worktrees/** is git's per-linked-worktree admin dir — a subdirectory appears/disappears
			// on `git worktree add`/`remove`, and each one's own HEAD file changes when that worktree
			// switches branches, which is exactly the state Branches' blue/"checked out elsewhere"
			// styling depends on. This only sees other worktrees because GGit's own workspace folder is
			// always the *main* checkout today (no worktree-switching UI yet) — its .git is the real,
			// shared git dir, not a per-worktree pointer file. If GGit ever opens from inside a linked
			// worktree instead, this would need to watch the resolved git-common-dir rather than a
			// hardcoded ".git" under the workspace folder.
			'{HEAD,MERGE_HEAD,refs/**,packed-refs,index,rebase-merge/**,rebase-apply/**,worktrees/**}'
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
		// The Commit tab shows the exact same staged+unstaged data as Working Copy (see
		// CommitPanel.sendStaged) -- without this, editing/saving a file while it's already open left it
		// stale until some *other*, full-refreshAll-triggering action happened to run (staging a file,
		// fetching, etc.), even though the very point of it is to reflect live unstaged changes too.
		CommitPanel.refreshIfOpen();
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
	// the full branches/remotes/stashes refreshAll. files.watcherExclude doesn't cover .gitignore,
	// though -- a test run streaming into an ignored logs/ dir fired this on every write and kept a
	// `git status` going nonstop -- so each debounced batch is checked against .gitignore first and
	// dropped if nothing in it could actually show up in Working Copy.
	const workingTreeWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(workspaceFolder, '**/*'));
	let workingTreeDebounce: ReturnType<typeof setTimeout> | undefined;
	const pendingWorkingTreeChanges = new Set<string>();
	const flushWorkingTreeChanges = async () => {
		const changed = [...pendingWorkingTreeChanges];
		pendingWorkingTreeChanges.clear();
		// Logged once per batch rather than per event -- still proves the watcher is alive (see
		// onGitDirChange above), without flooding the channel during exactly the storms this is for.
		const summary = `${changed[0]}${changed.length > 1 ? ` (+${changed.length - 1} more)` : ''}`;
		if (await gitService.allIgnored(changed)) {
			output.appendLine(`workingTreeWatcher: skipped, all gitignored: ${summary}`);
			return;
		}
		refreshWorkingCopy(`external change: ${summary}`);
	};
	const onWorkingTreeChange = (uri: vscode.Uri) => {
		if (uri.fsPath.includes(`${path.sep}.git${path.sep}`) || uri.fsPath.endsWith(`${path.sep}.git`)) {
			// Already covered by gitDirWatcher above -- skip to avoid double-refreshing on every commit/checkout.
			return;
		}
		pendingWorkingTreeChanges.add(uri.fsPath);
		clearTimeout(workingTreeDebounce);
		workingTreeDebounce = setTimeout(() => void flushWorkingTreeChanges(), 500);
	};
	workingTreeWatcher.onDidChange(onWorkingTreeChange);
	workingTreeWatcher.onDidCreate(onWorkingTreeChange);
	workingTreeWatcher.onDidDelete(onWorkingTreeChange);
	context.subscriptions.push(workingTreeWatcher);
}

/** Normalizes a Working Copy context-menu invocation into just the real files, dropping the pinned
 * Create Commit row if it's part of the selection. package.json only offers the menu on that row
 * while it's selected alongside real files (see ggit.workingCopyMixedSelection in activate()) --
 * VS Code's `when`-clause matching applies to every item in the selection, so the menu can't be
 * hidden for that one row without hiding it for a select-all too -- which leaves dropping it here. */
function resolveWorkingChangeSelection(file: WorkingCopyNode, selectedFiles?: WorkingCopyNode[]): WorkingChangeFile[] {
	const nodes = selectedFiles && selectedFiles.length > 0 ? selectedFiles : [file];
	return nodes.filter(isWorkingChangeFile);
}

/** For the single-target commands (Copy Path, Reveal): the right-clicked file itself, or -- when the
 * row right-clicked was Create Commit as part of a larger selection, e.g. a select-all -- the first
 * real file in that selection instead. */
function resolveSingleWorkingChangeFile(
	file: WorkingCopyNode,
	selectedFiles?: WorkingCopyNode[]
): WorkingChangeFile | undefined {
	return isWorkingChangeFile(file) ? file : resolveWorkingChangeSelection(file, selectedFiles)[0];
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
