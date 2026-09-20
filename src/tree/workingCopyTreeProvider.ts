import * as path from 'path';
import * as vscode from 'vscode';
import { GitService } from '../git/gitService';
import { WorkingChangeFile } from '../git/types';
import { toCreateCommitUri, toWorkingChangeUri } from './workingChangeDecoration';

/** Pinned above the file list — its checkbox is a check-all/uncheck-all for staging (checked only
 * when every change is already staged), and clicking the row itself opens the Commit panel. */
interface CreateCommitNode {
	kind: 'createCommit';
	allStaged: boolean;
	stagedCount: number;
}

export type WorkingCopyNode = WorkingChangeFile | CreateCommitNode;

export function isCreateCommitNode(node: WorkingCopyNode): node is CreateCommitNode {
	return 'kind' in node && node.kind === 'createCommit';
}

export function isWorkingChangeFile(node: WorkingCopyNode): node is WorkingChangeFile {
	return !isCreateCommitNode(node);
}

/** A flat staged+unstaged file list, styled after the built-in Git extension's Changes views but
 * collapsed into a single section — staged vs. unstaged is the leading checkbox, which the tree view's
 * own onDidChangeCheckboxState handles (see extension.ts) to actually stage/unstage on click. */
export class WorkingCopyTreeProvider implements vscode.TreeDataProvider<WorkingCopyNode> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	constructor(private readonly gitService: GitService) {}

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	async getChildren(element?: WorkingCopyNode): Promise<WorkingCopyNode[]> {
		if (element) {
			return [];
		}
		const files = await this.gitService.getWorkingChanges();
		// Sorted by path only — deliberately not re-grouped by staged/unstaged, so checking a box
		// doesn't reshuffle the list out from under you.
		const sorted = files.sort((a, b) => a.path.localeCompare(b.path));
		const stagedCount = sorted.filter(f => f.state === 'staged').length;
		const allStaged = sorted.length > 0 && stagedCount === sorted.length;
		return [{ kind: 'createCommit', allStaged, stagedCount }, ...sorted];
	}

	getTreeItem(node: WorkingCopyNode): vscode.TreeItem {
		if (isCreateCommitNode(node)) {
			const item = new vscode.TreeItem('Create Commit', vscode.TreeItemCollapsibleState.None);
			item.iconPath = new vscode.ThemeIcon('git-commit', new vscode.ThemeColor('textLink.foreground'));
			item.resourceUri = toCreateCommitUri();
			item.checkboxState = node.allStaged ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
			// TreeItem.description is the only slot that renders after the label — same trick already
			// used for branch ahead/behind counts — so it's the closest thing to "right-aligned" here.
			item.description = String(node.stagedCount);
			item.tooltip = 'Check to stage everything, uncheck to unstage everything. Click to open Commit.';
			item.contextValue = 'createCommitAction';
			item.command = { command: 'ggit.commit', title: 'Create Commit' };
			return item;
		}
		const file = node;
		const dir = path.dirname(file.path);
		const item = new vscode.TreeItem(path.basename(file.path), vscode.TreeItemCollapsibleState.None);
		item.description = dir === '.' ? undefined : dir;
		item.resourceUri = toWorkingChangeUri(file.path, file.status);
		item.checkboxState =
			file.state === 'staged' ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
		item.contextValue = file.state === 'staged' ? 'workingChangeStaged' : 'workingChangeUnstaged';
		item.tooltip = `${file.path} (${file.state})`;
		item.command = {
			command: 'ggit.openWorkingChangeDiff',
			title: 'Open Diff',
			arguments: [file],
		};
		return item;
	}
}
