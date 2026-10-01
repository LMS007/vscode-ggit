import * as vscode from 'vscode';
import { BranchInfo } from '../git/types';
import { BranchTreeNode } from './branchTree';

/** The Branches view's own tree mime type (VS Code's recommended `application/vnd.code.tree.<view id,
 * lowercased>`). Accepting only this is also what keeps drops from anywhere else -- the Remotes view,
 * files from the Explorer -- from ever reaching handleDrop: a merge source has to be a local branch. */
const BRANCHES_MIME = 'application/vnd.code.tree.ggitbranches';

/** Drag one local branch onto the checked-out (HEAD) branch to merge it in -- Tower's interaction
 * model. Any other drop is deliberately a silent no-op rather than an error: VS Code has no API to
 * refuse a drop target while hovering, so every row shows the same drop indicator, and a stray drop
 * on the wrong row shouldn't nag. */
export class BranchesDragAndDropController implements vscode.TreeDragAndDropController<BranchTreeNode<BranchInfo>> {
	readonly dragMimeTypes = [BRANCHES_MIME];
	readonly dropMimeTypes = [BRANCHES_MIME];

	constructor(private readonly onMergeRequested: (sourceBranch: string, intoBranch: string) => void) {}

	handleDrag(source: readonly BranchTreeNode<BranchInfo>[], dataTransfer: vscode.DataTransfer): void {
		// Branch names, not the tree nodes themselves -- a refresh can land mid-drag and replace every
		// node, and startMerge re-checks everything against live git state regardless. A folder isn't
		// a branch, so dragging one carries nothing and its drop falls through below.
		const names = source.filter(node => node.kind === 'leaf').map(node => node.item.name);
		if (names.length > 0) {
			dataTransfer.set(BRANCHES_MIME, new vscode.DataTransferItem(names));
		}
	}

	handleDrop(target: BranchTreeNode<BranchInfo> | undefined, dataTransfer: vscode.DataTransfer): void {
		// Merging only ever goes *into* whatever's checked out -- dropping onto any other branch (or a
		// folder, or empty space) isn't a merge GGit can do, so it does nothing.
		if (!target || target.kind !== 'leaf' || !target.item.isHead) {
			return;
		}
		const names = dataTransfer.get(BRANCHES_MIME)?.value as string[] | undefined;
		const sourceBranch = names?.[0];
		if (!sourceBranch || sourceBranch === target.item.name) {
			return;
		}
		this.onMergeRequested(sourceBranch, target.item.name);
	}
}
