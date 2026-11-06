import * as vscode from 'vscode';
import { offerToPushBranches } from '../git/gitActions';
import { stripAnsi } from '../git/gitErrors';
import { GitService } from '../git/gitService';
import { RebaseHostMessage, RebasePreview, RebaseWebviewMessage } from './rebaseProtocol';

/** How many commits each preview list shows before "…and N more". */
const PREVIEW_LIMIT = 50;

/** Preselected in Onto when nothing else says which branch to use. */
const MAINLINE_BRANCH_NAMES = ['main', 'master'];

/** The Rebase tab: what to rebase the checked-out branch onto, which of its commits to replay -- all
 * of them, or only those after a cut point (`--onto`, for a branch whose parent was squash-merged) --
 * and whether the branches stacked under it move along (`--update-refs`). A live preview lists the
 * commits each choice replays, and with a cut point, the ones it leaves out, before anything runs.
 * A form-style panel like the Merge dialog, since VS Code has no native multi-field dialog. Once the
 * rebase runs, this closes; if it stopped on conflicts, the Conflicts tab takes over (see
 * updateConflictContext in extension.ts). */
export class RebasePanel {
	private static current: RebasePanel | undefined;

	private readonly panel: vscode.WebviewPanel;
	private readonly disposables: vscode.Disposable[] = [];
	private ready = false;
	/** The branch being rebased, and what Onto offers -- fixed when the form was filled in, so the
	 * webview can only pick among them. */
	private branch: string | undefined;
	private offered = new Set<string>();

