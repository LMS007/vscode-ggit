import * as vscode from 'vscode';
import { GitService } from '../git/gitService';
import { AddRemoteHostMessage, AddRemoteWebviewMessage } from './addRemoteProtocol';

/** A form-style companion panel for `git remote add`, since VS Code has no native multi-field dialog
 * (only single-input boxes and quick picks) -- same convention as CreateBranchPanel. */
export class AddRemotePanel {
	private static current: AddRemotePanel | undefined;

	private readonly panel: vscode.WebviewPanel;
	private readonly disposables: vscode.Disposable[] = [];

	private constructor(
		context: vscode.ExtensionContext,
		private readonly gitService: GitService,
		private readonly onAdded: () => void
	) {
		this.panel = vscode.window.createWebviewPanel(
			'ggitAddRemote',
			'Add Remote',
			{ viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
			{
				enableScripts: true,
				localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')],
			}
		);
		this.panel.webview.html = this.getHtml(context);
		this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
		this.panel.webview.onDidReceiveMessage((msg: AddRemoteWebviewMessage) => this.handleMessage(msg), null, this.disposables);
	}

	static createOrShow(context: vscode.ExtensionContext, gitService: GitService, onAdded: () => void): void {
		if (AddRemotePanel.current) {
			AddRemotePanel.current.panel.reveal(vscode.ViewColumn.Active, false);
			return;
		}
		AddRemotePanel.current = new AddRemotePanel(context, gitService, onAdded);
	}

	private async handleMessage(msg: AddRemoteWebviewMessage): Promise<void> {
		switch (msg.type) {
			case 'cancel':
				this.panel.dispose();
				break;
			case 'add':
				try {
					await this.gitService.addRemote(msg.name, msg.url);
					this.onAdded();
					this.panel.dispose();
					// Best-effort -- the remote is already configured at this point even if the network
					// fetch itself fails (bad URL, auth, offline, ...), so that failure is a toast, not
					// something that should undo the "Add Remote" the user just successfully did.
					try {
						await this.gitService.fetch(msg.name);
						this.onAdded();
					} catch (err) {
						vscode.window.showWarningMessage(
							`GGit: Added remote "${msg.name}", but fetching it failed: ${(err as Error).message}`
						);
					}
				} catch (err) {
					this.post({ type: 'error', message: (err as Error).message });
				}
				break;
		}
	}

	private post(message: AddRemoteHostMessage): void {
		void this.panel.webview.postMessage(message);
	}

	private dispose(): void {
		AddRemotePanel.current = undefined;
		while (this.disposables.length) {
			this.disposables.pop()?.dispose();
		}
	}

	private getHtml(context: vscode.ExtensionContext): string {
		const webview = this.panel.webview;
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'addRemoteWebview.js'));
		const nonce = getNonce();

		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<title>Add Remote</title>
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
			max-width: 480px;
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
			display: flex;
			align-items: center;
		}
		.field label {
			flex: 0 0 100px;
			font-weight: 600;
		}
		.field input {
			flex: 1 1 auto;
			box-sizing: border-box;
			padding: 6px 8px;
			background-color: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
			border: 1px solid var(--vscode-input-border, transparent);
			border-radius: 3px;
			font-family: inherit;
			font-size: inherit;
		}
		.field input::placeholder {
			color: var(--vscode-input-placeholderForeground);
		}
		.field input:focus {
			outline: 1px solid var(--vscode-focusBorder);
			outline-offset: -1px;
		}
		#error {
			color: var(--vscode-errorForeground);
			margin-bottom: 14px;
			min-height: 1em;
		}
		#buttons {
			display: flex;
			justify-content: flex-end;
			gap: 8px;
			margin-top: 24px;
		}
		button {
			padding: 6px 14px;
			border-radius: 3px;
			border: none;
			cursor: pointer;
			font-family: inherit;
			font-size: inherit;
		}
		#cancelButton {
			background-color: var(--vscode-button-secondaryBackground);
			color: var(--vscode-button-secondaryForeground);
		}
		#cancelButton:hover {
			background-color: var(--vscode-button-secondaryHoverBackground);
		}
		#addButton {
			background-color: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
		}
		#addButton:hover:not(:disabled) {
			background-color: var(--vscode-button-hoverBackground);
		}
		#addButton:disabled {
			opacity: 0.5;
			cursor: default;
		}
	</style>
</head>
<body>
	<div id="wrapper">
		<div id="card">
			<h1>Add Remote</h1>
			<p id="subtitle">Adds a new remote this repo can fetch from and push to -- SSH or HTTPS both work.</p>

			<div class="field">
				<label for="name">Name:</label>
				<input id="name" type="text" autocomplete="off" spellcheck="false" placeholder="Remote Name" />
			</div>

			<div class="field">
				<label for="url">Remote URL:</label>
				<input id="url" type="text" autocomplete="off" spellcheck="false" placeholder="ssh://example.com/repo.git" />
			</div>

			<div id="error"></div>

			<div id="buttons">
				<button id="cancelButton">Cancel</button>
				<button id="addButton" disabled>Add Remote</button>
			</div>
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
