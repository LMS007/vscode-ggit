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
		const item = new vscode.TreeItem(stash.message, vscode.TreeItemCollapsibleState.None);
		item.description = new Date(stash.date).toLocaleDateString();
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
