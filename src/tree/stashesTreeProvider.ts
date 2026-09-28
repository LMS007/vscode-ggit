import * as vscode from 'vscode';
import { GitService, parseStashSubject } from '../git/gitService';
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
