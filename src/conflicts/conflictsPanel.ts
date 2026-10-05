import * as vscode from 'vscode';
import { saveOpenDocumentIfDirty } from '../documentUtils';
import { GitService } from '../git/gitService';
import { ConflictOperation, ConflictsHostMessage, ConflictsWebviewMessage } from './conflictsProtocol';

/** The dedicated tab for working through a stopped rebase, merge, cherry-pick, or revert -- a rebase
 * one paused commit at a time, the others in a single pass. Opened automatically the moment either one stops (see
 * updateConflictContext in extension.ts), and reachable afterward via the sidebar Conflicts view's
 * permanent row (see conflictsTreeProvider.ts). Modeled on BranchHistoryPanel/CommitPanel: a single
 * webview panel, refreshed in place as things progress rather than reopened per step. git can't be
 * mid-rebase and mid-merge at once (each refuses to start while the other is in progress), so the tab
 * only ever has one operation to show -- whichever refresh() finds. */
export class ConflictsPanel {
	private static current: ConflictsPanel | undefined;

	private readonly panel: vscode.WebviewPanel;
	private readonly disposables: vscode.Disposable[] = [];
	private ready = false;
	// Which operation the last refresh found -- what the webview's continue/abort buttons act on.
	private operation: ConflictOperation | undefined;
	// Which step (a rebase's current commit, see GitService.getRebaseProgress, or the one step a merge
	// has) the current file list/count belong to -- undefined until the first refresh. Reset whenever
	// this changes, so "Staged files: n/m" always counts up from 0 for a freshly-encountered pause
	// rather than carrying over the last one's tally.
	private lastSeenStep: string | undefined;
	private totalFilesThisCommit = 0;

