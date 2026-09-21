import * as vscode from 'vscode';
import { GitService, stripRemotePrefix } from '../git/gitService';
import { RemoteBranchInfo } from '../git/types';
import { BranchTreeNode, buildBranchTree, sortTree } from './branchTree';

export class RemotesTreeProvider implements vscode.TreeDataProvider<BranchTreeNode<RemoteBranchInfo>> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
	private filterTerm = '';

	constructor(private readonly gitService: GitService) {}

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	/** Case-insensitive substring filter over the branch name (not the "origin/" prefix) — live,
	 * fires a refresh on every call, meant to be driven by an InputBox's onDidChangeValue. */
	setFilter(term: string): void {
		this.filterTerm = term.trim();
		this.refresh();
	}

	get isFiltered(): boolean {
		return this.filterTerm.length > 0;
	}

	get filter(): string {
		return this.filterTerm;
	}

	async getChildren(element?: BranchTreeNode<RemoteBranchInfo>): Promise<BranchTreeNode<RemoteBranchInfo>[]> {
		if (element) {
			return element.kind === 'folder' ? element.children : [];
		}
		return this.gitService.time('RemotesTreeProvider.getChildren', async () => {
			const branches = await this.gitService.listRemoteBranches('origin');
			const term = this.filterTerm.toLowerCase();
			const filtered = term ? branches.filter(b => stripRemotePrefix(b.name).toLowerCase().includes(term)) : branches;
			return sortTree(buildBranchTree(filtered, b => stripRemotePrefix(b.name)));
		});
	}

	getTreeItem(node: BranchTreeNode<RemoteBranchInfo>): vscode.TreeItem {
		if (node.kind === 'folder') {
			// Every folder that survives filtering contains a match by construction (getChildren only
			// builds the tree from already-filtered branches), so it should always show expanded while
			// filtering -- a "#filtered" suffix on the id keeps this from colliding with whatever
			// expand/collapse state the same folder remembered from the unfiltered view (ids are what
			// let VS Code remember a manual toggle across refreshes; reusing the plain id here could
			// mean a folder the user previously collapsed stays collapsed despite now containing a match).
			const item = new vscode.TreeItem(
				node.name,
				this.isFiltered ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed
			);
			item.id = this.isFiltered ? `${node.id}#filtered` : node.id;
			item.iconPath = new vscode.ThemeIcon('folder');
			item.contextValue = 'remoteBranchFolder';
			return item;
		}
		const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.None);
		item.id = node.id;
		item.iconPath = new vscode.ThemeIcon('cloud');
		item.contextValue = 'remoteBranch';
		item.command = {
			command: 'ggit.remoteBranchClicked',
			title: 'Check Out Remote Branch',
			arguments: [node.item.name],
		};
		return item;
	}
}
