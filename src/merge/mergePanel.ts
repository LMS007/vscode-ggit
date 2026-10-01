import * as vscode from 'vscode';
import { GitService } from '../git/gitService';
import { MergeAnalysis } from '../git/types';
import { MergeHostMessage, MergeWebviewMessage } from './mergeProtocol';

/** The Merge dialog -- a form-style panel like CreateBranchPanel, since VS Code has no native
 * multi-field dialog. Opened from a branch drag-and-drop (see startMerge in extension.ts) whenever the
 * merge needs a real merge commit, or when a fast-forward's confirmation asked for its options. Once a
 * merge runs, this closes; if it stopped on conflicts (or --no-commit), the Conflicts tab takes over
 * from there on its own (see updateConflictContext in extension.ts). */
export class MergePanel {
	private static current: MergePanel | undefined;

	private readonly panel: vscode.WebviewPanel;
	private readonly disposables: vscode.Disposable[] = [];
	private ready = false;

	private constructor(
		context: vscode.ExtensionContext,
		private readonly gitService: GitService,
		private sourceBranch: string,
		private intoBranch: string,
		private analysis: MergeAnalysis,
		private readonly onMerged: () => void
	) {
		this.panel = vscode.window.createWebviewPanel(
			'ggitMerge',
			'Merge',
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
		this.panel.webview.onDidReceiveMessage((msg: MergeWebviewMessage) => this.handleMessage(msg), null, this.disposables);
	}

	static createOrShow(
		context: vscode.ExtensionContext,
		gitService: GitService,
		sourceBranch: string,
		intoBranch: string,
		analysis: MergeAnalysis,
		onMerged: () => void
	): void {
		const existing = MergePanel.current;
		if (existing) {
			// A second drag while the dialog's still open retargets it rather than opening another.
			existing.sourceBranch = sourceBranch;
			existing.intoBranch = intoBranch;
			existing.analysis = analysis;
			existing.panel.reveal(vscode.ViewColumn.Active, false);
			if (existing.ready) {
				void existing.sendInit();
			}
			return;
		}
		MergePanel.current = new MergePanel(context, gitService, sourceBranch, intoBranch, analysis, onMerged);
	}

	private async sendInit(): Promise<void> {
		const changes = await this.gitService.getWorkingChanges();
		this.panel.title = `Merge ${this.sourceBranch}`;
		this.post({
			type: 'init',
			state: {
				sourceBranch: this.sourceBranch,
				intoBranch: this.intoBranch,
				analysis: this.analysis,
				hasLocalChanges: changes.length > 0,
			},
		});
	}

	private async handleMessage(msg: MergeWebviewMessage): Promise<void> {
		switch (msg.type) {
			case 'ready':
				this.ready = true;
				await this.sendInit();
				break;
			case 'cancel':
				this.panel.dispose();
				break;
			case 'merge': {
				// Only the three flags come from the webview -- which branch to merge is the host's own,
				// fixed when the drag opened this, so nothing the webview sends can redirect it.
				if (typeof msg.squash !== 'boolean' || typeof msg.noFastForward !== 'boolean' || typeof msg.commit !== 'boolean') {
					return;
				}
				const options = { squash: msg.squash, noFastForward: msg.noFastForward, commit: msg.commit };
				const { sourceBranch, intoBranch } = this;
				try {
					// Checked live, not trusted from when this opened -- merging "into main" after someone
					// switched branches in the terminal meanwhile would land on the wrong branch.
					const current = await this.gitService.getCurrentBranch();
					if (current !== intoBranch) {
						throw new Error(`The current branch changed to "${current ?? 'a detached HEAD'}" since this opened -- drag the branch again.`);
					}
					await vscode.window.withProgress(
						{ location: vscode.ProgressLocation.Notification, title: `Merging ${sourceBranch} into ${intoBranch}…` },
						() => this.gitService.mergeBranch(sourceBranch, options)
					);
					this.panel.dispose();
					this.onMerged();
					if (options.squash && !options.commit) {
						// No MERGE_HEAD for a squash, so the Conflicts tab won't open for it -- this is the
						// only pointer to where the result went.
						void vscode.window.showInformationMessage(
							`GGit: The changes from ${sourceBranch} are staged. Review them in Working Copy and commit when ready.`
						);
					}
				} catch (err) {
					this.post({ type: 'error', message: (err as Error).message });
				}
				break;
			}
		}
	}

	private post(message: MergeHostMessage): void {
		void this.panel.webview.postMessage(message);
	}

	private dispose(): void {
		MergePanel.current = undefined;
		while (this.disposables.length) {
			this.disposables.pop()?.dispose();
		}
	}

	private getHtml(context: vscode.ExtensionContext): string {
		const webview = this.panel.webview;
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'mergeWebview.js'));
		const codiconCssUri = webview.asWebviewUri(
			vscode.Uri.joinPath(context.extensionUri, 'node_modules', '@vscode/codicons', 'dist', 'codicon.css')
		);
		const nonce = getNonce();

		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
	<title>Merge</title>
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
		/* Read-only -- the drag already picked the branch -- but styled like Create Branch's inputs so
		 * the two dialogs read as the same family. */
		#sourceBranch {
			padding: 6px 8px;
			background-color: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
			border: 1px solid var(--vscode-input-border, transparent);
			border-radius: 3px;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		#summary {
			margin: 0 0 18px 0;
			color: var(--vscode-descriptionForeground);
		}
		#conflictWarning {
			display: flex;
			gap: 8px;
			margin: 0 0 18px 0;
			padding: 8px 10px;
			border-radius: 3px;
			border: 1px solid var(--vscode-inputValidation-warningBorder, #b89500);
			background-color: var(--vscode-inputValidation-warningBackground, transparent);
		}
		#conflictWarning[hidden] {
			display: none;
		}
		#conflictWarning .codicon {
			color: var(--vscode-editorWarning-foreground, #cca700);
			margin-top: 1px;
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
		/* Greyed out like Tower's own dialog does for options that don't apply to this merge, rather
		 * than hidden -- the description underneath says why. */
		.checkbox-field.disabled {
			opacity: 0.55;
		}
		#stashNote {
			margin: 4px 0 0 0;
			color: var(--vscode-descriptionForeground);
			font-size: 0.9em;
		}
		#stashNote:empty {
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
		#mergeButton {
			background-color: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
		}
		#mergeButton:hover:not(:disabled) {
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
			<h1>Merge</h1>
			<p id="subtitle">Integrates the changes from the chosen branch into your current HEAD branch, <strong id="intoBranch"></strong>.</p>

			<div class="field">
				<label>Branch</label>
				<div id="sourceBranch"></div>
			</div>

			<p id="summary"></p>

			<div id="conflictWarning" hidden>
				<span class="codicon codicon-warning"></span>
				<span id="conflictText"></span>
			</div>

			<label class="checkbox-field" id="squashField" for="squash">
				<input id="squash" type="checkbox" />
				<span class="checkbox-text">
					<strong>Squash Commits</strong>
					<span id="squashDesc"></span>
				</span>
			</label>

			<label class="checkbox-field" id="noFastForwardField" for="noFastForward">
				<input id="noFastForward" type="checkbox" />
				<span class="checkbox-text">
					<strong>Always Generate Merge Commit</strong>
					<span id="noFastForwardDesc"></span>
				</span>
			</label>

			<label class="checkbox-field" id="commitField" for="commit">
				<input id="commit" type="checkbox" checked />
				<span class="checkbox-text">
					<strong>Directly Commit Merged Changes</strong>
					<span id="commitDesc"></span>
				</span>
			</label>

			<p id="stashNote"></p>

			<div id="error"></div>

			<div id="buttons">
				<button id="cancelButton">Cancel</button>
				<button id="mergeButton" disabled>Merge</button>
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
