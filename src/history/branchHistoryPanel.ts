import * as vscode from 'vscode';
import { openDiffForFile } from '../diff/openDiff';
import { resetHeadToCommit } from '../git/gitActions';
import { GitService } from '../git/gitService';
import { HostMessage, WebviewMessage } from './protocol';

/** Shared across every History panel instance/reload — not scoped to a single webview session. */
const SPLIT_STATE_KEY = 'ggit.historyPanel.commitsSplitPercent';

/** Mirrors the Branches toolbar/sidebar Actions view — these always act on the currently checked-out
 * branch, not necessarily the one this panel happens to be showing history for. The trailing three
 * (stash apply/save, commit) mirror Working Copy's own toolbar buttons instead — same commands, same
 * behavior, just also reachable from here. */
const TOOLBAR_BUTTONS: { command: string; icon: string; label: string; primary?: boolean; trailingIcon?: string }[] = [
	{ command: 'ggit.createBranch', icon: 'add', label: 'Create Branch' },
	{ command: 'ggit.fetch', icon: 'cloud-download', label: 'Fetch' },
	{ command: 'ggit.pull', icon: 'arrow-down', label: 'Pull' },
	{ command: 'ggit.push', icon: 'arrow-up', label: 'Push' },
	{ command: 'ggit.sync', icon: 'sync', label: 'Sync' },
	{ command: 'ggit.refresh', icon: 'refresh', label: 'Refresh' },
	{ command: 'ggit.rebase', icon: 'git-merge', label: 'Rebase' },
	// trailingIcon: a second, direction-indicating arrow to the right of the label — up for bringing a
	// stash *out* into the working tree, down for putting one *away* into storage — on top of (not
	// instead of) each button's own leading icon.
	{ command: 'ggit.applyStash', icon: 'inbox', label: 'Apply Stash', trailingIcon: 'arrow-up' },
	{ command: 'ggit.stashAll', icon: 'archive', label: 'Save Stash', trailingIcon: 'arrow-down' },
	{ command: 'ggit.commit', icon: 'check', label: 'Commit', primary: true },
];

export class BranchHistoryPanel {
	private static current: BranchHistoryPanel | undefined;

	private readonly panel: vscode.WebviewPanel;
	private readonly disposables: vscode.Disposable[] = [];
	private branchName: string;
	private ready = false;

