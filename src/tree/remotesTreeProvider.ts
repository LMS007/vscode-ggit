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
			const remoteNames = await this.gitService.listRemotes();
			const branchesByRemote = await Promise.all(remoteNames.map(name => this.gitService.listRemoteBranches(name)));
			const branches = branchesByRemote.flat();
			const term = this.filterTerm.toLowerCase();
			const filtered = term ? branches.filter(b => stripRemotePrefix(b.name).toLowerCase().includes(term)) : branches;
			// Each branch's own `name` already carries its remote prefix (e.g. "origin/main" vs.
			// "upstream/main") -- building the tree from the full name rather than the
			// prefix-stripped one is what turns that leading segment into its own top-level folder,
			// so a repo with multiple remotes gets one folder per remote instead of a single flat
			// (and ambiguous, if two remotes shared a branch name) list.
			return sortTree(buildBranchTree(filtered, b => b.name));
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
			// A top-level folder (no "/" in its id) is a remote itself, e.g. "origin" -- everything
			// nested under it is that remote's own branch-path grouping, same as before. Distinct icon
			// and contextValue so a remote reads as a different kind of thing than a plain path folder.
			const isRemoteRoot = !node.id.includes('/');
			// 'repo' (not 'cloud') for the root -- leaf branches below already use 'cloud', so reusing
			// it here would make a remote's own row look like just another branch instead of the thing
			// that contains them.
			item.iconPath = new vscode.ThemeIcon(isRemoteRoot ? 'repo' : 'folder');
			item.contextValue = isRemoteRoot ? 'remoteRoot' : 'remoteBranchFolder';
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
