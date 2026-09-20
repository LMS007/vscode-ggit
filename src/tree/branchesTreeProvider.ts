import * as vscode from 'vscode';
import { GitService } from '../git/gitService';
import { BranchInfo } from '../git/types';
import { toBranchUri } from './activeBranchDecoration';
import { BranchTreeNode, buildBranchTree, sortTree } from './branchTree';

const PINNED_BRANCHES = ['main', 'master'];

export class BranchesTreeProvider implements vscode.TreeDataProvider<BranchTreeNode<BranchInfo>> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	constructor(private readonly gitService: GitService, private readonly extensionUri: vscode.Uri) {}

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	async getChildren(element?: BranchTreeNode<BranchInfo>): Promise<BranchTreeNode<BranchInfo>[]> {
		if (element) {
			return element.kind === 'folder' ? element.children : [];
		}
		const branches = await this.gitService.listLocalBranches();
		return sortTree(buildBranchTree(branches, b => b.name), PINNED_BRANCHES);
	}

	getTreeItem(node: BranchTreeNode<BranchInfo>): vscode.TreeItem {
		if (node.kind === 'folder') {
			const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.Collapsed);
			item.iconPath = containsActiveBranch(node)
				? {
						light: vscode.Uri.joinPath(this.extensionUri, 'media', 'folder-green-light.svg'),
						dark: vscode.Uri.joinPath(this.extensionUri, 'media', 'folder-green-dark.svg'),
					}
				: new vscode.ThemeIcon('folder');
			item.contextValue = 'branchFolder';
			return item;
		}
		const branch = node.item;
		const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.None);
		// A custom SVG (rather than ThemeIcon + ThemeColor) keeps this icon green even when
		// the row is selected — VS Code recolors ThemeIcon colors to match selection state,
		// but leaves custom icon images alone.
		item.iconPath = branch.isHead
			? {
					light: vscode.Uri.joinPath(this.extensionUri, 'media', 'target-green-light.svg'),
					dark: vscode.Uri.joinPath(this.extensionUri, 'media', 'target-green-dark.svg'),
				}
			: new vscode.ThemeIcon('git-branch');
		item.resourceUri = toBranchUri(branch.name);
		item.description = branch.isHead ? 'HEAD' : undefined;
		// "-head" vs "-normal" lets ggit.deleteLocalBranch's `enablement` grey itself out for the
		// checked-out branch (see package.json) — git itself refuses to delete it anyway, but a
		// disabled menu entry says so up front instead of via an error after clicking.
		item.contextValue = branch.isHead ? 'branch-head' : 'branch-normal';
		item.command = {
			command: 'ggit.branchClicked',
			title: 'Open History / Switch Branch',
			arguments: [branch.name],
		};
		return item;
	}
}

/** Whether the current HEAD branch lives anywhere under this folder — used to color it green. */
function containsActiveBranch(node: BranchTreeNode<BranchInfo>): boolean {
	if (node.kind === 'leaf') {
		return node.item.isHead;
	}
	return node.children.some(containsActiveBranch);
}
