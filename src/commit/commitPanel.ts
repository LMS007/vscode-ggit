import * as vscode from 'vscode';
import { GitService } from '../git/gitService';
import { CommitHostMessage, CommitWebviewMessage } from './commitProtocol';

/** A first-class companion panel for `git commit`, mirroring CreateBranchPanel's form-style approach —
 * a plain InputBox can't offer a separate subject/body, an Amend checkbox, or a live preview of what's
 * about to be committed, and VS Code has no native multi-field dialog to fall back on either. */
export class CommitPanel {
	private static current: CommitPanel | undefined;

	private readonly panel: vscode.WebviewPanel;
	private readonly disposables: vscode.Disposable[] = [];
	private ready = false;

	private constructor(
		context: vscode.ExtensionContext,
		private readonly gitService: GitService,
		private readonly onCommitted: () => void
	) {
		this.panel = vscode.window.createWebviewPanel(
			'ggitCommit',
			'Commit',
			{ viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
			{
				enableScripts: true,
				localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')],
			}
		);
		this.panel.webview.html = this.getHtml(context);
		this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
		this.panel.webview.onDidReceiveMessage((msg: CommitWebviewMessage) => this.handleMessage(msg), null, this.disposables);
	}

	static createOrShow(context: vscode.ExtensionContext, gitService: GitService, onCommitted: () => void): void {
		if (CommitPanel.current) {
			CommitPanel.current.panel.reveal(vscode.ViewColumn.Active, false);
			return;
		}
		CommitPanel.current = new CommitPanel(context, gitService, onCommitted);
	}

	/** Refreshes the staged-files list/stats in the open panel, if any — called from extension.ts's
	 * refreshAll so it never shows a stale preview of what's about to be committed after staging,
	 * unstaging, or discarding happens elsewhere while this panel is open. */
	static refreshIfOpen(): void {
		void CommitPanel.current?.sendStaged();
	}

	private async sendStaged(): Promise<void> {
		if (!this.ready) {
			return;
		}
		const [changes, stats, lastCommit, branch] = await Promise.all([
			this.gitService.getWorkingChanges(),
			this.gitService.getStagedStats(),
			this.gitService.getHeadCommitMessage(),
			this.gitService.getCurrentBranch(),
		]);
		this.panel.title = branch ? `Commit: ${branch}` : 'Commit';
		// Both staged and unstaged rows — like Working Copy, one flat list sorted by path, with the
		// checkbox as the only staged/unstaged signal — so a file can be staged or unstaged from here
		// without switching views, not just committed.
		const files = changes
			.map(f => ({ path: f.path, status: f.status, staged: f.state === 'staged' }))
			.sort((a, b) => a.path.localeCompare(b.path));
		this.post({
			type: 'staged',
			files,
			insertions: stats.insertions,
			deletions: stats.deletions,
			lastCommitSubject: lastCommit?.subject ?? '',
			lastCommitBody: lastCommit?.body ?? '',
			branch,
			hasHead: lastCommit !== undefined,
		});
	}

	private async handleMessage(msg: CommitWebviewMessage): Promise<void> {
		switch (msg.type) {
			case 'ready':
				this.ready = true;
				await this.sendStaged();
				break;
			case 'commit':
				try {
					const message = msg.body ? `${msg.subject}\n\n${msg.body}` : msg.subject;
					await this.gitService.commit(message, { amend: msg.amend });
					this.onCommitted();
					this.post({ type: 'committed' });
					await this.sendStaged();
				} catch (err) {
					this.post({ type: 'error', message: (err as Error).message });
				}
				break;
			case 'setStaged':
				try {
					if (msg.staged) {
						await this.gitService.stageFile(msg.path);
					} else {
						await this.gitService.unstageFile(msg.path);
					}
					this.onCommitted();
					await this.sendStaged();
				} catch (err) {
					this.post({ type: 'error', message: (err as Error).message });
				}
				break;
			case 'setAllStaged':
				try {
					if (msg.staged) {
						await this.gitService.stageAll();
					} else {
						await this.gitService.unstageAll();
					}
					this.onCommitted();
					await this.sendStaged();
				} catch (err) {
					this.post({ type: 'error', message: (err as Error).message });
				}
				break;
		}
	}

	private post(message: CommitHostMessage): void {
		void this.panel.webview.postMessage(message);
	}

	private dispose(): void {
		CommitPanel.current = undefined;
		while (this.disposables.length) {
			this.disposables.pop()?.dispose();
		}
	}

	private getHtml(context: vscode.ExtensionContext): string {
		const webview = this.panel.webview;
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'commitWebview.js'));
		const nonce = getNonce();

		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<title>Commit</title>
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
		#wrapper {
			display: flex;
			justify-content: center;
			padding: 40px 20px;
		}
		#card {
			width: 100%;
			max-width: 560px;
		}
		h1 {
			font-size: 1.3em;
			margin: 0 0 4px 0;
		}
		#subtitle {
			color: var(--vscode-descriptionForeground);
			margin: 0 0 24px 0;
		}
		.field {
			margin-bottom: 18px;
		}
		.field label {
			display: block;
			margin-bottom: 6px;
			font-weight: 600;
		}
		.field label .optional {
			font-weight: normal;
			color: var(--vscode-descriptionForeground);
		}
		#subject, #body {
			width: 100%;
			box-sizing: border-box;
			padding: 6px 8px;
			background-color: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
			border: 1px solid var(--vscode-input-border, transparent);
			border-radius: 3px;
			font-family: inherit;
			font-size: inherit;
		}
		#body {
			resize: vertical;
			min-height: 80px;
		}
		#subject:focus, #body:focus {
			outline: 1px solid var(--vscode-focusBorder);
			outline-offset: -1px;
		}
		.checkbox-field {
			display: flex;
			gap: 8px;
			margin-bottom: 14px;
		}
		.checkbox-field input {
			margin-top: 3px;
		}
		/* Plain <input type="checkbox"> renders with the OS's native control, which is why it looked
		 * like a stray white square in dark themes — this strips that and redraws it with the same
		 * theme tokens VS Code's own tree-view checkboxes use, so it matches instead of clashing. */
		.checkbox-field input,
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
		.checkbox-field input:checked,
		.file-checkbox:checked {
			background-color: var(--vscode-checkbox-selectBackground, var(--vscode-checkbox-background, #313131));
			border-color: var(--vscode-checkbox-selectBorder, var(--vscode-checkbox-border, #6b6b6b));
		}
		.checkbox-field input:checked::after,
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
		.checkbox-field input:focus-visible,
		.file-checkbox:focus-visible {
			outline: 1px solid var(--vscode-focusBorder);
			outline-offset: 1px;
		}
		.checkbox-field .checkbox-text strong {
			display: block;
			font-weight: 600;
		}
		.checkbox-field .checkbox-text span {
			color: var(--vscode-descriptionForeground);
			font-size: 0.9em;
		}
		#error {
			color: var(--vscode-errorForeground);
			margin-bottom: 14px;
			min-height: 1em;
		}
		#buttons {
			display: flex;
			justify-content: flex-end;
			margin-top: 8px;
			margin-bottom: 24px;
		}
		button {
			padding: 6px 14px;
			border-radius: 3px;
			border: none;
			cursor: pointer;
			font-family: inherit;
			font-size: inherit;
		}
		#commitButton {
			background-color: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
		}
		#commitButton:hover:not(:disabled) {
			background-color: var(--vscode-button-hoverBackground);
		}
		#commitButton:disabled {
			opacity: 0.5;
			cursor: default;
		}
		#filesHeader {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 8px;
			margin-bottom: 10px;
			padding-top: 14px;
			border-top: 1px solid var(--vscode-panel-border);
		}
		#stats {
			color: var(--vscode-descriptionForeground);
		}
		#fileCheckActions {
			display: flex;
			gap: 4px;
			flex: 0 0 auto;
		}
		.icon-btn {
			width: 22px;
			height: 22px;
			padding: 0;
			display: flex;
			align-items: center;
			justify-content: center;
			border: 1px solid rgba(200, 200, 200, 0.4);
			border-radius: 4px;
			background: transparent;
			color: var(--vscode-icon-foreground, var(--vscode-foreground));
			font-size: 14px;
			line-height: 1;
		}
		.icon-btn:hover {
			background-color: var(--vscode-toolbar-hoverBackground);
		}
		.stat-add { color: var(--vscode-gitDecoration-addedResourceForeground, #4b4); }
		.stat-del { color: var(--vscode-gitDecoration-deletedResourceForeground, #d44); margin-left: 6px; }
		#files { display: flex; flex-direction: column; }
		.file-row {
			display: flex;
			align-items: center;
			gap: 8px;
			padding: 4px 0;
		}
		.file-status {
			display: inline-block;
			width: 1.2em;
			font-weight: bold;
			text-align: center;
			flex: 0 0 auto;
		}
		.status-A { color: var(--vscode-gitDecoration-addedResourceForeground, #4b4); }
		.status-M { color: var(--vscode-gitDecoration-modifiedResourceForeground, #d80); }
		.status-D { color: var(--vscode-gitDecoration-deletedResourceForeground, #d44); }
		.status-R, .status-C { color: var(--vscode-gitDecoration-renamedResourceForeground, #48d); }
		.file-name {
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.file-split-tag {
			color: var(--vscode-descriptionForeground);
			font-weight: normal;
		}
	</style>
</head>
<body>
	<div id="wrapper">
		<div id="card">
			<h1>Commit</h1>
			<p id="subtitle"></p>

			<div class="field">
				<label for="subject">Summary</label>
				<input id="subject" type="text" autocomplete="off" spellcheck="false" placeholder="Short summary of the change" />
			</div>

			<div class="field">
				<label for="body">Description <span class="optional">(optional)</span></label>
				<textarea id="body" rows="6" placeholder="Longer description, if needed"></textarea>
			</div>

			<label class="checkbox-field" for="amend">
				<input id="amend" type="checkbox" />
				<span class="checkbox-text">
					<strong>Amend</strong>
					<span>Replaces the last commit instead of creating a new one.</span>
				</span>
			</label>

			<div id="error"></div>

			<div id="buttons">
				<button id="commitButton" disabled>Commit</button>
			</div>

			<div id="filesHeader">
				<span id="stats"></span>
				<span id="fileCheckActions">
					<button id="checkAllButton" class="icon-btn" title="Check All" aria-label="Check All">+</button>
					<button id="uncheckAllButton" class="icon-btn" title="Uncheck All" aria-label="Uncheck All">&minus;</button>
				</span>
			</div>
			<div id="files"></div>
		</div>
	</div>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
	}
}

function getNonce(): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let text = '';
	for (let i = 0; i < 32; i++) {
		text += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return text;
}
