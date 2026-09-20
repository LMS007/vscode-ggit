import * as vscode from 'vscode';
import { openDiffForFile } from '../diff/openDiff';
import { GitService } from '../git/gitService';
import { ChangedFile } from '../git/types';
import { CommitFilesHostMessage, CommitFilesWebviewMessage } from './commitFilesProtocol';

/** A minimal, files-only companion to the diff editor — lets you click through a commit's other files without the full branch/commit browser. */
export class CommitFilesPanel {
	private static current: CommitFilesPanel | undefined;

	private readonly panel: vscode.WebviewPanel;
	private readonly disposables: vscode.Disposable[] = [];
	private ready = false;
	private sha: string;
	private commitMessage: string;
	private files: ChangedFile[];
	private selectedIndex: number;

	private constructor(
		context: vscode.ExtensionContext,
		private readonly gitService: GitService,
		sha: string,
		commitMessage: string,
		files: ChangedFile[],
		selectedIndex: number
	) {
		this.sha = sha;
		this.commitMessage = commitMessage;
		this.files = files;
		this.selectedIndex = selectedIndex;
		this.panel = vscode.window.createWebviewPanel(
			'ggitCommitFiles',
			`Files: ${sha.slice(0, 7)}`,
			{ viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')],
			}
		);
		this.panel.webview.html = this.getHtml(context);
		this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
		this.panel.webview.onDidReceiveMessage((msg: CommitFilesWebviewMessage) => this.handleMessage(msg), null, this.disposables);
	}

	static showForCommit(
		context: vscode.ExtensionContext,
		gitService: GitService,
		sha: string,
		commitMessage: string,
		files: ChangedFile[],
		selectedIndex: number
	): void {
		if (CommitFilesPanel.current) {
			CommitFilesPanel.current.update(sha, commitMessage, files, selectedIndex);
		} else {
			CommitFilesPanel.current = new CommitFilesPanel(context, gitService, sha, commitMessage, files, selectedIndex);
		}
		CommitFilesPanel.current.panel.reveal(vscode.ViewColumn.Beside, true);
	}

	/** Closes the companion panel — called when the main History panel regains focus, since its file list makes this one redundant. */
	static closeIfOpen(): void {
		CommitFilesPanel.current?.panel.dispose();
	}

	private update(sha: string, commitMessage: string, files: ChangedFile[], selectedIndex: number): void {
		this.sha = sha;
		this.commitMessage = commitMessage;
		this.files = files;
		this.selectedIndex = selectedIndex;
		this.panel.title = `Files: ${sha.slice(0, 7)}`;
		this.post();
	}

	private post(): void {
		if (!this.ready) {
			return;
		}
		const message: CommitFilesHostMessage = {
			type: 'files',
			sha: this.sha,
			commitMessage: this.commitMessage,
			files: this.files,
			selectedIndex: this.selectedIndex,
		};
		void this.panel.webview.postMessage(message);
	}

	private async handleMessage(msg: CommitFilesWebviewMessage): Promise<void> {
		switch (msg.type) {
			case 'ready':
				this.ready = true;
				this.post();
				break;
			case 'selectFile':
				this.selectedIndex = msg.index;
				try {
					await openDiffForFile(this.gitService, this.sha, this.files[msg.index]);
				} catch (err) {
					vscode.window.showErrorMessage(`Failed to open diff: ${(err as Error).message}`);
				}
				break;
		}
	}

	private dispose(): void {
		CommitFilesPanel.current = undefined;
		while (this.disposables.length) {
			this.disposables.pop()?.dispose();
		}
	}

	private getHtml(context: vscode.ExtensionContext): string {
		const webview = this.panel.webview;
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'commitFilesWebview.js'));
		const nonce = getNonce();

		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<title>Commit Files</title>
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
		#header {
			padding: 8px 10px;
			border-bottom: 1px solid var(--vscode-panel-border);
			font-weight: 600;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		#files {
			overflow-y: auto;
			padding: 4px 0;
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
	<div id="header"></div>
	<div id="files"><div class="empty">Loading files…</div></div>
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
