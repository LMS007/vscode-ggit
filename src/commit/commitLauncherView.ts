import * as vscode from 'vscode';
import { GitService } from '../git/gitService';

/** A tiny sidebar section sitting above Working Copy: just a big Commit button (plus a live staged-file
 * count) that opens the real Commit panel — the actual subject/body/Amend form lives there, not here.
 * Kept deliberately small rather than duplicating that whole form in the sidebar. */
export class CommitLauncherViewProvider implements vscode.WebviewViewProvider {
	private view: vscode.WebviewView | undefined;

	constructor(private readonly gitService: GitService, private readonly onOpenCommit: () => void) {}

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.view = webviewView;
		webviewView.webview.options = { enableScripts: true };
		webviewView.webview.html = this.getHtml();
		webviewView.webview.onDidReceiveMessage((msg: { type: string }) => {
			if (msg.type === 'openCommit') {
				this.onOpenCommit();
			}
		});
		void this.refresh();
	}

	/** Called from extension.ts's refreshAll, same as every other view, so the staged count here never
	 * drifts from what Working Copy and the Commit panel itself show. */
	async refresh(): Promise<void> {
		if (!this.view) {
			return;
		}
		const files = await this.gitService.getWorkingChanges();
		const count = files.filter(f => f.state === 'staged').length;
		void this.view.webview.postMessage({ type: 'stagedCount', count });
	}

	private getHtml(): string {
		const nonce = getNonce();
		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<style>
		html, body {
			margin: 0;
			padding: 8px;
			color: var(--vscode-editor-foreground);
			font-family: var(--vscode-font-family);
			font-size: var(--vscode-font-size);
		}
		#summary {
			color: var(--vscode-descriptionForeground);
			margin-bottom: 6px;
			min-height: 1.2em;
		}
		#commitButton {
			width: 100%;
			box-sizing: border-box;
			padding: 8px 0;
			font-family: inherit;
			font-size: 1.05em;
			font-weight: 600;
			border: none;
			border-radius: 4px;
			cursor: pointer;
			background-color: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
		}
		#commitButton:hover {
			background-color: var(--vscode-button-hoverBackground);
		}
	</style>
</head>
<body>
	<div id="summary">No changes staged</div>
	<button id="commitButton">Commit</button>
	<script nonce="${nonce}">
		const vscodeApi = acquireVsCodeApi();
		const summaryEl = document.getElementById('summary');
		document.getElementById('commitButton').addEventListener('click', () => {
			vscodeApi.postMessage({ type: 'openCommit' });
		});
		window.addEventListener('message', event => {
			const message = event.data;
			if (message.type === 'stagedCount') {
				summaryEl.textContent =
					message.count === 0
						? 'No changes staged'
						: message.count + (message.count === 1 ? ' file staged' : ' files staged');
			}
		});
	</script>
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
