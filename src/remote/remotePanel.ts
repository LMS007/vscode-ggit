import * as vscode from 'vscode';
import { GitService } from '../git/gitService';
import { RemoteDialogState, RemoteHostMessage, RemoteWebviewMessage } from './remoteProtocol';

/** The Add Remote / Edit Remote form -- a companion panel since VS Code has no native multi-field
 * dialog (only single-input boxes and quick picks), same convention as CreateBranchPanel. Edit opens
 * on one remote's name and URLs as configured when it was right-clicked. */
export class RemotePanel {
	private static current: RemotePanel | undefined;

	private readonly panel: vscode.WebviewPanel;
	private readonly disposables: vscode.Disposable[] = [];

	private constructor(
		context: vscode.ExtensionContext,
		private readonly gitService: GitService,
		private readonly onSaved: () => void,
		/** Undefined for Add. For Edit, what a Save diffs against -- kept current as each step of a save
		 * goes through, so retrying after a partial failure only redoes what's still different. */
		private readonly editing: RemoteDialogState | undefined
	) {
		this.panel = vscode.window.createWebviewPanel(
			'ggitRemote',
			editing ? `Edit Remote: ${editing.name}` : 'Add Remote',
			{ viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
			{
				enableScripts: true,
				localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')],
			}
		);
		this.panel.webview.html = this.getHtml(context);
		this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
		this.panel.webview.onDidReceiveMessage((msg: RemoteWebviewMessage) => this.handleMessage(msg), null, this.disposables);
	}

	/** Reveals the open dialog if it's already for the same thing (Add, or editing that same remote);
	 * otherwise replaces it, rather than stacking a second remote form. */
	static createOrShow(
		context: vscode.ExtensionContext,
		gitService: GitService,
		onSaved: () => void,
		editing?: RemoteDialogState
	): void {
		const existing = RemotePanel.current;
		if (existing && existing.editing?.name === editing?.name) {
			existing.panel.reveal(vscode.ViewColumn.Active, false);
			return;
		}
		existing?.panel.dispose();
		RemotePanel.current = new RemotePanel(context, gitService, onSaved, editing);
	}

	private async handleMessage(msg: RemoteWebviewMessage): Promise<void> {
		switch (msg.type) {
			case 'ready':
				this.post({ type: 'init', state: this.editing ?? { name: '', url: '', pushUrl: '' } });
				break;
			case 'cancel':
				this.panel.dispose();
				break;
			case 'submit':
				try {
					if (this.editing) {
						await this.saveEdits(this.editing, msg.state);
						this.panel.dispose();
					} else {
						await this.add(msg.state);
					}
				} catch (err) {
					this.post({ type: 'error', message: (err as Error).message });
				}
				break;
		}
	}

	private async add({ name, url }: RemoteDialogState): Promise<void> {
		await this.gitService.addRemote(name, url);
		this.onSaved();
		this.panel.dispose();
		// Best-effort -- the remote is already configured at this point even if the network
		// fetch itself fails (bad URL, auth, offline, ...), so that failure is a toast, not
		// something that should undo the "Add Remote" the user just successfully did.
		try {
			await this.gitService.fetch(name);
			this.onSaved();
		} catch (err) {
			vscode.window.showWarningMessage(`GGit: Added remote "${name}", but fetching it failed: ${(err as Error).message}`);
		}
	}

	/** Writes only what changed, renaming first so the URL changes land on the remote's new name. No
	 * fetch afterwards, unlike Add: the remote's branches are already here, and a URL fix is often for
	 * a host that's moved or isn't reachable yet. */
	private async saveEdits(editing: RemoteDialogState, next: RemoteDialogState): Promise<void> {
		let changed = false;
		try {
			if (next.name !== editing.name) {
				await this.gitService.renameRemote(editing.name, next.name);
				editing.name = next.name;
				changed = true;
			}
			if (next.url !== editing.url) {
				await this.gitService.setRemoteUrl(editing.name, next.url);
				editing.url = next.url;
				changed = true;
			}
			if (next.pushUrl !== editing.pushUrl) {
				await this.gitService.setRemotePushUrl(editing.name, next.pushUrl || undefined);
				editing.pushUrl = next.pushUrl;
				changed = true;
			}
		} finally {
			// Also after a later step fails -- a rename that already went through still has to show.
			if (changed) {
				this.onSaved();
			}
		}
	}

	private post(message: RemoteHostMessage): void {
		void this.panel.webview.postMessage(message);
	}

	private dispose(): void {
		// createOrShow may already have put a replacement in `current` by the time this one's dispose lands.
		if (RemotePanel.current === this) {
			RemotePanel.current = undefined;
		}
		while (this.disposables.length) {
			this.disposables.pop()?.dispose();
		}
	}

	private getHtml(context: vscode.ExtensionContext): string {
		const webview = this.panel.webview;
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'remoteWebview.js'));
		const nonce = getNonce();
		// Only fixed text goes into the markup -- the remote's own name and URLs arrive via the 'init'
		// message (see handleMessage), so nothing user-controlled ever needs HTML-escaping here.
		const title = this.editing ? 'Edit Remote' : 'Add Remote';
		const subtitle = this.editing
			? 'Renaming also renames its remote branches and keeps every local branch tracking it pointed at the new name.'
			: 'Adds a new remote this repo can fetch from and push to -- SSH or HTTPS both work.';
		const pushUrlField = this.editing
			? /* html */ `
			<div class="field">
				<label for="pushUrl">Push URL:</label>
				<input id="pushUrl" type="text" autocomplete="off" spellcheck="false" placeholder="Same as Remote URL" />
			</div>`
			: '';

		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<title>${title}</title>
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
		#submitButton {
			background-color: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
		}
		#submitButton:hover:not(:disabled) {
			background-color: var(--vscode-button-hoverBackground);
		}
		#submitButton:disabled {
			opacity: 0.5;
			cursor: default;
		}
	</style>
</head>
<body>
	<div id="wrapper">
		<div id="card">
			<h1>${title}</h1>
			<p id="subtitle">${subtitle}</p>

			<div class="field">
				<label for="name">Name:</label>
				<input id="name" type="text" autocomplete="off" spellcheck="false" placeholder="Remote Name" />
			</div>

			<div class="field">
				<label for="url">Remote URL:</label>
				<input id="url" type="text" autocomplete="off" spellcheck="false" placeholder="ssh://example.com/repo.git" />
			</div>
${pushUrlField}

			<div id="error"></div>

			<div id="buttons">
				<button id="cancelButton">Cancel</button>
				<button id="submitButton" disabled>${this.editing ? 'Save' : 'Add Remote'}</button>
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
