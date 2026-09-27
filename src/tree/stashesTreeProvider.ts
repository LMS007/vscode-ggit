import * as vscode from 'vscode';
import { GitService } from '../git/gitService';
import { StashInfo } from '../git/types';

export class StashesTreeProvider implements vscode.TreeDataProvider<StashInfo> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	constructor(private readonly gitService: GitService) {}

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	getChildren(element?: StashInfo): Thenable<StashInfo[]> {
		return element ? Promise.resolve([]) : this.gitService.time('StashesTreeProvider.getChildren', () => this.gitService.listStashes());
	}

	getTreeItem(stash: StashInfo): vscode.TreeItem {
		const { branch, name } = parseStashSubject(stash.message);
		const date = new Date(stash.date).toLocaleDateString();
		// label renders in the full-brightness foreground color, description in the dimmer
		// descriptionForeground -- exactly "name" vs. "branch - date", with no custom coloring needed.
		const item = new vscode.TreeItem(name, vscode.TreeItemCollapsibleState.None);
		item.description = `- ${[branch, date].filter(Boolean).join(' - ')}`;
		item.iconPath = new vscode.ThemeIcon('archive');
		item.contextValue = 'stash';
		item.tooltip = `${stash.ref}: ${stash.message}`;
		item.command = {
			command: 'ggit.stashClicked',
			title: 'View Stash Files',
			arguments: [stash],
		};
		return item;
	}
}

/** git's default stash subject is "WIP on <branch>: <sha> <subject>", or "On <branch>: <message>" when
 * `git stash push -m` supplied one -- splits off the branch it was stashed from (never containing ":"
 * -- git itself forbids that in a ref name, so this split is unambiguous) from the actual name/message
 * that follows it. Falls back to the raw text as the name, with no branch, for anything that doesn't
 * match either form (e.g. a stash created by some other tool). */
function parseStashSubject(subject: string): { branch: string | undefined; name: string } {
	const match = subject.match(/^(?:WIP on|On) ([^:]+):\s*(.*)$/);
	return match ? { branch: match[1], name: match[2] } : { branch: undefined, name: subject };
}