	private constructor(
		context: vscode.ExtensionContext,
		private readonly gitService: GitService,
		private onto: string | undefined,
		private readonly onRebased: () => void
	) {
		this.panel = vscode.window.createWebviewPanel(
			'ggitRebase',
			'Rebase',
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
		this.panel.webview.onDidReceiveMessage((msg: RebaseWebviewMessage) => this.handleMessage(msg), null, this.disposables);
	}

	/** `onto` preselects that branch (from a branch's right-click menu). Throws, without opening
	 * anything, when there's no branch to rebase or another operation is still under way. */
	static async createOrShow(
		context: vscode.ExtensionContext,
		gitService: GitService,
		onRebased: () => void,
		onto?: string
	): Promise<void> {
		// In-progress checks first: a stopped rebase also leaves HEAD detached.
		if (await gitService.isRebaseInProgress()) {
			throw new Error('A rebase is already in progress. Continue or abort it in the Conflicts tab first.');
		}
		if (await gitService.isMergeInProgress()) {
			throw new Error('Finish or abort the merge in progress before rebasing.');
		}
		if (!(await gitService.getCurrentBranch())) {
			throw new Error('Rebase works on the checked-out branch, and HEAD is detached.');
		}
		const existing = RebasePanel.current;
		if (existing) {
			existing.onto = onto ?? existing.onto;
			existing.panel.reveal(vscode.ViewColumn.Active, false);
			if (existing.ready) {
				await existing.sendInit();
			}
			return;
		}
		RebasePanel.current = new RebasePanel(context, gitService, onto, onRebased);
	}

	private async sendInit(): Promise<void> {
		const [branch, locals, remotes, changes, supportsUpdateRefs] = await Promise.all([
			this.gitService.getCurrentBranch(),
			this.gitService.listLocalBranches(),
			this.gitService.listRemotes(),
			this.gitService.getWorkingChanges(),
			this.gitService.supportsUpdateRefs(),
		]);
		if (!branch) {
			this.post({ type: 'error', message: 'Rebase works on the checked-out branch, and HEAD is detached.' });
			return;
		}
		const remoteBranches = (await Promise.all(remotes.map(r => this.gitService.listRemoteBranches(r)))).flat().map(b => b.name);
		const localBranches = locals.map(b => b.name).filter(name => name !== branch);
		this.branch = branch;
		this.offered = new Set([...localBranches, ...remoteBranches]);
		const onto =
			(this.onto && this.offered.has(this.onto) ? this.onto : undefined) ??
			MAINLINE_BRANCH_NAMES.find(name => localBranches.includes(name)) ??
			localBranches[0] ??
			remoteBranches[0] ??
			'';
		this.panel.title = `Rebase ${branch}`;
		this.post({
			type: 'init',
			state: { branch, localBranches, remoteBranches, onto, supportsUpdateRefs, hasLocalChanges: changes.length > 0 },
		});
	}

	private async handleMessage(msg: RebaseWebviewMessage): Promise<void> {
		switch (msg.type) {
			case 'ready':
				this.ready = true;
				await this.sendInit();
				break;
			case 'cancel':
				this.panel.dispose();
				break;
			case 'preview':
				await this.sendPreview(msg.requestId, msg.onto, cleanRef(msg.upstream));
				break;
			case 'rebase':
				await this.rebase(msg.onto, cleanRef(msg.upstream), msg.updateRefs === true);
				break;
		}
	}

	private async sendPreview(requestId: number, onto: string, upstream: string | undefined): Promise<void> {
		if (!this.offered.has(onto)) {
			return;
		}
		try {
			if (upstream !== undefined && !(await this.gitService.resolveCommit(upstream).catch(() => undefined))) {
				this.post({ type: 'preview', requestId, error: `"${upstream}" isn't a branch or commit here.` });
				return;
			}
			const cutTip = upstream !== undefined ? await this.gitService.getMergeBase('HEAD', upstream) : undefined;
			const [replayed, stacked, cutPoints, leftOut] = await Promise.all([
				this.gitService.previewRebase(onto, upstream, PREVIEW_LIMIT),
				this.gitService.listBranchesBetween(upstream ?? onto),
				this.gitService.listBranchesBetween(onto),
				cutTip ? this.gitService.previewRebase(onto, undefined, PREVIEW_LIMIT, cutTip) : undefined,
			]);
			// Every local branch between `onto` and HEAD, by the commit it points at -- shown on the
			// commits in both lists, which is what makes picking a cut point by branch make sense.
			const tips = new Map<string, string[]>();
			for (const b of cutPoints) {
				tips.set(b.sha, [...(tips.get(b.sha) ?? []), b.name]);
			}
			const label = <T extends { sha: string }>(commits: T[]) => commits.map(c => ({ ...c, branches: tips.get(c.sha) ?? [] }));
			const preview: RebasePreview = {
				commits: label(replayed.commits),
				count: replayed.count,
				behind: replayed.behind,
				leftOut: leftOut ? { commits: label(leftOut.commits), count: leftOut.count } : undefined,
				stacked: stacked.map(b => b.name),
				cutPoints: cutPoints.map(({ name, upstreamGone }) => ({ name, upstreamGone })),
			};
			this.post({ type: 'preview', requestId, preview });
		} catch (err) {
			this.post({ type: 'preview', requestId, error: stripAnsi((err as Error).message).trim() });
		}
	}

	private async rebase(onto: string, upstream: string | undefined, wantsUpdateRefs: boolean): Promise<void> {
		const branch = this.branch;
		if (!branch || !this.offered.has(onto)) {
			return;
		}
		try {
			// Checked live, not trusted from when this opened -- rebasing "alice/x" after someone switched
			// branches in the terminal meanwhile would rewrite the wrong branch.
			const current = await this.gitService.getCurrentBranch();
			if (current !== branch) {
				throw new Error(`The current branch changed to "${current ?? 'a detached HEAD'}" since this opened. Close this tab and rebase again.`);
			}
			if (upstream !== undefined && !(await this.gitService.resolveCommit(upstream))) {
				throw new Error(`"${upstream}" isn't a branch or commit here.`);
			}
			const updateRefs = wantsUpdateRefs && (await this.gitService.supportsUpdateRefs());
			const moved = updateRefs ? (await this.gitService.listBranchesBetween(upstream ?? onto)).map(b => b.name) : [];
			const title = `Rebasing ${branch} onto ${onto}${upstream ? ` (commits after ${upstream})` : ''}…`;
			let stopped = false;
			try {
				await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, () =>
					this.gitService.rebaseOnto(onto, { upstream, updateRefs })
				);
			} catch (err) {
				// A rebase that stops on conflicts exits non-zero, which isn't a failure here: the
				// Conflicts tab opens for it on the refresh below.
				if (!(await this.gitService.isRebaseInProgress())) {
					throw err;
				}
				stopped = true;
			}
			stopped ||= await this.gitService.isRebaseInProgress();
			this.panel.dispose();
			this.onRebased();
			if (stopped) {
				void vscode.window.showInformationMessage(
					`GGit: Rebasing ${branch} stopped on conflicts. Resolve them in the Conflicts tab, then continue the rebase there.`
				);
			} else if (moved.length > 0) {
				offerToPushBranches(this.gitService, branch, moved);
			}
		} catch (err) {
			const message = stripAnsi((err as Error).message).trim();
			this.gitService.log(`rebase failed:\n${message}`);
			this.post({ type: 'error', message });
		}
	}

