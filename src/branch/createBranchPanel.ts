import * as vscode from 'vscode';
import { GitService } from '../git/gitService';
import { CreateBranchHostMessage, CreateBranchWebviewMessage } from './createBranchProtocol';

/** A form-style companion panel for `git branch`/`git checkout -b`, since VS Code has no native
 * multi-field dialog (only single-input boxes and quick picks). */
export class CreateBranchPanel {
	private static current: CreateBranchPanel | undefined;

	private readonly panel: vscode.WebviewPanel;
	private readonly disposables: vscode.Disposable[] = [];
	private ready = false;

	private constructor(
		context: vscode.ExtensionContext,
		private readonly gitService: GitService,
		private readonly onCreated: () => void,
		private startPoint: string | undefined
	) {
		this.panel = vscode.window.createWebviewPanel(
			'ggitCreateBranch',
			'Create New Branch',
			{ viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
			{
				enableScripts: true,
				localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')],
			}
		);
		this.panel.webview.html = this.getHtml(context);
		this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
		this.panel.webview.onDidReceiveMessage((msg: CreateBranchWebviewMessage) => this.handleMessage(msg), null, this.disposables);
	}

	static createOrShow(
		context: vscode.ExtensionContext,
		gitService: GitService,
		onCreated: () => void,
		startPoint?: string
	): void {
		if (CreateBranchPanel.current) {
			CreateBranchPanel.current.panel.reveal(vscode.ViewColumn.Active, false);
			if (startPoint) {
				CreateBranchPanel.current.startPoint = startPoint;
				void CreateBranchPanel.current.sendInit();
			}
			return;
		}
		CreateBranchPanel.current = new CreateBranchPanel(context, gitService, onCreated, startPoint);
	}

	private async sendInit(): Promise<void> {
		const [branches, currentBranch] = await Promise.all([
			this.gitService.listLocalBranches(),
			this.gitService.getCurrentBranch(),
		]);
		this.post({
			type: 'init',
			branches: branches.map(b => b.name),
			currentBranch: this.startPoint ?? currentBranch ?? branches.find(b => b.isHead)?.name ?? '',
		});
	}

	private async handleMessage(msg: CreateBranchWebviewMessage): Promise<void> {
		switch (msg.type) {
			case 'ready':
				this.ready = true;
				await this.sendInit();
				break;
			case 'cancel':
				this.panel.dispose();
				break;
			case 'create':
				try {
					await this.gitService.createBranch(msg.name, msg.startPoint, { track: msg.track, checkout: msg.checkout });
					this.onCreated();
					this.panel.dispose();
				} catch (err) {
					this.post({ type: 'error', message: (err as Error).message });
				}
				break;
		}
	}

	private post(message: CreateBranchHostMessage): void {
		void this.panel.webview.postMessage(message);
	}

	private dispose(): void {
		CreateBranchPanel.current = undefined;
		while (this.disposables.length) {
			this.disposables.pop()?.dispose();
		}
	}

	private getHtml(context: vscode.ExtensionContext): string {
		const webview = this.panel.webview;
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'createBranchWebview.js'));
		const nonce = getNonce();

		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<title>Create New Branch</title>
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
		}
		.field label {
			display: block;
			margin-bottom: 6px;
			font-weight: 600;
		}
		#name, #startPoint {
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
		#name:focus, #startPoint:focus {
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
		#createButton {
			background-color: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
		}
		#createButton:hover:not(:disabled) {
			background-color: var(--vscode-button-hoverBackground);
		}
		#createButton:disabled {
			opacity: 0.5;
			cursor: default;
		}
	</style>
</head>
<body>
	<div id="wrapper">
		<div id="card">
			<h1>Create New Branch</h1>
			<p id="subtitle">Creates a new local branch starting at the given revision.</p>

			<div class="field">
				<label for="name">Name</label>
				<input id="name" type="text" autocomplete="off" spellcheck="false" />
			</div>

			<div class="field">
				<label for="startPoint">Starting Point</label>
				<select id="startPoint"></select>
			</div>

			<label class="checkbox-field" for="track">
				<input id="track" type="checkbox" />
				<span class="checkbox-text">
					<strong>Track Branch</strong>
					<span>The new branch will automatically push to and pull from the starting point branch.</span>
				</span>
			</label>

			<label class="checkbox-field" for="checkout">
				<input id="checkout" type="checkbox" />
				<span class="checkbox-text">
					<strong>Check Out Branch</strong>
					<span>Directly checks out the new branch after it was created.</span>
				</span>
			</label>

			<div id="error"></div>

			<div id="buttons">
				<button id="cancelButton">Cancel</button>
				<button id="createButton" disabled>Create Branch</button>
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
