import * as vscode from 'vscode';
import { GitService } from '../git/gitService';
import { RemoteBranchInfo } from '../git/types';

export class RemotesTreeProvider implements vscode.TreeDataProvider<RemoteBranchInfo> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	constructor(private readonly gitService: GitService) {}

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	getChildren(element?: RemoteBranchInfo): Thenable<RemoteBranchInfo[]> {
		if (element) {
			return Promise.resolve([]);
		}
		return this.gitService.listRemoteBranches('origin');
	}

	getTreeItem(branch: RemoteBranchInfo): vscode.TreeItem {
		const item = new vscode.TreeItem(branch.name, vscode.TreeItemCollapsibleState.None);
		item.iconPath = new vscode.ThemeIcon('cloud');
		item.contextValue = 'remoteBranch';
		return item;
	}
}
