import * as vscode from 'vscode';
import { GitService } from '../git/gitService';
import { RemoteTagInfo, TagInfo } from '../git/types';

/** One row of the Tags view -- a local tag, or one that so far only exists on some remote(s). */
export interface TagNode {
	name: string;
	/** Undefined for a tag that only exists on a remote. */
	local: TagInfo | undefined;
	/** Every remote configured, and what's known about its copy of this tag -- see TagRemoteState. */
	remotes: TagRemoteState[];
}

export interface TagRemoteState {
	remote: string;
	/** False until that remote has answered (or when it couldn't be reached) -- `tag` means nothing yet. */
	known: boolean;
	/** The remote's copy of the tag, or undefined if it doesn't have one. */
	tag: RemoteTagInfo | undefined;
}

/** Lists local tags straight away, then asks each remote which tags it has (`git ls-remote`, a
 * network call) to fill in where each one lives. That remote half is cached rather than re-asked on
 * every refresh() -- refreshAll runs on every .git change, far too often for a network round trip --
 * and only re-fetched via refreshRemotes(): when the view first loads, from its Refresh button, and
 * after fetch/pull/sync or a tag action that changed a remote. */
export class TagsTreeProvider implements vscode.TreeDataProvider<TagNode> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
	private readonly _onDidChangeRemoteStatus = new vscode.EventEmitter<string | undefined>();
	/** A short status for the view's header while remotes are being checked or couldn't be reached --
	 * undefined once there's nothing to say. */
	readonly onDidChangeRemoteStatus = this._onDidChangeRemoteStatus.event;
	private readonly _onDidChangeRemoteTags = new vscode.EventEmitter<Set<string> | undefined>();
	/** Every tag name any reachable remote has, each time the remotes answer -- undefined when no
	 * remote could be checked (none configured, or none reachable), meaning "unknown", not "none".
	 * Lets the History tab mark local-only tags without asking the remotes a second time. */
	readonly onDidChangeRemoteTags = this._onDidChangeRemoteTags.event;

	private remoteTags = new Map<string, Map<string, RemoteTagInfo>>();
	private remoteLoadStarted = false;
	// Bumped on every refreshRemotes() so a slow, superseded ls-remote can't overwrite a newer answer.
	private remoteLoadGeneration = 0;

	constructor(private readonly gitService: GitService) {}

	/** Local tags only -- see the class comment. */
	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	refreshRemotes(): void {
		this.remoteLoadStarted = true;
		const generation = ++this.remoteLoadGeneration;
		void (async () => {
			const remotes = await this.gitService.listRemotes();
			if (remotes.length === 0) {
				this.remoteTags = new Map();
				this._onDidChangeRemoteStatus.fire(undefined);
				this._onDidChangeRemoteTags.fire(undefined);
				this.refresh();
				return;
			}
			this._onDidChangeRemoteStatus.fire(`Checking ${remotes.join(', ')}…`);
			const results = await Promise.all(
				remotes.map(async remote => {
					try {
						return { remote, tags: await this.gitService.listRemoteTags(remote) };
					} catch (err) {
						this.gitService.log(`TagsTreeProvider: couldn't list tags on ${remote}: ${(err as Error).message.trim()}`);
						return { remote, tags: undefined };
					}
				})
			);
			if (generation !== this.remoteLoadGeneration) {
				return;
			}
			this.remoteTags = new Map(results.filter(r => r.tags).map(r => [r.remote, r.tags!]));
			const unreachable = results.filter(r => !r.tags).map(r => r.remote);
			this._onDidChangeRemoteStatus.fire(unreachable.length > 0 ? `Couldn't reach ${unreachable.join(', ')}` : undefined);
			this._onDidChangeRemoteTags.fire(
				this.remoteTags.size > 0 ? new Set([...this.remoteTags.values()].flatMap(tags => [...tags.keys()])) : undefined
			);
			this.refresh();
		})();
	}

	async getChildren(element?: TagNode): Promise<TagNode[]> {
		if (element) {
			return [];
		}
		if (!this.remoteLoadStarted) {
			this.refreshRemotes();
		}
		return this.gitService.time('TagsTreeProvider.getChildren', async () => {
			const [tags, remotes] = await Promise.all([this.gitService.listTags(), this.gitService.listRemotes()]);
			const remoteStates = (name: string): TagRemoteState[] =>
				remotes.map(remote => {
					const known = this.remoteTags.get(remote);
					return { remote, known: known !== undefined, tag: known?.get(name) };
				});
			const nodes: TagNode[] = tags.map(tag => ({ name: tag.name, local: tag, remotes: remoteStates(tag.name) }));
			const localNames = new Set(tags.map(t => t.name));
			const remoteOnlyNames = new Set<string>();
			for (const [remote, remoteTags] of this.remoteTags) {
				if (!remotes.includes(remote)) {
					continue;
				}
				for (const name of remoteTags.keys()) {
					if (!localNames.has(name)) {
						remoteOnlyNames.add(name);
					}
				}
			}
			for (const name of remoteOnlyNames) {
				nodes.push({ name, local: undefined, remotes: remoteStates(name) });
			}
			// Newest version first -- numeric collation so v1.10.0 sorts above v1.9.0. By name rather
			// than date because a remote-only tag has no date to sort by until it's fetched.
			return nodes.sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));
		});
	}

	getTreeItem(node: TagNode): vscode.TreeItem {
		const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.None);
		item.id = `tag:${node.name}`;
		const having = node.remotes.filter(r => r.tag);
		if (!node.local) {
			// Remote-only: nothing local to show history for until it's fetched, so no click command.
			item.iconPath = new vscode.ThemeIcon('cloud', new vscode.ThemeColor('descriptionForeground'));
			item.description = `${having.map(r => r.remote).join(', ')} only`;
			item.tooltip = `${node.name} is only on ${having.map(r => r.remote).join(', ')} -- fetch to get it locally.`;
			item.contextValue = 'tag remoteOnly';
			return item;
		}
		const local = node.local;
		const same = having.filter(r => r.tag!.sha === local.sha).map(r => r.remote);
		const different = having.filter(r => r.tag!.sha !== local.sha).map(r => r.remote);
		// Unknown (not answered yet, or unreachable) counts as "might not have it" -- Publish stays
		// offered, and its dialog says so if the remote turns out to have it already.
		const missing = node.remotes.filter(r => !r.known || !r.tag).map(r => r.remote);
		const anyKnown = node.remotes.some(r => r.known);

		let color: string | undefined;
		if (different.length > 0) {
			color = 'charts.orange';
		} else if (same.length > 0) {
			color = 'charts.green';
		} else if (anyKnown) {
			color = 'charts.purple';
		}
		item.iconPath = new vscode.ThemeIcon('tag', color ? new vscode.ThemeColor(color) : undefined);
		if (same.length > 0 || different.length > 0) {
			item.description = [...same, ...different.map(r => `≠ ${r}`)].join(', ');
		} else if (anyKnown) {
			item.description = 'local only';
		}

		const tooltip = new vscode.MarkdownString();
		tooltip.appendMarkdown(`**${escapeMarkdown(node.name)}** -- ${local.annotated ? 'annotated' : 'lightweight'} tag\n\n`);
		tooltip.appendMarkdown(`\`${local.commit.slice(0, 7)}\` ${escapeMarkdown(local.subject)}\n\n`);
		for (const r of node.remotes) {
			const status = !r.known
				? 'not checked'
				: !r.tag
					? "doesn't have it"
					: r.tag.sha === local.sha
						? 'same'
						: `different (points at \`${r.tag.commit.slice(0, 7)}\`)`;
			tooltip.appendMarkdown(`${escapeMarkdown(r.remote)}: ${status}  \n`);
		}
		item.tooltip = tooltip;

		const flags = ['tag', 'local'];
		if (missing.length > 0) {
			flags.push('canPublish');
		}
		if (different.length > 0) {
			flags.push('canPush');
		}
		item.contextValue = flags.join(' ');
		item.command = {
			command: 'ggit.tagClicked',
			title: 'Open Tag History',
			arguments: [node.name],
		};
		return item;
	}
}

function escapeMarkdown(text: string): string {
	return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}
