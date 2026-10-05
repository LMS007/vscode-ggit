import * as vscode from 'vscode';
import { GitService } from '../git/gitService';
import { CreateTagDialogState, CreateTagHostMessage, CreateTagWebviewMessage } from './createTagProtocol';

/** "Create Tag from Here" on a local branch -- a form-style panel like CreateBranchPanel, since a
 * name plus an optional message is more than one input box can hold. The commit is the branch's tip
 * as of when this opened, shown in the dialog and fixed host-side, so a branch that moves while it's
 * open (a commit, a pull) doesn't quietly change what gets tagged. */
export class CreateTagPanel {
	private static current: CreateTagPanel | undefined;

	private readonly panel: vscode.WebviewPanel;
	private readonly disposables: vscode.Disposable[] = [];
	private ready = false;
	private state: CreateTagDialogState | undefined;

	private constructor(
		context: vscode.ExtensionContext,
		private readonly gitService: GitService,
		private branch: string,
		private readonly onCreated: () => void
	) {
		this.panel = vscode.window.createWebviewPanel(
			'ggitCreateTag',
			'Create Tag',
			{ viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
			{
				enableScripts: true,
				localResourceRoots: [
					vscode.Uri.joinPath(context.extensionUri, 'dist'),
					vscode.Uri.joinPath(context.extensionUri, 'node_modules', '@vscode/codicons', 'dist'),
				],
			}
		);
		this.panel.webview.html = this.getHtml(context);
		this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
		this.panel.webview.onDidReceiveMessage((msg: CreateTagWebviewMessage) => this.handleMessage(msg), null, this.disposables);
	}

	static createOrShow(context: vscode.ExtensionContext, gitService: GitService, branch: string, onCreated: () => void): void {
		const existing = CreateTagPanel.current;
		if (existing) {
			existing.branch = branch;
			existing.panel.reveal(vscode.ViewColumn.Active, false);
			if (existing.ready) {
				void existing.sendInit();
			}
			return;
		}
		CreateTagPanel.current = new CreateTagPanel(context, gitService, branch, onCreated);
	}

	private async sendInit(): Promise<void> {
		try {
			const [tip, tags, branches] = await Promise.all([
				this.gitService.getBranchTip(this.branch),
				this.gitService.listTags(),
				this.gitService.listLocalBranches(),
			]);
			this.state = {
				branch: this.branch,
				commit: tip.sha,
				subject: tip.subject,
				existingTags: tags.map(t => t.name),
				branchNames: branches.map(b => b.name),
			};
			this.panel.title = `Create Tag on ${this.branch}`;
			this.post({ type: 'init', state: this.state });
		} catch (err) {
			this.post({ type: 'error', message: (err as Error).message });
		}
	}

	private async handleMessage(msg: CreateTagWebviewMessage): Promise<void> {
		switch (msg.type) {
			case 'ready':
				this.ready = true;
				await this.sendInit();
				break;
			case 'cancel':
				this.panel.dispose();
				break;
			case 'create': {
				const state = this.state;
				if (!state || typeof msg.name !== 'string' || typeof msg.message !== 'string') {
					return;
				}
				const name = msg.name.trim();
				try {
					// Re-checked here, not just in the webview: git allows a tag named like a branch, but
					// then every bare use of that name is ambiguous -- including this extension's own
					// History tab, which would show the tag's history when the branch is clicked.
					if (state.branchNames.includes(name)) {
						throw new Error(`There's already a branch named "${name}". Pick a different tag name so the two don't get mixed up.`);
					}
					await this.gitService.createTag(name, state.commit, msg.message.trim() || undefined);
					this.panel.dispose();
					this.onCreated();
				} catch (err) {
					this.post({ type: 'error', message: (err as Error).message });
				}
				break;
			}
		}
	}

	private post(message: CreateTagHostMessage): void {
		void this.panel.webview.postMessage(message);
	}

	private dispose(): void {
		CreateTagPanel.current = undefined;
		while (this.disposables.length) {
			this.disposables.pop()?.dispose();
		}
	}

	private getHtml(context: vscode.ExtensionContext): string {
		const webview = this.panel.webview;
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'createTagWebview.js'));
		const codiconCssUri = webview.asWebviewUri(
			vscode.Uri.joinPath(context.extensionUri, 'node_modules', '@vscode/codicons', 'dist', 'codicon.css')
		);
		const nonce = getNonce();

		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
	<title>Create Tag</title>
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
		#commit, #name, #message {
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
		/* Read-only -- the right-click already picked the commit. */
		#commit {
			display: flex;
			align-items: center;
			gap: 6px;
			overflow: hidden;
			white-space: nowrap;
		}
		#commitSha {
			font-family: var(--vscode-editor-font-family, monospace);
			flex: 0 0 auto;
		}
		#commitSubject {
			overflow: hidden;
			text-overflow: ellipsis;
		}
		#message {
			resize: vertical;
			min-height: 80px;
		}
		#name::placeholder, #message::placeholder {
			color: var(--vscode-input-placeholderForeground);
		}
		#name:focus, #message:focus {
			outline: 1px solid var(--vscode-focusBorder);
			outline-offset: -1px;
		}
		.hint {
			margin: 6px 0 0 0;
			color: var(--vscode-descriptionForeground);
			font-size: 0.9em;
		}
		#nameProblem {
			margin: 6px 0 0 0;
			color: var(--vscode-errorForeground);
			font-size: 0.9em;
		}
		#nameProblem:empty {
			display: none;
		}
		#error {
			color: var(--vscode-errorForeground);
			margin-top: 14px;
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
		button:disabled {
			opacity: 0.5;
			cursor: default;
		}
	</style>
</head>
<body>
	<div id="wrapper">
		<div id="card">
			<h1>Create Tag</h1>
			<p id="subtitle">Tags the latest commit on <strong id="branch"></strong>. The new tag is local until you publish it from the Tags view.</p>

			<div class="field">
				<label>Commit</label>
				<div id="commit"><span class="codicon codicon-git-commit"></span><span id="commitSha"></span><span id="commitSubject"></span></div>
			</div>

			<div class="field">
				<label for="name">Name</label>
				<input id="name" type="text" autocomplete="off" spellcheck="false" placeholder="v1.0.0" />
				<p id="nameProblem"></p>
			</div>

			<div class="field">
				<label for="message">Message</label>
				<textarea id="message" rows="4" placeholder="Optional"></textarea>
				<p class="hint">With a message, it's an annotated tag: it records who tagged it and when, and it's what release tools and <code>git describe</code> look for. Leave it empty for a lightweight tag, which is just a name for the commit.</p>
			</div>

			<div id="error"></div>

			<div id="buttons">
				<button id="cancelButton">Cancel</button>
				<button id="createButton" disabled>Create Tag</button>
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
