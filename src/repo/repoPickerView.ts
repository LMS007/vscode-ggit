import * as vscode from 'vscode';
import { RepoEntry, Repositories } from '../git/repositories';

interface RepoSummary {
	branch: string | undefined;
	changes: number;
}

type PickerMessage = { type: 'ready' } | { type: 'focus' } | { type: 'pick'; root: unknown };

/** How long a full pass over every repository's status counts as fresh. Focusing the dropdown asks
 * for one each time, and each pass is a `git status` per repository. */
const SUMMARY_FRESH_MS = 2000;

/** The Repository dropdown at the top of the GGit sidebar, shown only when the opened folder holds more
 * than one repository (see Repositories). A webview, since a tree view can't hold a <select>. Each
 * option shows its repository's branch and changed-file count; the line under the dropdown links the
 * other repositories that have changes, so the overview the built-in Source Control view gives by
 * listing every repository at once is still a glance away. */
export class RepoPickerViewProvider implements vscode.WebviewViewProvider {
	private view: vscode.WebviewView | undefined;
	private readonly summaries = new Map<string, RepoSummary>();
	private lastFullRefresh = 0;

	constructor(
		private readonly repos: Repositories,
		private readonly onPick: (root: string) => void
	) {}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		view.webview.options = { enableScripts: true };
		view.webview.html = getHtml();
		view.webview.onDidReceiveMessage((msg: PickerMessage) => {
			switch (msg.type) {
				case 'ready':
					this.update();
					void this.refreshSummaries(true);
					break;
				case 'focus':
					void this.refreshSummaries(false);
					break;
				case 'pick':
					if (typeof msg.root === 'string') {
						this.onPick(msg.root);
					}
					break;
			}
		});
		view.onDidChangeVisibility(() => {
			if (view.visible) {
				void this.refreshSummaries(false);
			}
		});
		view.onDidDispose(() => {
			this.view = undefined;
		});
	}

	/** Re-sends the list and which one is active: after a switch, a rescan, or a pick that was refused
	 * (which puts the dropdown back on the repository still active). */
	update(): void {
		if (!this.view) {
			return;
		}
		const active = this.repos.activeEntry.root;
		const repos = this.repos.entries.map(entry => ({
			root: entry.root,
			name: entry.name,
			label: this.label(entry),
			changes: this.summaries.get(entry.root)?.changes ?? 0,
		}));
		void this.view.webview.postMessage({ type: 'repos', active, repos });
	}

	/** Re-reads every listed repository's branch and changes, unless the last pass is still fresh. */
	async refreshSummaries(force: boolean): Promise<void> {
		if (!this.view?.visible || (!force && Date.now() - this.lastFullRefresh < SUMMARY_FRESH_MS)) {
			return;
		}
		this.lastFullRefresh = Date.now();
		await Promise.all(this.repos.entries.map(entry => this.readSummary(entry.root)));
		this.update();
	}

	/** Just the active repository's, from refreshAll, which runs on every change GGit notices there. */
	async refreshActive(): Promise<void> {
		if (!this.view?.visible || !this.repos.isMultiRepo) {
			return;
		}
		await this.readSummary(this.repos.activeEntry.root);
		this.update();
	}

	/** "main · 3 changed", or whatever part of that is known yet -- for Switch Repository's list. */
	describe(entry: RepoEntry): string {
		const summary = this.summaries.get(entry.root);
		return [summary?.branch, summary?.changes ? `${summary.changes} changed` : undefined].filter(Boolean).join(' · ');
	}

	private label(entry: RepoEntry): string {
		const name = entry.relative === '' ? `${entry.name} (root)` : entry.name;
		const details = this.describe(entry);
		return details ? `${name} · ${details}` : name;
	}

	private async readSummary(root: string): Promise<void> {
		const service = this.repos.serviceForListed(root);
		if (!service) {
			return;
		}
		try {
			this.summaries.set(root, await service.getSummary());
		} catch {
			this.summaries.delete(root);
		}
	}
}

function getHtml(): string {
	const nonce = getNonce();
	return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<style>
		html, body {
			margin: 0;
			color: var(--vscode-foreground);
			font-family: var(--vscode-font-family);
			font-size: var(--vscode-font-size);
		}
		body {
			padding: 4px 12px 8px 20px;
		}
		select {
			display: block;
			width: 100%;
			box-sizing: border-box;
			height: 26px;
			padding: 0 6px;
			font: inherit;
			color: var(--vscode-dropdown-foreground);
			background-color: var(--vscode-dropdown-background);
			border: 1px solid var(--vscode-dropdown-border, transparent);
			border-radius: 2px;
			cursor: pointer;
		}
		select:focus {
			outline: 1px solid var(--vscode-focusBorder);
			outline-offset: -1px;
		}
		option {
			color: var(--vscode-dropdown-foreground);
			background-color: var(--vscode-dropdown-listBackground, var(--vscode-dropdown-background));
		}
		#others {
			margin-top: 6px;
			line-height: 1.6;
			color: var(--vscode-descriptionForeground);
		}
		#others:empty {
			display: none;
		}
		#others button {
			padding: 0;
			border: none;
			background: none;
			font: inherit;
			color: var(--vscode-textLink-foreground);
			cursor: pointer;
		}
		#others button:hover {
			color: var(--vscode-textLink-activeForeground);
			text-decoration: underline;
		}
		#others button:focus-visible {
			outline: 1px solid var(--vscode-focusBorder);
		}
	</style>
</head>
<body>
	<select id="repo" aria-label="Repository"></select>
	<div id="others"></div>
	<script nonce="${nonce}">
		const vscodeApi = acquireVsCodeApi();
		const select = document.getElementById('repo');
		const others = document.getElementById('others');
		select.addEventListener('change', () => vscodeApi.postMessage({ type: 'pick', root: select.value }));
		// Fresh branch names and change counts for the next time the list opens.
		select.addEventListener('focus', () => vscodeApi.postMessage({ type: 'focus' }));
		window.addEventListener('message', event => {
			const message = event.data;
			if (message.type !== 'repos') {
				return;
			}
			const repos = message.repos;
			const sameRepos =
				select.options.length === repos.length && repos.every((repo, i) => select.options[i].value === repo.root);
			if (sameRepos) {
				// Relabel in place rather than rebuilding, so a list that's open doesn't snap shut.
				repos.forEach((repo, i) => {
					if (select.options[i].text !== repo.label) {
						select.options[i].text = repo.label;
					}
				});
			} else {
				select.replaceChildren(...repos.map(repo => new Option(repo.label, repo.root)));
			}
			select.value = message.active;
			select.title = message.active;

			const changed = repos.filter(repo => repo.root !== message.active && repo.changes > 0);
			others.replaceChildren();
			if (changed.length > 0) {
				others.append('Also changed: ');
				changed.forEach((repo, i) => {
					if (i > 0) {
						others.append(', ');
					}
					const link = document.createElement('button');
					link.textContent = repo.name + ' (' + repo.changes + ')';
					link.title = 'Switch to ' + repo.name;
					link.addEventListener('click', () => vscodeApi.postMessage({ type: 'pick', root: repo.root }));
					others.append(link);
				});
			}
		});
		vscodeApi.postMessage({ type: 'ready' });
	</script>
</body>
</html>`;
}

function getNonce(): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let text = '';
	for (let i = 0; i < 32; i++) {
		text += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return text;
}
