import * as path from 'path';
import * as vscode from 'vscode';
import { openDiffForFile } from '../diff/openDiff';
import { resetHeadToCommit } from '../git/gitActions';
import { GitService } from '../git/gitService';
import { HostMessage, WebviewMessage } from './protocol';

/** Shared across every History panel instance/reload — not scoped to a single webview session. */
const SPLIT_STATE_KEY = 'ggit.historyPanel.commitsSplitPercent';

/** Same sharing as SPLIT_STATE_KEY -- which remote the toolbar dropdown last had selected, so
 * reopening the panel doesn't reset back to whatever the "prefer origin, else first" default picks.
 * Repo-wide rather than per-branch: which remote you're pushing/publishing to isn't really a property
 * of any one branch. */
const SELECTED_REMOTE_KEY = 'ggit.historyPanel.selectedRemote';

/** Commits per page -- see GitService.getLog. Small enough that even a page near the end of a huge,
 * deeply-diverged branch's history stays fast; large enough that scrolling doesn't feel choppy. */
const COMMITS_PAGE_SIZE = 100;

/** Mirrors the Branches toolbar/sidebar Actions view — these always act on the currently checked-out
 * branch, not necessarily the one this panel happens to be showing history for. The trailing three
 * (stash apply/save, commit) mirror Working Copy's own toolbar buttons instead — same commands, same
 * behavior, just also reachable from here. */
const TOOLBAR_BUTTONS: {
	command: string;
	icon: string;
	label: string;
	primary?: boolean;
	trailingIcon?: string;
	// A thin divider right before this button, so it (and whatever follows) reads as a distinct
	// group from whatever came before, rather than just more of the same row.
	separatorBefore?: boolean;
}[] = [
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
	{ command: 'ggit.applyStash', icon: 'inbox', label: 'Apply Stash', trailingIcon: 'arrow-up', separatorBefore: true },
	{ command: 'ggit.stashAll', icon: 'archive', label: 'Save Stash', trailingIcon: 'arrow-down' },
	// Its own group of one -- separated from the stash pair so Commit (and View on GitHub, appended
	// after it below) don't read as more stash-related actions.
	{ command: 'ggit.commit', icon: 'check', label: 'Commit', primary: true, separatorBefore: true },
];

/** The only commands the webview's 'runAction' message may trigger -- anything else is dropped
 * host-side, so the webview can never act as a generic "run any VS Code command" bridge. */
const TOOLBAR_COMMANDS = new Set(TOOLBAR_BUTTONS.map(b => b.command));

export class BranchHistoryPanel {
	private static current: BranchHistoryPanel | undefined;

	private readonly panel: vscode.WebviewPanel;
	private readonly disposables: vscode.Disposable[] = [];
	private branchName: string;
	private ready = false;
	// Pagination state for the currently-loaded branch -- reset on every fresh loadCommits (branch
	// switch, open, or reveal), advanced by loadMoreCommits as the webview scrolls.
	private commitsLoaded = 0;
	private hasMoreCommits = false;
	private loadingMoreCommits = false;
	// undefined until the first loadCommits resolves an effective one (persisted choice if still
	// valid, else "origin" if present, else whatever's first) -- see loadCommits.
	private selectedRemote: string | undefined;
	/** The GitHub URL last handed to the webview (see 'commits'.githubUrl) -- the only URL the
	 * 'openExternalUrl' message is allowed to open, so nothing the webview renders can turn it into
	 * an open-any-URL bridge. */
	private githubUrl: string | undefined;

