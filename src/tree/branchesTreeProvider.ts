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
			const isActiveBranchFolder = containsActiveBranch(node);
			// A stable id (see branchTree.ts) is what lets this Expanded/Collapsed choice act as just
			// the *default* — once VS Code has seen this id, it remembers whatever the user actually
			// toggled it to across later refreshes instead of resetting it back to this every time.
			const item = new vscode.TreeItem(
				node.name,
				isActiveBranchFolder ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed
			);
			item.id = node.id;
			item.iconPath = isActiveBranchFolder
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
		item.id = node.id;
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
		const descriptionParts = [branch.isHead ? 'HEAD' : undefined, formatTracking(branch)].filter(Boolean);
		item.description = descriptionParts.length > 0 ? descriptionParts.join(' ') : undefined;
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

/** "↑9" ahead, "↓8" behind, "↑2 ↓3" diverged, or undefined if up to date / no upstream. There's no
 * TreeItem API for Tower's colored-circle-plus-arrow badge, so this leans on the same description
 * field already used for "HEAD" — the arrow characters are as close to a compact icon as plain text
 * gets here. */
function formatTracking(branch: BranchInfo): string | undefined {
	const parts: string[] = [];
	if (branch.ahead) {
		parts.push(`↑${branch.ahead}`);
	}
	if (branch.behind) {
		parts.push(`↓${branch.behind}`);
	}
	return parts.length > 0 ? parts.join(' ') : undefined;
}

/** Whether the current HEAD branch lives anywhere under this folder — used to color it green. */
function containsActiveBranch(node: BranchTreeNode<BranchInfo>): boolean {
	if (node.kind === 'leaf') {
		return node.item.isHead;
	}
	return node.children.some(containsActiveBranch);
}
