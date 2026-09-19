import * as vscode from 'vscode';
import { GitService } from '../git/gitService';
import { RemoteBranchInfo } from '../git/types';
import { BranchTreeNode, buildBranchTree, sortTree } from './branchTree';

export class RemotesTreeProvider implements vscode.TreeDataProvider<BranchTreeNode<RemoteBranchInfo>> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	constructor(private readonly gitService: GitService) {}

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	async getChildren(element?: BranchTreeNode<RemoteBranchInfo>): Promise<BranchTreeNode<RemoteBranchInfo>[]> {
		if (element) {
			return element.kind === 'folder' ? element.children : [];
		}
		const branches = await this.gitService.listRemoteBranches('origin');
		return sortTree(buildBranchTree(branches, b => stripRemotePrefix(b.name)));
	}

	getTreeItem(node: BranchTreeNode<RemoteBranchInfo>): vscode.TreeItem {
		if (node.kind === 'folder') {
			const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.Collapsed);
			item.iconPath = new vscode.ThemeIcon('folder');
			item.contextValue = 'remoteBranchFolder';
			return item;
		}
		const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.None);
		item.iconPath = new vscode.ThemeIcon('cloud');
		item.contextValue = 'remoteBranch';
		return item;
	}
}

/** Remote branch names include the remote prefix (e.g. "origin/alice/feature-x"); drop it before grouping since the Remotes view already implies the remote. */
function stripRemotePrefix(name: string): string {
	const idx = name.indexOf('/');
	return idx === -1 ? name : name.slice(idx + 1);
}
