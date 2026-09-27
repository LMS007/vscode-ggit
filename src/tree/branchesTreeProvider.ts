import * as path from 'path';
import * as vscode from 'vscode';
import { GitService } from '../git/gitService';
import { BranchInfo } from '../git/types';
import { toBranchUri } from './activeBranchDecoration';
import { BranchTreeLeaf, BranchTreeNode, buildBranchTree, sortTree } from './branchTree';
import { RecentBranches } from './recentBranches';

const PINNED_BRANCHES = ['main', 'master'];

export class BranchesTreeProvider implements vscode.TreeDataProvider<BranchTreeNode<BranchInfo>> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	constructor(
		private readonly gitService: GitService,
		private readonly extensionUri: vscode.Uri,
		private readonly recentBranches: RecentBranches
	) {}

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	async getChildren(element?: BranchTreeNode<BranchInfo>): Promise<BranchTreeNode<BranchInfo>[]> {
		if (element) {
			return element.kind === 'folder' ? element.children : [];
		}
		return this.gitService.time('BranchesTreeProvider.getChildren', async () => {
			const branches = await this.gitService.listLocalBranches();
			const byName = new Map(branches.map(b => [b.name, b]));

			// The current branch always wins the top slot regardless of what's in the persisted
			// history -- self-healing if a checkout from outside GGit (or the very first run ever) never
			// got recorded, rather than depending on that history being perfectly complete.
			const current = branches.find(b => b.isHead)?.name;
			const persisted = this.recentBranches.get().filter(name => byName.has(name));
			const pinnedCount = this.recentBranches.getPinnedCount();
			const recentNames = dedupe(current ? [current, ...persisted] : persisted).slice(0, pinnedCount);

			// main/master only gets its own pinned row here when it *isn't* already one of the recents
			// above -- otherwise it'd render twice.
			const mainName = PINNED_BRANCHES.find(name => byName.has(name) && !recentNames.includes(name));

			const shown = new Set([...recentNames, ...(mainName ? [mainName] : [])]);
			const remaining = branches.filter(b => !shown.has(b.name));

			return [
				// Flat -- unlike the grouped tree below, a recent/pinned row always shows its full name,
				// never just its last path segment, since there's no folder here to supply the rest.
				...recentNames.map(name => flatLeaf(byName.get(name)!)),
				...(mainName ? [flatLeaf(byName.get(mainName)!)] : []),
				...sortTree(buildBranchTree(remaining, b => b.name), PINNED_BRANCHES),
			];
		});
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
		item.resourceUri = toBranchUri(branch.name, branch.isHead ? 'active' : branch.worktreePath ? 'checked-out-elsewhere' : 'none');
		const descriptionParts = [
			branch.isHead ? 'HEAD' : undefined,
			formatTracking(branch),
			branch.worktreePath ? path.basename(branch.worktreePath) : undefined,
		].filter(Boolean);
		item.description = descriptionParts.length > 0 ? descriptionParts.join(' ') : undefined;
		if (branch.worktreePath) {
			item.tooltip = `${branch.name} — checked out in another worktree at ${branch.worktreePath}`;
		}
		// "-head" / "-other-worktree" both let ggit.deleteLocalBranch's `enablement` grey itself out
		// (see package.json) — git itself refuses either delete anyway, but a disabled menu entry says
		// so up front instead of via an error after clicking. Checkout itself is separately guarded in
		// GitService.checkoutBranch regardless of contextValue, using a live worktree lookup rather than
		// whatever this tree happened to render last.
		item.contextValue = branch.isHead ? 'branch-head' : branch.worktreePath ? 'branch-other-worktree' : 'branch-normal';
		item.command = {
			command: 'ggit.branchClicked',
			title: 'Open History / Switch Branch',
			arguments: [branch.name],
		};
		return item;
	}
}

/** A leaf for the Recents/pinned-main rows -- same shape buildBranchTree would produce for a
 * slash-free branch, except `name` is always the branch's full name rather than its last path
 * segment, since these render outside any folder that would otherwise supply the rest of it. */
function flatLeaf(branch: BranchInfo): BranchTreeLeaf<BranchInfo> {
	return { kind: 'leaf', name: branch.name, id: branch.name, item: branch };
}

function dedupe(names: string[]): string[] {
	return [...new Set(names)];
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
