import * as vscode from 'vscode';
import { openDiffForFile } from '../diff/openDiff';
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
					await openDiffForFile(this.gitService, msg.sha, msg.file);
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
		}
		#commits { flex: 1 1 60%; border-right: 1px solid var(--vscode-panel-border); }
		#files { flex: 1 1 40%; }
		.row {
			padding: 4px 10px;
			cursor: pointer;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}
		.row:hover { background-color: var(--vscode-list-hoverBackground); }
		.row.selected {
			background-color: var(--vscode-list-activeSelectionBackground);
			color: var(--vscode-list-activeSelectionForeground);
		}
		.commit-hash {
			color: var(--vscode-descriptionForeground);
			margin-right: 6px;
			font-family: var(--vscode-editor-font-family, monospace);
		}
		.commit-meta {
			color: var(--vscode-descriptionForeground);
			font-size: 0.9em;
			margin-top: 2px;
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
