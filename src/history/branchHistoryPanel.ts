import * as vscode from 'vscode';
import { openDiffForCommit } from '../diff/openDiff';
import { GitService } from '../git/gitService';
import { HostMessage, WebviewMessage } from './protocol';

export class BranchHistoryPanel {
	private static current: BranchHistoryPanel | undefined;

	private readonly panel: vscode.WebviewPanel;
	private readonly disposables: vscode.Disposable[] = [];
	private branchName: string;
	private ready = false;

	private constructor(context: vscode.ExtensionContext, private readonly gitService: GitService, branchName: string) {
		this.branchName = branchName;
		this.panel = vscode.window.createWebviewPanel(
			'ggitBranchHistory',
			`History: ${branchName}`,
			vscode.ViewColumn.Active,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')],
			}
		);
		this.panel.webview.html = this.getHtml(context);
		this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
		this.panel.webview.onDidReceiveMessage((msg: WebviewMessage) => this.handleMessage(msg), null, this.disposables);
	}

	static createOrShow(context: vscode.ExtensionContext, gitService: GitService, branchName: string): void {
		if (BranchHistoryPanel.current) {
			BranchHistoryPanel.current.showBranch(branchName);
			return;
		}
		BranchHistoryPanel.current = new BranchHistoryPanel(context, gitService, branchName);
	}

	/** Reloads the currently open history tab, if any — call after a successful fetch/pull. */
	static refreshIfOpen(): void {
		void BranchHistoryPanel.current?.loadCommits();
	}

	private showBranch(branchName: string): void {
		this.branchName = branchName;
		this.panel.title = `History: ${branchName}`;
		this.panel.reveal(vscode.ViewColumn.Active);
		void this.loadCommits();
	}

	private async loadCommits(): Promise<void> {
		if (!this.ready) {
			return;
		}
		try {
			const commits = await this.gitService.getLog(this.branchName);
			this.post({ type: 'commits', branchName: this.branchName, commits });
		} catch (err) {
			this.post({ type: 'error', message: (err as Error).message });
		}
	}

	private async handleMessage(msg: WebviewMessage): Promise<void> {
		switch (msg.type) {
			case 'ready':
				this.ready = true;
				await this.loadCommits();
				break;
			case 'selectCommit':
				try {
					const files = await this.gitService.getCommitFiles(msg.sha);
					this.post({ type: 'files', sha: msg.sha, files });
				} catch (err) {
					this.post({ type: 'error', message: (err as Error).message });
				}
				break;
			case 'openDiff':
				try {
					await openDiffForCommit(this.gitService, msg.sha, msg.files);
				} catch (err) {
					vscode.window.showErrorMessage(`Failed to open diff: ${(err as Error).message}`);
				}
				break;
		}
	}

	private post(message: HostMessage): void {
		void this.panel.webview.postMessage(message);
	}

	private dispose(): void {
		BranchHistoryPanel.current = undefined;
		while (this.disposables.length) {
			this.disposables.pop()?.dispose();
		}
	}

	private getHtml(context: vscode.ExtensionContext): string {
		const webview = this.panel.webview;
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview.js'));
		const nonce = getNonce();

		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<title>Branch History</title>
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
		#layout {
			display: flex;
			height: 100vh;
			box-sizing: border-box;
		}
		.pane {
			overflow-y: auto;
			height: 100%;
			box-sizing: border-box;
			padding: 4px 0;
			min-width: 120px;
		}
		#commits { flex: 0 0 60%; }
		#files { flex: 1 1 auto; }
		#splitter {
			flex: 0 0 4px;
			cursor: col-resize;
			background-color: var(--vscode-panel-border);
		}
		#splitter:hover, #splitter.dragging {
			background-color: var(--vscode-focusBorder);
		}
		.row {
			padding: 6px 10px;
			margin: 2px 8px;
			border-radius: 6px;
			cursor: pointer;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}
		.row:hover { background-color: var(--vscode-list-hoverBackground); }
		.row.selected {
			background-color: var(--vscode-badge-background, #3b82f6);
			color: var(--vscode-badge-foreground, #ffffff);
		}
		.row.selected .commit-author,
		.row.selected .commit-date,
		.row.selected .commit-hash,
		.row.selected .commit-title {
			color: var(--vscode-badge-foreground, #ffffff);
		}
		.commit-row-wrapper {
			display: flex;
			align-items: stretch;
		}
		.commit-graph {
			flex: 0 0 24px;
			position: relative;
			display: flex;
			align-items: center;
			justify-content: center;
		}
		.commit-graph-line {
			position: absolute;
			top: 0;
			bottom: 0;
			left: 50%;
			width: 2px;
			transform: translateX(-50%);
			background-color: var(--vscode-charts-blue, #3b82f6);
			opacity: 0.6;
		}
		.commit-row-wrapper:first-child .commit-graph-line { top: 50%; }
		.commit-row-wrapper:last-child .commit-graph-line { bottom: 50%; }
		.commit-graph-dot {
			position: relative;
			width: 10px;
			height: 10px;
			border-radius: 50%;
			background-color: var(--vscode-editor-background, #1e1e1e);
			border: 2px solid var(--vscode-charts-blue, #3b82f6);
			z-index: 1;
		}
		.commit-row {
			display: flex;
			flex-direction: column;
			gap: 2px;
			flex: 1 1 auto;
			min-width: 0;
			width: 100%;
		}
		.commit-row::after {
			content: '';
			display: block;
			height: 1px;
			margin-top: 6px;
			margin-left: -10px;
			margin-right: -10px;
			margin-bottom: -6px;
			background-color: var(--vscode-panel-border);
			opacity: 0.6;
		}
		.commit-line1 {
			display: flex;
			align-items: center;
			gap: 6px;
		}
		.commit-author {
			font-weight: normal;
			color: var(--vscode-foreground);
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
			flex: 1 1 auto;
			min-width: 30px;
		}
		.commit-refs {
			display: flex;
			gap: 4px;
			flex: 0 1 auto;
			overflow: hidden;
		}
		.commit-date {
			flex: 0 0 auto;
			margin-left: auto;
			color: var(--vscode-descriptionForeground);
			font-size: 0.85em;
			padding-left: 6px;
		}
		.commit-line2 {
			display: flex;
			align-items: baseline;
			gap: 6px;
			overflow: hidden;
		}
		.commit-hash {
			color: var(--vscode-descriptionForeground);
			font-family: var(--vscode-editor-font-family, monospace);
			flex: 0 0 auto;
		}
		.commit-title {
			font-weight: 600;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.ref-badge {
			display: inline-block;
			padding: 0 5px;
			border-radius: 3px;
			font-size: 0.75em;
			font-weight: 600;
			line-height: 1.6;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}
		.ref-badge-local {
			background-color: var(--vscode-badge-background, #3b82f6);
			color: var(--vscode-badge-foreground, #fff);
		}
		.ref-badge-remote {
			background-color: var(--vscode-descriptionForeground, #8a8a8a);
			color: var(--vscode-editor-background, #1e1e1e);
		}
		.ref-badge-tag {
			background-color: var(--vscode-gitDecoration-addedResourceForeground, #4b4);
			color: var(--vscode-editor-background, #1e1e1e);
		}
		.file-status {
			display: inline-block;
			width: 1.2em;
			font-weight: bold;
			text-align: center;
		}
		.status-A { color: var(--vscode-gitDecoration-addedResourceForeground, #4b4); }
		.status-M { color: var(--vscode-gitDecoration-modifiedResourceForeground, #d80); }
		.status-D { color: var(--vscode-gitDecoration-deletedResourceForeground, #d44); }
		.status-R, .status-C { color: var(--vscode-gitDecoration-renamedResourceForeground, #48d); }
		.file-row {
			display: flex;
			align-items: center;
			gap: 6px;
		}
		.file-name {
			flex: 1 1 auto;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.file-stats {
			flex: 0 0 auto;
			font-family: var(--vscode-editor-font-family, monospace);
			font-size: 0.9em;
			white-space: nowrap;
		}
		.stat-add { color: var(--vscode-gitDecoration-addedResourceForeground, #4b4); }
		.stat-del { color: var(--vscode-gitDecoration-deletedResourceForeground, #d44); margin-left: 4px; }
		.stat-binary { color: var(--vscode-descriptionForeground); font-style: italic; }
		.empty {
			padding: 10px;
			color: var(--vscode-descriptionForeground);
			font-style: italic;
		}
	</style>
</head>
<body>
	<div id="layout">
		<div id="commits" class="pane"><div class="empty">Loading commits…</div></div>
		<div id="splitter"></div>
		<div id="files" class="pane"><div class="empty">Select a commit to see its changed files.</div></div>
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