	private constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly gitService: GitService,
		branchName: string
	) {
		this.branchName = branchName;
		this.selectedRemote = context.globalState.get<string>(SELECTED_REMOTE_KEY);
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
		// One safety net for every message: a handler that throws (e.g. a path or hash that fails
		// validation in GitService) surfaces as a normal error toast, not an unhandled rejection.
		this.panel.webview.onDidReceiveMessage(
			(msg: WebviewMessage) =>
				void this.handleMessage(msg).catch(err => vscode.window.showErrorMessage(`GGit: ${(err as Error).message}`)),
			null,
			this.disposables
		);
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
			const [{ commits, hasMore }, aheadCount, upstream, remotes, githubUrl] = await Promise.all([
				this.gitService.getLog(this.branchName, { skip: 0, limit: COMMITS_PAGE_SIZE }),
				this.gitService.getAheadCount(this.branchName),
				this.gitService.getUpstreamBranch(this.branchName),
				this.gitService.listRemotes(),
				this.gitService.getGitHubBranchUrl(this.branchName),
			]);
			this.commitsLoaded = commits.length;
			this.hasMoreCommits = hasMore;
			// The previously-selected remote if it's still configured; otherwise "origin" if present
			// (the common case, and what pickRemote/pushCurrentBranch would land on anyway with only
			// one remote); otherwise whatever's first. Persisted only when it actually changes, so a
			// repo with zero or one remote doesn't write to globalState on every single load.
			const effectiveRemote =
				this.selectedRemote && remotes.includes(this.selectedRemote)
					? this.selectedRemote
					: (remotes.includes('origin') ? 'origin' : remotes[0]);
			if (effectiveRemote !== this.selectedRemote) {
				this.selectedRemote = effectiveRemote;
				void this.context.globalState.update(SELECTED_REMOTE_KEY, effectiveRemote);
			}
			this.githubUrl = githubUrl;
			this.post({
				type: 'commits',
				branchName: this.branchName,
				commits,
				focusLatest,
				hasMore,
				aheadCount,
				hasUpstream: upstream !== undefined,
				remotes,
				selectedRemote: effectiveRemote,
				githubUrl,
			});
		} catch (err) {
			this.post({ type: 'error', message: (err as Error).message });
		}
	}

	/** Fetches and posts exactly one more page, updating pagination state. Returns whether there's
	 * still more beyond this page (false either because history ran out or the fetch failed) --
	 * shared by loadMoreCommits (a single call, scroll-triggered) and ensureCommitsForSearch (a loop,
	 * search-triggered) so both go through identical bookkeeping instead of duplicating it. */
	private async fetchNextPage(): Promise<boolean> {
		const branchAtRequestTime = this.branchName;
		try {
			const { commits, hasMore } = await this.gitService.getLog(this.branchName, {
				skip: this.commitsLoaded,
				limit: COMMITS_PAGE_SIZE,
			});
			if (branchAtRequestTime !== this.branchName) {
				// A branch switch raced in while this was in flight -- the new branch's own loadCommits
				// has already (or is about to) reset all this state, so just drop the stale result rather
				// than appending it onto the wrong branch's list.
				return false;
			}
			this.commitsLoaded += commits.length;
			this.hasMoreCommits = hasMore;
			this.post({ type: 'moreCommits', commits, hasMore });
			return hasMore;
		} catch (err) {
			// Not posted as a webview 'error' -- that wipes the whole commits pane, which would throw
			// away an already-successfully-rendered first page just because a *later* page failed.
			// hasMoreCommits/commitsLoaded are left untouched, so scrolling again just retries the same
			// page instead of needing dedicated retry UI.
			vscode.window.showErrorMessage(`GGit: Failed to load more commits: ${(err as Error).message}`);
			this.post({ type: 'moreCommitsFailed' });
			return false;
		}
	}

	/** Requested by the webview when the commits pane is scrolled near its bottom. Guarded against
	 * overlapping requests (a fast scroll can fire this more than once before the first reply lands)
	 * -- also shares its guard with ensureCommitsForSearch below, so the two can't run concurrently
	 * and race each other's bookkeeping. */
	private async loadMoreCommits(): Promise<void> {
		if (!this.hasMoreCommits || this.loadingMoreCommits) {
			return;
		}
		this.loadingMoreCommits = true;
		try {
			await this.fetchNextPage();
		} finally {
			this.loadingMoreCommits = false;
		}
	}

	/** Bulk-loads pages until at least `minCount` commits are loaded or history runs out -- see
	 * plans/commit-search-plan.md. A cheap no-op (just an immediate 'searchLoadFinished') if already
	 * satisfied, so the webview can call this unconditionally on every search-box focus without
	 * needing to track "have I already done this" itself. */
	private async ensureCommitsForSearch(minCount: number): Promise<void> {
		if (this.loadingMoreCommits) {
			return;
		}
		if (this.commitsLoaded >= minCount || !this.hasMoreCommits) {
			this.post({ type: 'searchLoadFinished', totalLoaded: this.commitsLoaded, hasMore: this.hasMoreCommits });
			return;
		}
		this.loadingMoreCommits = true;
		try {
			while (this.commitsLoaded < minCount && this.hasMoreCommits) {
				const hasMore = await this.fetchNextPage();
				if (!hasMore) {
					break;
				}
			}
		} finally {
			this.loadingMoreCommits = false;
			this.post({ type: 'searchLoadFinished', totalLoaded: this.commitsLoaded, hasMore: this.hasMoreCommits });
		}
	}

	private async handleMessage(msg: WebviewMessage): Promise<void> {
		switch (msg.type) {
			case 'ready':
				this.ready = true;
				await this.loadCommits(true);
				break;
			case 'loadMoreCommits':
				await this.loadMoreCommits();
				break;
			case 'ensureCommitsForSearch':
				await this.ensureCommitsForSearch(msg.minCount);
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
				// Stored value ends up interpolated into the panel's HTML (data-initial-split), so only a
				// real number is ever persisted.
				if (typeof msg.commitsPercent === 'number' && Number.isFinite(msg.commitsPercent)) {
					void this.context.globalState.update(SPLIT_STATE_KEY, msg.commitsPercent);
				}
				break;
			case 'setRemote':
				this.selectedRemote = msg.remote;
				void this.context.globalState.update(SELECTED_REMOTE_KEY, msg.remote);
				break;
			case 'runAction':
				// Only the toolbar's own commands -- see TOOLBAR_COMMANDS.
				if (TOOLBAR_COMMANDS.has(msg.command)) {
					void vscode.commands.executeCommand(msg.command, msg.remote);
				}
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
			case 'openFileForEditing':
				await this.openFileForEditing(msg.path);
				break;
			case 'copyCommitHash':
				await vscode.env.clipboard.writeText(msg.sha);
				break;
			case 'copyFilePath':
				await vscode.env.clipboard.writeText(
					msg.mode === 'relative'
						? msg.path.split('/').join(path.sep)
						: this.gitService.resolveRepoPath(msg.path)
				);
				break;
			case 'revealFileInExplorer':
				void vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(this.gitService.resolveRepoPath(msg.path)));
				break;
			case 'revealFileInOS':
				void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(this.gitService.resolveRepoPath(msg.path)));
				break;
			case 'openExternalUrl':
				// Only the URL this panel itself computed -- see the githubUrl field.
				if (this.githubUrl && msg.url === this.githubUrl) {
					void vscode.env.openExternal(vscode.Uri.parse(this.githubUrl));
				}
				break;
		}
	}

	/** Opens the file's *current* working-tree copy, not the revision as of whatever commit is
	 * selected -- a historical revision is read-only (it's git-show content, not a real file), so
	 * "open for editing" only ever makes sense against what's actually on disk now. Checks existence
	 * first (rather than letting vscode.open fail raw) since the file may have since been renamed or
	 * deleted -- that's the "(if it can be)" case. */
	private async openFileForEditing(relPath: string): Promise<void> {
		const uri = vscode.Uri.file(this.gitService.resolveRepoPath(relPath));
		try {
			await vscode.workspace.fs.stat(uri);
		} catch {
			void vscode.window.showInformationMessage(`GGit: "${relPath}" no longer exists in the working tree.`);
			return;
		}
		try {
			await vscode.commands.executeCommand('vscode.open', uri);
		} catch (err) {
			vscode.window.showErrorMessage(`GGit: Failed to open file: ${(err as Error).message}`);
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
		// Re-checked on the way out too (not just on write, see 'setSplit') since this lands in the HTML.
		const storedSplit = context.globalState.get<unknown>(SPLIT_STATE_KEY);
		const initialSplitPercent = typeof storedSplit === 'number' && Number.isFinite(storedSplit) ? storedSplit : 60;
		// Mirrors the wording VS Code's own Explorer context menu uses for this per OS -- computed here
		// (extension host, so process.platform is the real OS) rather than in the webview, since a
		// package.json-style static title can't vary by platform the way this one needs to.
		const revealInOsLabel =
			process.platform === 'darwin' ? 'Reveal in Finder' : process.platform === 'win32' ? 'Reveal in File Explorer' : 'Open Containing Folder';
		// Leads the toolbar, ahead of Create Branch -- what remote Fetch/Pull/Push/Sync target (see
		// webview/main.ts) is more fundamental than any single action, so it reads as "pick a remote,
		// then act on it" left to right. Two elements, toggled by the webview (see renderRemoteSelect)
		// rather than always both present: the <select> once at least one remote exists, or else this
		// purple "Add Remote" button (reusing .toolbar-btn-publish -- same "something needs setting up
		// before you can do the normal thing" meaning as the Push button's own purple state) wired to
		// the same ggit.addRemote command as the Remotes view's own toolbar button.
		const remoteToolbarHtml =
			'<select id="remoteSelect" class="toolbar-remote-select" title="Remote" aria-label="Remote" hidden></select>' +
			'<button id="addRemoteButton" class="toolbar-btn toolbar-btn-publish" data-command="ggit.addRemote" title="Add Remote" aria-label="Add Remote" hidden>' +
			'<span class="codicon codicon-add"></span><span class="toolbar-btn-label">Add Remote</span></button>';
		const toolbarButtons =
			remoteToolbarHtml +
			TOOLBAR_BUTTONS.map(b => {
				const separator = b.separatorBefore ? '<span class="toolbar-separator"></span>' : '';
				const classAttr = `toolbar-btn${b.primary ? ' toolbar-btn-primary' : ''}`;
				const trailingIconHtml = b.trailingIcon ? `<span class="codicon codicon-${b.trailingIcon}"></span>` : '';
				return (
					separator +
					`<button class="${classAttr}" data-command="${b.command}" title="${b.label}" aria-label="${b.label}">` +
					`<span class="codicon codicon-${b.icon}"></span><span class="toolbar-btn-label">${b.label}</span>${trailingIconHtml}</button>`
				);
			}).join('') +
			// Not one of TOOLBAR_BUTTONS' generic runAction buttons -- it opens a URL the extension host
			// already computed (see 'commits'.githubUrl in webview/main.ts), and only when the current
			// branch is actually published to a github.com remote, so it starts hidden and has no
			// data-command of its own (see updateGitHubButton).
			'<button id="githubButton" class="toolbar-btn" title="View on GitHub" aria-label="View on GitHub" hidden>' +
			'<span class="codicon codicon-github"></span><span class="toolbar-btn-label">View on GitHub</span></button>';

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
			gap: 5px;
			height: 24px;
			padding: 0 8px;
			border: 1px solid rgba(200, 200, 200, 0.4);
			border-radius: 4px;
			background: transparent;
			color: var(--vscode-icon-foreground, var(--vscode-foreground));
			font-family: inherit;
			font-size: inherit;
			cursor: pointer;
		}
		/* An author-stylesheet display (above) otherwise always wins over the UA stylesheet's own
		 * [hidden] rule, regardless of selector specificity -- without this, toggling the hidden
		 * attribute on #addRemoteButton (a .toolbar-btn) wouldn't actually hide it. */
		.toolbar-btn[hidden] {
			display: none;
		}
		.toolbar-btn:hover {
			border-color: rgba(200, 200, 200, 0.85);
			background-color: var(--vscode-toolbar-hoverBackground);
		}
		.toolbar-btn .codicon {
			font-size: 10px;
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
		/* What Push/Publish targets (see webview/main.ts) -- a plain <select> rather than a custom
		 * dropdown so it gets native OS combobox behavior (keyboard nav, etc.) for free, just themed
		 * to sit alongside the toolbar buttons instead of looking like a stray form control. */
		.toolbar-remote-select {
			height: 24px;
			padding: 0 5px;
			border: 1px solid rgba(200, 200, 200, 0.4);
			border-radius: 4px;
			background-color: var(--vscode-dropdown-background, transparent);
			color: var(--vscode-dropdown-foreground, var(--vscode-foreground));
			font-family: inherit;
			font-size: inherit;
			max-width: 140px;
		}
		.toolbar-remote-select:hover {
			border-color: rgba(200, 200, 200, 0.85);
		}
		.toolbar-remote-select:focus {
			outline: 1px solid var(--vscode-focusBorder);
			outline-offset: -1px;
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
		/* Applied to the Push button (see webview/main.ts) when the branch has commits ready to
		 * push -- same green already used for added/staged content elsewhere in GGit. */
		.toolbar-btn-success {
			border: 1px solid transparent;
			/* Hardcoded rather than a theme token -- gitDecoration.addedResourceForeground is meant as
			 * readable *text* on a dark background (so themes tend to keep it light/pastel), which looked
			 * washed out as a solid button fill. This is a deliberately dark, high-contrast green instead. */
			background-color: #1f883d;
			color: #ffffff;
		}
		.toolbar-btn-success:hover {
			/* Re-declared, not inherited -- the base .toolbar-btn:hover rule also sets
			 * background-color (to a generic grey toolbar-hover tint), and since it's an equally
			 * specific selector, that rule was winning for this property whenever this block didn't
			 * explicitly compete for it -- which is what made the green look like it was fading to grey
			 * on hover despite this block already overriding border-color correctly. */
			background-color: #1f883d;
			border-color: rgba(255, 255, 255, 0.6);
		}
		/* Applied to the Push button instead when the branch has never been pushed (no upstream) but
		 * a remote to publish to does exist -- "Publish" is a meaningfully different action from
		 * "Push" (it also sets up tracking), so it gets its own color rather than reusing green. */
		.toolbar-btn-publish {
			border: 1px solid transparent;
			background-color: #8250df;
			color: #ffffff;
		}
		.toolbar-btn-publish:hover {
			/* Same reasoning as .toolbar-btn-success:hover above -- without this, .toolbar-btn:hover's
			 * generic grey background-color would win on hover and the purple would flash grey. */
			background-color: #8250df;
			border-color: rgba(255, 255, 255, 0.6);
		}
		#searchBar {
			flex: 0 0 auto;
			display: flex;
			align-items: center;
			gap: 8px;
			padding: 6px 10px;
			border-bottom: 1px solid var(--vscode-panel-border);
			color: var(--vscode-descriptionForeground);
		}
		#searchInput {
			flex: 1 1 auto;
			box-sizing: border-box;
			padding: 4px 8px;
			background-color: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
			border: 1px solid var(--vscode-input-border, transparent);
			border-radius: 3px;
			font-family: inherit;
			font-size: inherit;
		}
		#searchInput:focus {
			outline: 1px solid var(--vscode-focusBorder);
			outline-offset: -1px;
		}
		#searchStatus {
			flex: 0 0 auto;
			font-size: 0.9em;
			white-space: nowrap;
		}
		.icon-btn {
			flex: 0 0 auto;
			width: 22px;
			height: 22px;
			padding: 0;
			display: flex;
			align-items: center;
			justify-content: center;
			border: 1px solid rgba(200, 200, 200, 0.4);
			border-radius: 4px;
			background: transparent;
			color: var(--vscode-icon-foreground, var(--vscode-foreground));
			cursor: pointer;
		}
		.icon-btn:hover {
			background-color: var(--vscode-toolbar-hoverBackground);
		}
		.icon-btn .codicon {
			font-size: 14px;
		}
		.load-older-row {
			display: flex;
			justify-content: center;
			padding: 10px;
		}
		.load-older-row button {
			background: transparent;
			border: 1px solid rgba(200, 200, 200, 0.4);
			border-radius: 4px;
			color: var(--vscode-textLink-foreground);
			padding: 4px 12px;
			cursor: pointer;
			font-family: inherit;
			font-size: inherit;
		}
		.load-older-row button:hover {
			background-color: var(--vscode-toolbar-hoverBackground);
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
		.file-open-icon {
			flex: 0 0 auto;
			display: flex;
			align-items: center;
			justify-content: center;
			width: 20px;
			height: 20px;
			border-radius: 4px;
			cursor: pointer;
			color: var(--vscode-icon-foreground, var(--vscode-foreground));
		}
		.file-open-icon:hover {
			background-color: var(--vscode-toolbar-hoverBackground);
		}
		.stat-add { color: var(--vscode-gitDecoration-addedResourceForeground, #4b4); }
		.stat-del { color: var(--vscode-gitDecoration-deletedResourceForeground, #d44); margin-left: 4px; }
		.stat-binary { color: var(--vscode-descriptionForeground); font-style: italic; }
		.empty {
			padding: 10px;
			color: var(--vscode-descriptionForeground);
			font-style: italic;
		}
		.loading-more-row {
			display: flex;
			align-items: center;
			justify-content: center;
			gap: 6px;
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
	<div id="searchBar">
		<span class="codicon codicon-search"></span>
		<input id="searchInput" type="text" autocomplete="off" spellcheck="false" placeholder="Search commits by author or message…" />
		<span id="searchStatus"></span>
		<button id="searchClearButton" class="icon-btn" title="Clear search" aria-label="Clear search" hidden>
			<span class="codicon codicon-close"></span>
		</button>
	</div>
	<div id="layout" data-initial-split="${initialSplitPercent}">
		<div id="commits" class="pane"><div class="empty">Loading commits…</div></div>
		<div id="splitter"></div>
		<div id="files" class="pane"><div class="empty">Select a commit to see its changed files.</div></div>
	</div>
	<div id="commitContextMenu" class="context-menu" hidden>
		<div class="context-menu-item" data-action="copyHash">Copy Commit Hash</div>
		<div class="context-menu-separator"></div>
		<div class="context-menu-item" data-action="resetMixed">Reset Branch to Here (Mixed)</div>
		<div class="context-menu-item danger" data-action="resetHard">Reset Branch to Here (Hard)</div>
		<div class="context-menu-separator"></div>
		<div class="context-menu-item" data-action="cherryPick">Cherry-Pick Commit</div>
		<div class="context-menu-separator"></div>
		<div class="context-menu-item" data-action="savePatch">Save Patch…</div>
	</div>
	<div id="fileContextMenu" class="context-menu" hidden>
		<div class="context-menu-item" data-action="copyRelativePath">Copy Relative Path</div>
		<div class="context-menu-item" data-action="copyFullPath">Copy Path</div>
		<div class="context-menu-separator"></div>
		<div class="context-menu-item" data-action="revealInExplorer">Reveal in Explorer View</div>
		<div class="context-menu-item" data-action="revealInOS">${revealInOsLabel}</div>
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
