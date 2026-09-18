import * as vscode from 'vscode';
import { GitService } from '../git/gitService';
import { BranchInfo } from '../git/types';

export class BranchesTreeProvider implements vscode.TreeDataProvider<BranchInfo> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	constructor(private readonly gitService: GitService) {}

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	getChildren(element?: BranchInfo): Thenable<BranchInfo[]> {
		if (element) {
			return Promise.resolve([]);
		}
		return this.gitService.listLocalBranches();
	}

	getTreeItem(branch: BranchInfo): vscode.TreeItem {
		const item = new vscode.TreeItem(branch.name, vscode.TreeItemCollapsibleState.None);
		item.iconPath = new vscode.ThemeIcon(
			branch.isHead ? 'target' : 'git-branch',
			branch.isHead ? new vscode.ThemeColor('charts.green') : undefined
		);
		item.description = branch.isHead ? 'current' : undefined;
		item.contextValue = 'branch';
		item.command = {
			command: 'ggit.openBranchHistory',
			title: 'Open History',
			arguments: [branch.name],
		};
		return item;
	}
}
