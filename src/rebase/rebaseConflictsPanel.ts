import * as path from 'path';
import * as vscode from 'vscode';
import { saveOpenDocumentIfDirty } from '../documentUtils';
import { GitService } from '../git/gitService';
import { RebaseHostMessage, RebaseWebviewMessage } from './rebaseProtocol';

/** The dedicated tab for working through an in-progress rebase's conflicts, one paused commit at a
 * time -- opened automatically the moment a rebase hits its first conflict (see updateRebaseContext
 * in extension.ts), and reachable afterward via the sidebar Conflicts view's permanent "Resolve
 * Conflicts" row (see conflictsTreeProvider.ts). Modeled on BranchHistoryPanel/CommitPanel: a single
 * webview panel, refreshed in place as the rebase progresses rather than reopened per commit. */
export class RebaseConflictsPanel {
	private static current: RebaseConflictsPanel | undefined;

	private readonly panel: vscode.WebviewPanel;
	private readonly disposables: vscode.Disposable[] = [];
	private ready = false;
	// Which rebase step (see GitService.getRebaseProgress) the current file list/count belong to --
	// undefined until the first refresh. Reset whenever this changes, so "Staged files: n/m" always
	// counts up from 0 for a freshly-encountered commit rather than carrying over the last one's tally.
	private lastSeenStep: number | undefined;
	private totalFilesThisCommit = 0;

	private constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly gitService: GitService,
		private readonly onChanged: () => void
	) {
		this.panel = vscode.window.createWebviewPanel(
			'ggitRebase',
			'Rebase',
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
		this.panel.webview.onDidReceiveMessage((msg: RebaseWebviewMessage) => this.handleMessage(msg), null, this.disposables);
	}

	static createOrShow(context: vscode.ExtensionContext, gitService: GitService, onChanged: () => void): void {
		if (RebaseConflictsPanel.current) {
			RebaseConflictsPanel.current.panel.reveal(vscode.ViewColumn.Active, false);
			return;
		}
		RebaseConflictsPanel.current = new RebaseConflictsPanel(context, gitService, onChanged);
	}

	/** Called from refreshAll -- keeps the open tab in sync with anything that changed it (its own
	 * buttons, but also e.g. `git rebase --continue` run from the integrated terminal instead), and
	 * closes it once there's nothing left to show, whatever the reason (finished, aborted, or resolved
	 * some other way entirely). */
	static refreshIfOpen(): void {
		void RebaseConflictsPanel.current?.refresh();
	}

	private async refresh(): Promise<void> {
		if (!this.ready) {
			return;
		}
		try {
			const inProgress = await this.gitService.isRebaseInProgress();
			if (!inProgress) {
				// Nothing left to show, regardless of why -- Continue/Skip finishing the rebase, Abort
				// unwinding it, or someone resolving it entirely outside this tab.
				this.panel.dispose();
				return;
			}
			const [files, progress] = await Promise.all([this.gitService.getConflictedFiles(), this.gitService.getRebaseProgress()]);
			const current = progress?.current ?? 0;
			if (this.lastSeenStep !== current) {
				this.lastSeenStep = current;
				this.totalFilesThisCommit = files.length;
			}
			this.panel.title = progress?.branchName ? `Rebase: ${progress.branchName}` : 'Rebase';
			this.post({
				type: 'state',
				state: {
					branchName: progress?.branchName,
					current,
					total: progress?.total ?? 0,
					subject: progress?.subject,
					files,
					totalFilesThisCommit: this.totalFilesThisCommit,
				},
			});
		} catch (err) {
			this.post({ type: 'error', message: (err as Error).message });
		}
	}

	private async handleMessage(msg: RebaseWebviewMessage): Promise<void> {
		switch (msg.type) {
			case 'ready':
				this.ready = true;
				await this.refresh();
				break;
			case 'setResolved':
				try {
					await saveOpenDocumentIfDirty(path.join(this.gitService.repoRoot, msg.path));
					await this.gitService.stageFile(msg.path);
					this.onChanged();
					await this.refresh();
				} catch (err) {
					this.post({ type: 'error', message: (err as Error).message });
				}
				break;
			case 'openFile':
				try {
					const uri = vscode.Uri.file(path.join(this.gitService.repoRoot, msg.path));
					const openGroup = findOpenTextTabGroup(uri);
					if (openGroup) {
						// Already open somewhere (most likely left over from resolving this same file a
						// moment ago) -- just bring that tab forward instead of opening a second copy of
						// it, possibly in yet another column.
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
			// These three already run through their own registered commands (ggit.rebase* in
			// extension.ts), which wrap them in a progress notification and call refreshAll on success --
			// including, via RebaseConflictsPanel.refreshIfOpen, right back into this panel's own
			// refresh(). Abort's confirmation modal lives there too, so it's identical whether triggered
			// from here or the sidebar's own Abort button.
			case 'continue':
				void vscode.commands.executeCommand('ggit.rebaseContinue');
				break;
			case 'skip':
				void vscode.commands.executeCommand('ggit.rebaseSkip');
				break;
			case 'abort':
				void vscode.commands.executeCommand('ggit.rebaseAbort');
				break;
		}
	}

	private post(message: RebaseHostMessage): void {
		void this.panel.webview.postMessage(message);
	}

	private dispose(): void {
		RebaseConflictsPanel.current = undefined;
		while (this.disposables.length) {
			this.disposables.pop()?.dispose();
		}
	}

	private getHtml(context: vscode.ExtensionContext): string {
		const webview = this.panel.webview;
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'rebaseWebview.js'));
		const codiconCssUri = webview.asWebviewUri(
			vscode.Uri.joinPath(context.extensionUri, 'node_modules', '@vscode/codicons', 'dist', 'codicon.css')
		);
		const nonce = getNonce();

		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
	<title>Rebase</title>
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
	<div id="toolbar">
		<button id="continueButton" class="toolbar-btn" disabled>
			<span class="codicon codicon-check"></span><span id="continueLabel">Next Commit</span>
		</button>
		<button id="skipButton" class="toolbar-btn">
			<span class="codicon codicon-debug-step-over"></span>Skip Commit
		</button>
		<button id="abortButton" class="toolbar-btn">
			<span class="codicon codicon-circle-slash"></span>Abort Rebase
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
 * (see 'openFile' above), never as one side of a diff. */
function findOpenTextTabGroup(uri: vscode.Uri): vscode.ViewColumn | undefined {
	for (const group of vscode.window.tabGroups.all) {
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