	private constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly gitService: GitService,
		private readonly onChanged: () => void
	) {
		this.panel = vscode.window.createWebviewPanel(
			'ggitResolveConflicts',
			'Conflicts',
			{ viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [
					vscode.Uri.joinPath(context.extensionUri, 'dist'),
					vscode.Uri.joinPath(context.extensionUri, 'node_modules', '@vscode/codicons', 'dist'),
				],
			}
		);
		this.panel.webview.html = this.getHtml(context);
		this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
		this.panel.webview.onDidReceiveMessage((msg: ConflictsWebviewMessage) => this.handleMessage(msg), null, this.disposables);
	}

	static createOrShow(context: vscode.ExtensionContext, gitService: GitService, onChanged: () => void): void {
		if (ConflictsPanel.current) {
			ConflictsPanel.current.panel.reveal(vscode.ViewColumn.Active, false);
			return;
		}
		ConflictsPanel.current = new ConflictsPanel(context, gitService, onChanged);
	}

	/** Called from refreshAll -- keeps the open tab in sync with anything that changed it (its own
	 * buttons, but also e.g. `git rebase --continue` or `git commit` run from the integrated terminal
	 * instead), and closes it once there's nothing left to show, whatever the reason (finished,
	 * aborted, or resolved some other way entirely). */
	static refreshIfOpen(): void {
		void ConflictsPanel.current?.refresh();
	}

	private async refresh(): Promise<void> {
		if (!this.ready) {
			return;
		}
		try {
			const [rebasing, merging, pick] = await Promise.all([
				this.gitService.isRebaseInProgress(),
				this.gitService.isMergeInProgress(),
				this.gitService.getPickInProgress(),
			]);
			if (!rebasing && !merging && !pick) {
				// Nothing left to show, regardless of why -- finishing, aborting, or someone resolving it
				// entirely outside this tab.
				this.panel.dispose();
				return;
			}
			this.operation = rebasing ? 'rebase' : merging ? 'merge' : pick!.operation;
			const files = await this.gitService.getConflictedFiles();
			if (pick && !rebasing && !merging) {
				const branchName = await this.gitService.getCurrentBranch();
				this.trackStep(`${pick.operation}:${pick.commit}`, files.length);
				this.panel.title = `${pick.operation === 'revert' ? 'Revert' : 'Cherry-Pick'}: ${pick.commit.slice(0, 7)}`;
				this.post({
					type: 'state',
					state: {
						operation: pick.operation,
						branchName,
						commit: pick.commit,
						intoBranch: undefined,
						current: 0,
						total: 0,
						subject: pick.subject,
						files,
						totalFilesThisCommit: this.totalFilesThisCommit,
					},
				});
			} else if (this.operation === 'rebase') {
				const progress = await this.gitService.getRebaseProgress();
				const current = progress?.current ?? 0;
				this.trackStep(`rebase:${current}`, files.length);
				this.panel.title = progress?.branchName ? `Rebase: ${progress.branchName}` : 'Rebase';
				this.post({
					type: 'state',
					state: {
						operation: 'rebase',
						branchName: progress?.branchName,
						commit: undefined,
						intoBranch: undefined,
						current,
						total: progress?.total ?? 0,
						subject: progress?.subject,
						files,
						totalFilesThisCommit: this.totalFilesThisCommit,
					},
				});
			} else {
				const progress = await this.gitService.getMergeProgress();
				this.trackStep('merge', files.length);
				this.panel.title = progress?.branchName ? `Merge: ${progress.branchName}` : 'Merge';
				this.post({
					type: 'state',
					state: {
						operation: 'merge',
						branchName: progress?.branchName,
						commit: undefined,
						intoBranch: progress?.intoBranch,
						current: 0,
						total: 0,
						subject: undefined,
						files,
						totalFilesThisCommit: this.totalFilesThisCommit,
					},
				});
			}
		} catch (err) {
			this.post({ type: 'error', message: (err as Error).message });
		}
	}

	private trackStep(step: string, fileCount: number): void {
		if (this.lastSeenStep !== step) {
			this.lastSeenStep = step;
			this.totalFilesThisCommit = fileCount;
		}
	}

	private async handleMessage(msg: ConflictsWebviewMessage): Promise<void> {
		switch (msg.type) {
			case 'ready':
				this.ready = true;
				await this.refresh();
				break;
			case 'setResolved':
				try {
					await saveOpenDocumentIfDirty(this.gitService.resolveRepoPath(msg.path));
					await this.gitService.stageFile(msg.path);
					this.onChanged();
					await this.refresh();
				} catch (err) {
					this.post({ type: 'error', message: (err as Error).message });
				}
				break;
			case 'openFile':
				try {
					const uri = vscode.Uri.file(this.gitService.resolveRepoPath(msg.path));
					// Never this tab's own group: showing the file there would cover this tab -- and its
					// checkboxes and Continue/Abort buttons -- for as long as the file's being resolved.
					// That's the usual case, too, not an edge one: a file someone was already editing
					// before the rebase/merge stopped is open in whatever group was active, which is
					// exactly where this tab then opened (see createOrShow). Verified in a live Extension
					// Development Host that reusing that copy hid this tab behind it.
					const openGroup = findOpenTextTabGroup(uri, this.panel.viewColumn);
					if (openGroup) {
						// Already open in some other group (most likely left over from resolving this same
						// file a moment ago) -- just bring that tab forward instead of opening a second copy
						// of it, possibly in yet another column.
						await vscode.window.showTextDocument(uri, { viewColumn: openGroup, preserveFocus: false });
					} else {
						await vscode.commands.executeCommand('vscode.open', uri, {
							viewColumn: vscode.ViewColumn.Beside,
							preview: true,
						} satisfies vscode.TextDocumentShowOptions);
					}
				} catch (err) {
					vscode.window.showErrorMessage(`GGit: Failed to open file: ${(err as Error).message}`);
				}
				break;
			// These already run through their own registered commands (ggit.rebase*/ggit.merge* in
			// extension.ts), which wrap them in a progress notification and call refreshAll on success --
			// including, via ConflictsPanel.refreshIfOpen, right back into this panel's own refresh().
			// Abort's confirmation modal lives there too, so it's identical whether triggered from here
			// or the sidebar's own Abort button.
			case 'continue':
				void vscode.commands.executeCommand(
					this.operation === 'merge' ? 'ggit.mergeCommit' : this.operation === 'rebase' ? 'ggit.rebaseContinue' : 'ggit.pickContinue'
				);
				break;
			case 'skip':
				// Only a rebase has more than one commit to step through -- the webview hides this button
				// for everything else.
				if (this.operation === 'rebase') {
					void vscode.commands.executeCommand('ggit.rebaseSkip');
				}
				break;
			case 'abort':
				void vscode.commands.executeCommand(
					this.operation === 'merge' ? 'ggit.mergeAbort' : this.operation === 'rebase' ? 'ggit.rebaseAbort' : 'ggit.pickAbort'
				);
				break;
		}
	}

	private post(message: ConflictsHostMessage): void {
		void this.panel.webview.postMessage(message);
	}

	private dispose(): void {
		ConflictsPanel.current = undefined;
		while (this.disposables.length) {
			this.disposables.pop()?.dispose();
		}
	}

	private getHtml(context: vscode.ExtensionContext): string {
		const webview = this.panel.webview;
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'conflictsWebview.js'));
		const codiconCssUri = webview.asWebviewUri(
			vscode.Uri.joinPath(context.extensionUri, 'node_modules', '@vscode/codicons', 'dist', 'codicon.css')
		);
		const nonce = getNonce();

		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
	<title>Conflicts</title>
	<link href="${codiconCssUri}" rel="stylesheet" />
	<style>
		html, body {
			height: 100%;
			margin: 0;
			padding: 0;
			color: var(--vscode-editor-foreground);
			background-color: var(--vscode-editor-background);
			font-family: var(--vscode-font-family);
			font-size: var(--vscode-font-size);
		}
		#progress {
			padding: 10px 14px 0 14px;
			color: var(--vscode-descriptionForeground);
		}
		/* Merge only -- which side of a conflict is which, since "Current"/"Incoming" is all the
		 * editor's own conflict markers and Accept buttons call them. */
		#hint {
			padding: 4px 14px 0 14px;
			color: var(--vscode-descriptionForeground);
			font-size: 0.9em;
		}
		#hint:empty {
			display: none;
		}
		#toolbar {
			display: flex;
			align-items: center;
			flex-wrap: wrap;
			gap: 8px;
			padding: 10px 14px;
			border-bottom: 1px solid var(--vscode-panel-border);
		}
		.toolbar-btn {
			display: flex;
			align-items: center;
			gap: 6px;
			height: 28px;
			padding: 0 10px;
			border: 1px solid rgba(200, 200, 200, 0.4);
			border-radius: 4px;
			background: transparent;
			color: var(--vscode-icon-foreground, var(--vscode-foreground));
			font-family: inherit;
			font-size: inherit;
			cursor: pointer;
		}
		/* The display above otherwise always wins over the UA stylesheet's own [hidden] rule (same as
		 * the History tab's toolbar) -- without this, hiding Skip for a merge wouldn't actually hide it. */
		.toolbar-btn[hidden] {
			display: none;
		}
		.toolbar-btn:hover:not(:disabled) {
			border-color: rgba(200, 200, 200, 0.85);
			background-color: var(--vscode-toolbar-hoverBackground);
		}
		.toolbar-btn:disabled {
			opacity: 0.5;
			cursor: default;
		}
		.toolbar-btn .codicon {
			font-size: 16px;
		}
		/* Blue, once every file in the current commit is staged -- not the last commit in the rebase. */
		#continueButton.toolbar-btn-primary {
			border-color: transparent;
			background-color: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
		}
		#continueButton.toolbar-btn-primary:hover:not(:disabled) {
			background-color: var(--vscode-button-hoverBackground);
		}
		/* Green instead, on the last commit -- same "this finishes it" green used for the History tab's
		 * Push button once there's something ready to push. */
		#continueButton.toolbar-btn-success {
			border: 1px solid transparent;
			background-color: #1f883d;
			color: #ffffff;
		}
		#continueButton.toolbar-btn-success:hover:not(:disabled) {
			background-color: #1f883d;
			border-color: rgba(255, 255, 255, 0.6);
		}
		#stagedText {
			margin-left: auto;
			color: var(--vscode-descriptionForeground);
			white-space: nowrap;
		}
		#error {
			padding: 8px 14px;
			color: var(--vscode-errorForeground);
		}
		#files {
			display: flex;
			flex-direction: column;
			padding: 6px 14px;
		}
		.file-row {
			display: flex;
			align-items: center;
			gap: 8px;
			padding: 5px 0;
			cursor: pointer;
		}
		.file-name {
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
			color: var(--vscode-gitDecoration-conflictingResourceForeground, #e2c08d);
		}
		.empty {
			padding: 14px;
			color: var(--vscode-descriptionForeground);
			font-style: italic;
		}
		/* Plain <input type="checkbox"> renders with the OS's native control -- this redraws it with the
		 * same theme tokens VS Code's own tree-view checkboxes use, matching the Working Copy/Commit
		 * tabs' checkboxes instead of looking like a stray form control. */
		.file-checkbox {
			appearance: none;
			-webkit-appearance: none;
			width: 16px;
			height: 16px;
			margin: 0;
			flex: 0 0 auto;
			border: 1px solid var(--vscode-checkbox-border, #6b6b6b);
			border-radius: 3px;
			background-color: var(--vscode-checkbox-background, #313131);
			cursor: pointer;
			position: relative;
		}
		.file-checkbox:checked {
			background-color: var(--vscode-checkbox-selectBackground, var(--vscode-checkbox-background, #313131));
			border-color: var(--vscode-checkbox-selectBorder, var(--vscode-checkbox-border, #6b6b6b));
		}
		.file-checkbox:checked::after {
			content: "";
			position: absolute;
			left: 4px;
			top: 1px;
			width: 4px;
			height: 8px;
			border: solid var(--vscode-checkbox-foreground, #cccccc);
			border-width: 0 2px 2px 0;
			transform: rotate(45deg);
		}
		.file-checkbox:focus-visible {
			outline: 1px solid var(--vscode-focusBorder);
			outline-offset: 1px;
		}
	</style>
</head>
<body>
	<div id="progress"></div>
	<div id="hint"></div>
	<div id="toolbar">
		<button id="continueButton" class="toolbar-btn" disabled>
			<span class="codicon codicon-check"></span><span id="continueLabel">Next Commit</span>
		</button>
		<button id="skipButton" class="toolbar-btn">
			<span class="codicon codicon-debug-step-over"></span>Skip Commit
		</button>
		<button id="abortButton" class="toolbar-btn">
			<span class="codicon codicon-circle-slash"></span><span id="abortLabel">Abort Rebase</span>
		</button>
		<span id="stagedText"></span>
	</div>
	<div id="error"></div>
	<div id="files"></div>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
	}
}

/** The view column of an already-open plain-text tab for this exact file, if any -- checked before
 * opening a conflicted file so repeatedly clicking the same row (or clicking it again after it was
 * already opened once) focuses that tab instead of stacking up duplicates. Deliberately only matches
 * a real text tab (TabInputText), not a diff or any other kind -- this file is always opened plainly
 * (see 'openFile' above), never as one side of a diff. Skips `excludeColumn` (the Conflicts tab's own
 * group -- see 'openFile'). */
function findOpenTextTabGroup(uri: vscode.Uri, excludeColumn: vscode.ViewColumn | undefined): vscode.ViewColumn | undefined {
	for (const group of vscode.window.tabGroups.all) {
		if (group.viewColumn === excludeColumn) {
			continue;
		}
		const isOpenHere = group.tabs.some(t => t.input instanceof vscode.TabInputText && t.input.uri.toString() === uri.toString());
		if (isOpenHere) {
			return group.viewColumn;
		}
	}
	return undefined;
}

function getNonce(): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let text = '';
	for (let i = 0; i < 32; i++) {
		text += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return text;
}