	private constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly gitService: GitService,
		branchName: string
	) {
		this.branchName = branchName;
		this.panel = vscode.window.createWebviewPanel(
			'ggitBranchHistory',
			`History: ${branchName}`,
			// preserveFocus: true — opening this from a tree-item click shouldn't steal focus
			// away from the tree, or arrow-key navigation there breaks immediately after a click.
			{ viewColumn: vscode.ViewColumn.Active, preserveFocus: true },
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [
					vscode.Uri.joinPath(context.extensionUri, 'dist'),
					vscode.Uri.joinPath(context.extensionUri, 'node_modules', '@vscode/codicons', 'dist'),
				],
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

	/** Reloads the currently open history tab, if any — call after a successful fetch/pull.
	 * focusLatest stays false here: this is a background data refresh, not the panel being opened or
	 * brought to the front, so it keeps whatever commit was already selected rather than yanking the
	 * user's attention away from a commit they might be actively reviewing. */
	static refreshIfOpen(): void {
		void BranchHistoryPanel.current?.loadCommits(false);
	}

	private showBranch(branchName: string): void {
		this.branchName = branchName;
		this.panel.title = `History: ${branchName}`;
		this.panel.reveal(vscode.ViewColumn.Active, true);
		void this.loadCommits(true);
	}

	private async loadCommits(focusLatest: boolean): Promise<void> {
		if (!this.ready) {
			return;
		}
		try {
			const commits = await this.gitService.getLog(this.branchName);
			this.post({ type: 'commits', branchName: this.branchName, commits, focusLatest });
		} catch (err) {
			this.post({ type: 'error', message: (err as Error).message });
		}
	}

	private async handleMessage(msg: WebviewMessage): Promise<void> {
		switch (msg.type) {
			case 'ready':
				this.ready = true;
				await this.loadCommits(true);
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
			case 'setSplit':
				void this.context.globalState.update(SPLIT_STATE_KEY, msg.commitsPercent);
				break;
			case 'runAction':
				void vscode.commands.executeCommand(msg.command);
				break;
			case 'resetHead':
				try {
					await resetHeadToCommit(this.gitService, msg.sha, msg.mode);
				} catch (err) {
					vscode.window.showErrorMessage(`GGit: ${(err as Error).message}`);
				}
				break;
			case 'cherryPick':
				try {
					await this.gitService.cherryPick(msg.sha);
				} catch (err) {
					vscode.window.showErrorMessage(`GGit: Cherry-pick failed: ${(err as Error).message}`);
				}
				break;
			case 'savePatch':
				try {
					await this.saveCommitPatch(msg.sha, msg.subject);
				} catch (err) {
					vscode.window.showErrorMessage(`GGit: ${(err as Error).message}`);
				}
				break;
		}
	}

	private async saveCommitPatch(sha: string, subject: string): Promise<void> {
		const patch = await this.gitService.getPatch(sha);
		const filename = `${sha.slice(0, 7)}-${sanitizeFilename(subject)}.patch`;
		const uri = await vscode.window.showSaveDialog({
			defaultUri: vscode.Uri.joinPath(vscode.Uri.file(this.gitService.repoRoot), filename),
			filters: { 'Patch files': ['patch'] },
		});
		if (!uri) {
			return;
		}
		await vscode.workspace.fs.writeFile(uri, Buffer.from(patch, 'utf8'));
		void vscode.window.showInformationMessage(`GGit: Patch saved to ${uri.fsPath}`);
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
		const codiconCssUri = webview.asWebviewUri(
			vscode.Uri.joinPath(context.extensionUri, 'node_modules', '@vscode/codicons', 'dist', 'codicon.css')
		);
		const nonce = getNonce();
		const initialSplitPercent = context.globalState.get<number>(SPLIT_STATE_KEY, 60);
		const toolbarButtons = TOOLBAR_BUTTONS.map((b, i) => {
			// A thin divider right before the stash/commit trio, so they read as a distinct group to
			// the right of the branch-management buttons rather than just more of the same row.
			const separator = i === 7 ? '<span class="toolbar-separator"></span>' : '';
			const classAttr = `toolbar-btn${b.primary ? ' toolbar-btn-primary' : ''}`;
			const trailingIconHtml = b.trailingIcon ? `<span class="codicon codicon-${b.trailingIcon}"></span>` : '';
			return (
				separator +
				`<button class="${classAttr}" data-command="${b.command}" title="${b.label}" aria-label="${b.label}">` +
				`<span class="codicon codicon-${b.icon}"></span><span class="toolbar-btn-label">${b.label}</span>${trailingIconHtml}</button>`
			);
		}).join('');

		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
	<title>Branch History</title>
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
		body {
			display: flex;
			flex-direction: column;
		}
		#toolbar {
			flex: 0 0 auto;
			display: flex;
			flex-wrap: wrap;
			gap: 6px;
			padding: 6px 10px;
			border-bottom: 1px solid var(--vscode-panel-border);
		}
		.toolbar-btn {
			display: flex;
			align-items: center;
			gap: 6px;
			height: 28px;
			padding: 0 10px;
			border: 1px solid rgba(200, 200, 200, 0.4);
			border-radius: 4px;
			background: transparent;
			color: var(--vscode-icon-foreground, var(--vscode-foreground));
			font-family: inherit;
			font-size: inherit;
			cursor: pointer;
		}
		.toolbar-btn:hover {
			border-color: rgba(200, 200, 200, 0.85);
			background-color: var(--vscode-toolbar-hoverBackground);
		}
		.toolbar-btn .codicon {
			font-size: 16px;
		}
		.toolbar-btn-label {
			white-space: nowrap;
		}
		.toolbar-separator {
			width: 1px;
			align-self: stretch;
			background-color: var(--vscode-panel-border);
			margin: 2px 4px;
		}
		.toolbar-btn-primary {
			border-color: transparent;
			background-color: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
		}
		.toolbar-btn-primary:hover:not(:disabled) {
			background-color: var(--vscode-button-hoverBackground);
		}
		.toolbar-btn-primary:disabled {
			opacity: 0.5;
			cursor: default;
		}
		#layout {
			display: flex;
			flex: 1 1 auto;
			min-height: 0;
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
		/* A commit that's on the branch's upstream but not the branch itself yet (i.e. "behind") —
		 * still shown, still fully clickable/selectable, just visually muted like Tower does. */
		.commit-row-wrapper.not-on-branch {
			opacity: 0.5;
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
		/* The selected row's background is the same blue as .ref-badge-local, so on its own the
		 * local badge would vanish into the row. Lightening every badge (blending white over
		 * whatever blue the row is) keeps them visible as distinct pills against it. */
		.row.selected .ref-badge-local,
		.row.selected .ref-badge-remote {
			background-color: rgba(255, 255, 255, 0.25);
			color: var(--vscode-badge-foreground, #ffffff);
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
		.context-menu {
			position: fixed;
			z-index: 1000;
			min-width: 220px;
			background-color: var(--vscode-menu-background, #252526);
			color: var(--vscode-menu-foreground, #cccccc);
			border: 1px solid var(--vscode-menu-border, transparent);
			border-radius: 4px;
			box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
			padding: 4px 0;
		}
		.context-menu[hidden] { display: none; }
		.context-menu-item {
			padding: 4px 16px;
			cursor: pointer;
			white-space: nowrap;
		}
		.context-menu-item:hover {
			background-color: var(--vscode-menu-selectionBackground, #04395e);
			color: var(--vscode-menu-selectionForeground, #ffffff);
		}
		.context-menu-item.danger:hover {
			background-color: var(--vscode-inputValidation-errorBackground, #5a1d1d);
			color: var(--vscode-errorForeground, #f48771);
		}
		.context-menu-separator {
			height: 1px;
			margin: 4px 0;
			background-color: var(--vscode-menu-separatorBackground, rgba(255, 255, 255, 0.1));
		}
	</style>
</head>
<body>
	<div id="toolbar">${toolbarButtons}</div>
	<div id="layout" data-initial-split="${initialSplitPercent}">
		<div id="commits" class="pane"><div class="empty">Loading commits…</div></div>
		<div id="splitter"></div>
		<div id="files" class="pane"><div class="empty">Select a commit to see its changed files.</div></div>
	</div>
	<div id="commitContextMenu" class="context-menu" hidden>
		<div class="context-menu-item" data-action="resetMixed">Reset Branch to Here (Mixed)</div>
		<div class="context-menu-item danger" data-action="resetHard">Reset Branch to Here (Hard)</div>
		<div class="context-menu-separator"></div>
		<div class="context-menu-item" data-action="cherryPick">Cherry-Pick Commit</div>
		<div class="context-menu-separator"></div>
		<div class="context-menu-item" data-action="savePatch">Save Patch…</div>
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

function sanitizeFilename(subject: string): string {
	const slug = subject
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 50);
	return slug || 'commit';
}