	private post(message: RebaseHostMessage): void {
		void this.panel.webview.postMessage(message);
	}

	private dispose(): void {
		RebasePanel.current = undefined;
		while (this.disposables.length) {
			this.disposables.pop()?.dispose();
		}
	}

	private getHtml(context: vscode.ExtensionContext): string {
		const webview = this.panel.webview;
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'rebaseWebview.js'));
		const codiconCssUri = webview.asWebviewUri(
			vscode.Uri.joinPath(context.extensionUri, 'node_modules', '@vscode/codicons', 'dist', 'codicon.css')
		);
		const nonce = getNonce();

		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
	<title>Rebase</title>
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
			max-width: 560px;
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
		.field-label {
			display: block;
			margin-bottom: 6px;
			font-weight: 600;
		}
		select, input[type='text'] {
			width: 100%;
			box-sizing: border-box;
			padding: 5px 6px;
			background-color: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
			border: 1px solid var(--vscode-input-border, var(--vscode-dropdown-border, transparent));
			border-radius: 3px;
			font-family: inherit;
			font-size: inherit;
		}
		select:focus, input[type='text']:focus {
			outline: 1px solid var(--vscode-focusBorder);
			outline-offset: -1px;
		}
		.radio-option {
			display: flex;
			gap: 8px;
			align-items: flex-start;
			margin-bottom: 8px;
		}
		.radio-option input[type='radio'] {
			margin-top: 3px;
		}
		.radio-body {
			flex: 1;
			min-width: 0;
		}
		#upstream {
			margin-top: 6px;
		}
		.hint {
			display: block;
			color: var(--vscode-descriptionForeground);
			font-size: 0.9em;
			margin: 4px 0 0 0;
		}
		#suggestion {
			display: flex;
			gap: 8px;
			margin: 0 0 18px 0;
			padding: 8px 10px;
			border-radius: 3px;
			border: 1px solid var(--vscode-inputValidation-infoBorder, #1a85ff);
			background-color: var(--vscode-inputValidation-infoBackground, transparent);
		}
		#suggestion[hidden] { display: none; }
		#suggestion a { color: var(--vscode-textLink-foreground); cursor: pointer; }
		.commit-list {
			margin: 0;
			padding: 0;
			list-style: none;
			border: 1px solid var(--vscode-panel-border, rgba(127, 127, 127, 0.3));
			border-radius: 3px;
			max-height: 240px;
			overflow-y: auto;
		}
		.commit-list:empty { display: none; }
		.commit-list li {
			display: flex;
			gap: 8px;
			align-items: baseline;
			padding: 3px 8px;
			white-space: nowrap;
		}
		.commit-list .sha {
			font-family: var(--vscode-editor-font-family, monospace);
			color: var(--vscode-descriptionForeground);
			flex: 0 0 auto;
		}
		.commit-list .subject {
			overflow: hidden;
			text-overflow: ellipsis;
			min-width: 0;
		}
		.commit-list .more {
			color: var(--vscode-descriptionForeground);
			font-style: italic;
		}
		.branch-badge {
			flex: 0 0 auto;
			padding: 0 5px;
			border-radius: 3px;
			font-size: 0.8em;
			font-weight: 600;
			color: var(--vscode-badge-foreground);
			background-color: var(--vscode-badge-background);
		}
		#leftOutField .commit-list li .subject { text-decoration: line-through; opacity: 0.75; }
		#leftOutField[hidden] { display: none; }
		#previewStatus:empty { display: none; }
		.checkbox-field {
			display: flex;
			gap: 8px;
			margin-bottom: 14px;
		}
		.checkbox-field[hidden] { display: none; }
		.checkbox-field input { margin-top: 3px; }
		.checkbox-field .checkbox-text strong {
			display: block;
			font-weight: 600;
		}
		.checkbox-field .checkbox-text span {
			color: var(--vscode-descriptionForeground);
			font-size: 0.9em;
		}
		.checkbox-field.disabled { opacity: 0.55; }
		#stashNote {
			margin: 4px 0 0 0;
			color: var(--vscode-descriptionForeground);
			font-size: 0.9em;
		}
		#stashNote:empty { display: none; }
		#error {
			color: var(--vscode-errorForeground);
			margin-top: 14px;
			min-height: 1em;
			white-space: pre-wrap;
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
		#rebaseButton {
			background-color: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
		}
		#rebaseButton:hover:not(:disabled) {
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
			<h1>Rebase</h1>
			<p id="subtitle">Replays the commits of your current branch, <strong id="branch"></strong>, on top of another branch.</p>

			<div class="field">
				<label class="field-label" for="onto">Onto</label>
				<select id="onto"></select>
			</div>

			<div class="field">
				<span class="field-label">Replay</span>
				<label class="radio-option" for="modeAll">
					<input id="modeAll" type="radio" name="mode" value="all" checked />
					<span class="radio-body">Every commit not on <strong class="ontoName"></strong></span>
				</label>
				<label class="radio-option" for="modeAfter">
					<input id="modeAfter" type="radio" name="mode" value="after" />
					<span class="radio-body">
						Only the commits after
						<input id="upstream" type="text" list="cutPoints" placeholder="a branch or commit" spellcheck="false" autocomplete="off" />
						<datalist id="cutPoints"></datalist>
						<span class="hint">A branch or commit on this branch. It and everything older are left out; only newer commits are replayed. Use this when the branch underneath was squash-merged into <span class="ontoName"></span>: pick that branch, since a plain rebase would replay its commits again.</span>
					</span>
				</label>
			</div>

			<div id="suggestion" hidden>
				<span class="codicon codicon-lightbulb"></span>
				<span id="suggestionText"></span>
			</div>

			<div class="field">
				<span class="field-label" id="previewTitle">Commits to replay</span>
				<p id="previewStatus" class="hint"></p>
				<ul id="previewList" class="commit-list"></ul>
			</div>

			<div class="field" id="leftOutField" hidden>
				<span class="field-label" id="leftOutTitle">Left out</span>
				<p class="hint" id="leftOutHint"></p>
				<ul id="leftOutList" class="commit-list"></ul>
			</div>

			<label class="checkbox-field" id="updateRefsField" for="updateRefs" hidden>
				<input id="updateRefs" type="checkbox" checked />
				<span class="checkbox-text">
					<strong>Move the branches stacked under it too</strong>
					<span id="updateRefsDesc"></span>
				</span>
			</label>

			<p id="stashNote"></p>

			<div id="error"></div>

			<div id="buttons">
				<button id="cancelButton">Cancel</button>
				<button id="rebaseButton" disabled>Rebase</button>
			</div>
		</div>
	</div>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
	}
}

/** A ref typed into the webview, trimmed; undefined when empty or not a string. */
function cleanRef(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function getNonce(): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let text = '';
	for (let i = 0; i < 32; i++) {
		text += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return text;
}
