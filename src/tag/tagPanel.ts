import * as vscode from 'vscode';
import { GitService } from '../git/gitService';
import { TagNode, TagRemoteState } from '../tree/tagsTreeProvider';
import { TagDialogMode, TagHostMessage, TagWebviewMessage } from './tagProtocol';

const TITLES: Record<TagDialogMode, string> = { publish: 'Publish Tag', push: 'Push Tag', delete: 'Delete Tag' };

/** The Publish / Push / Delete Tag dialog -- one form-style panel for all three, like MergePanel,
 * since each needs a remote picker (and Delete a checkbox) that VS Code's native dialogs can't hold.
 * Which tag, and what each remote had for it, are fixed host-side when it opens; the webview only
 * ever sends back which of the offered remotes to use. */
export class TagPanel {
	private static current: TagPanel | undefined;

	private readonly panel: vscode.WebviewPanel;
	private readonly disposables: vscode.Disposable[] = [];
	private ready = false;

	private constructor(
		context: vscode.ExtensionContext,
		private readonly gitService: GitService,
		private mode: TagDialogMode,
		private node: TagNode,
		private onDone: (remoteChanged: boolean) => void
	) {
		this.panel = vscode.window.createWebviewPanel(
			'ggitTag',
			TITLES[mode],
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
		this.panel.webview.onDidReceiveMessage((msg: TagWebviewMessage) => this.handleMessage(msg), null, this.disposables);
	}

	static createOrShow(
		context: vscode.ExtensionContext,
		gitService: GitService,
		mode: TagDialogMode,
		node: TagNode,
		onDone: (remoteChanged: boolean) => void
	): void {
		const existing = TagPanel.current;
		if (existing) {
			// Another tag action while the dialog's still open retargets it rather than opening a second.
			existing.mode = mode;
			existing.node = node;
			existing.onDone = onDone;
			existing.panel.reveal(vscode.ViewColumn.Active, false);
			if (existing.ready) {
				existing.sendInit();
			}
			return;
		}
		TagPanel.current = new TagPanel(context, gitService, mode, node, onDone);
	}

	/** Publish: remotes that don't have the tag (or couldn't be checked). Push: remotes whose copy
	 * differs -- the only case where pushing does anything. Delete: remotes that have it (or couldn't
	 * be checked). */
	private offeredRemotes(): TagRemoteState[] {
		const { local, remotes } = this.node;
		switch (this.mode) {
			case 'publish':
				return remotes.filter(r => !r.known || !r.tag);
			case 'push':
				return remotes.filter(r => r.tag && local && r.tag.sha !== local.sha);
			case 'delete':
				return remotes.filter(r => !r.known || r.tag);
		}
	}

	private sendInit(): void {
		this.panel.title = `${TITLES[this.mode]} ${this.node.name}`;
		const { local } = this.node;
		this.post({
			type: 'init',
			state: {
				mode: this.mode,
				tagName: this.node.name,
				local: local && { commit: local.commit, subject: local.subject },
				remotes: this.offeredRemotes().map(r => ({ name: r.remote, known: r.known, commit: r.tag?.commit })),
			},
		});
	}

	private async handleMessage(msg: TagWebviewMessage): Promise<void> {
		switch (msg.type) {
			case 'ready':
				this.ready = true;
				this.sendInit();
				break;
			case 'cancel':
				this.panel.dispose();
				break;
			case 'submit': {
				const target = msg.remote === undefined ? undefined : this.offeredRemotes().find(r => r.remote === msg.remote);
				if (msg.remote !== undefined && !target) {
					return;
				}
				const { name, local } = this.node;
				try {
					await vscode.window.withProgress(
						{ location: vscode.ProgressLocation.Notification, title: `${TITLES[this.mode]} ${name}…` },
						() => this.run(name, local !== undefined, target)
					);
					this.panel.dispose();
					this.onDone(target !== undefined);
				} catch (err) {
					this.post({ type: 'error', message: explainPushError((err as Error).message, target?.remote, name) });
				}
				break;
			}
		}
	}

	private async run(name: string, hasLocal: boolean, target: TagRemoteState | undefined): Promise<void> {
		switch (this.mode) {
			case 'publish':
				if (!target) {
					throw new Error('Choose a remote to publish to.');
				}
				await this.gitService.pushTag(target.remote, name);
				return;
			case 'push':
				if (!target?.tag) {
					throw new Error('Choose a remote to push to.');
				}
				await this.gitService.pushTag(target.remote, name, { replacing: target.tag.sha });
				return;
			case 'delete':
				if (!target && !hasLocal) {
					throw new Error('Choose the remote to delete it from.');
				}
				// Remote first: if that fails (offline, no permission), the local tag is still there to
				// retry with, rather than half-done with nothing left to point at.
				if (target) {
					await this.gitService.deleteRemoteTag(target.remote, name);
				}
				if (hasLocal) {
					await this.gitService.deleteTag(name);
				}
				return;
		}
	}

	private post(message: TagHostMessage): void {
		void this.panel.webview.postMessage(message);
	}

	private dispose(): void {
		TagPanel.current = undefined;
		while (this.disposables.length) {
			this.disposables.pop()?.dispose();
		}
	}

	private getHtml(context: vscode.ExtensionContext): string {
		const webview = this.panel.webview;
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'tagWebview.js'));
		const codiconCssUri = webview.asWebviewUri(
			vscode.Uri.joinPath(context.extensionUri, 'node_modules', '@vscode/codicons', 'dist', 'codicon.css')
		);
		const nonce = getNonce();

		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
	<title>Tag</title>
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
		.field[hidden] {
			display: none;
		}
		.field label {
			display: block;
			margin-bottom: 6px;
			font-weight: 600;
		}
		/* Read-only -- the right-click already picked the tag -- styled like the other dialogs' inputs. */
		#tagName, #remote {
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
		#tagName {
			display: flex;
			align-items: center;
			gap: 6px;
			overflow: hidden;
			white-space: nowrap;
		}
		#remote:focus {
			outline: 1px solid var(--vscode-focusBorder);
			outline-offset: -1px;
		}
		#remote:disabled {
			opacity: 0.55;
		}
		#tagDetail {
			margin: 6px 0 0 0;
			color: var(--vscode-descriptionForeground);
			font-size: 0.9em;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.sha {
			font-family: var(--vscode-editor-font-family, monospace);
		}
		#warning {
			display: flex;
			gap: 8px;
			margin: 0 0 18px 0;
			padding: 8px 10px;
			border-radius: 3px;
			border: 1px solid var(--vscode-inputValidation-warningBorder, #b89500);
			background-color: var(--vscode-inputValidation-warningBackground, transparent);
		}
		#warning[hidden] {
			display: none;
		}
		#warning .codicon {
			color: var(--vscode-editorWarning-foreground, #cca700);
			margin-top: 1px;
		}
		.checkbox-field {
			display: flex;
			gap: 8px;
			margin-bottom: 14px;
		}
		.checkbox-field[hidden] {
			display: none;
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
		#note {
			margin: 0 0 18px 0;
			color: var(--vscode-descriptionForeground);
			font-size: 0.9em;
		}
		#note:empty {
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
		#submitButton {
			background-color: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
		}
		#submitButton:hover:not(:disabled) {
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
			<h1 id="title"></h1>
			<p id="subtitle"></p>

			<div class="field">
				<label>Tag</label>
				<div id="tagName"><span class="codicon codicon-tag"></span><span id="tagNameText"></span></div>
				<p id="tagDetail"></p>
			</div>

			<div id="warning" hidden>
				<span class="codicon codicon-warning"></span>
				<span id="warningText"></span>
			</div>

			<label class="checkbox-field" id="deleteRemoteField" for="deleteRemote" hidden>
				<input id="deleteRemote" type="checkbox" />
				<span class="checkbox-text">
					<strong id="deleteRemoteLabel"></strong>
					<span id="deleteRemoteDesc"></span>
				</span>
			</label>

			<div class="field" id="remoteField" hidden>
				<label for="remote">Remote</label>
				<select id="remote"></select>
			</div>

			<p id="note"></p>

			<div id="error"></div>

			<div id="buttons">
				<button id="cancelButton">Cancel</button>
				<button id="submitButton" disabled></button>
			</div>
		</div>
	</div>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
	}
}

/** git's own wording for the two rejections this dialog can actually run into only makes sense if
 * you already know how tag pushes work -- both mean the Tags view's picture of the remote is out of
 * date, which is what's worth saying instead. Anything else passes through untouched. */
function explainPushError(message: string, remote: string | undefined, name: string): string {
	if (/\(stale info\)/.test(message)) {
		return `${remote}'s "${name}" changed since GGit last checked it, so it wasn't overwritten. Refresh the Tags view to see what it is now.`;
	}
	if (/\(already exists\)/.test(message)) {
		return `${remote} already has a tag named "${name}". Refresh the Tags view; if it's different from yours, Push Tag can overwrite it.`;
	}
	return message;
}

function getNonce(): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let text = '';
	for (let i = 0; i < 32; i++) {
		text += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return text;
}
