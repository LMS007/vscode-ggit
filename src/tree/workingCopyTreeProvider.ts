import * as path from 'path';
import * as vscode from 'vscode';
import { GitService } from '../git/gitService';
import { WorkingChangeFile } from '../git/types';
import { toWorkingChangeUri } from './workingChangeDecoration';

/** A flat staged+unstaged file list, styled after the built-in Git extension's Changes views but
 * collapsed into a single section — staged vs. unstaged is the leading checkbox, which the tree view's
 * own onDidChangeCheckboxState handles (see extension.ts) to actually stage/unstage on click. */
export class WorkingCopyTreeProvider implements vscode.TreeDataProvider<WorkingChangeFile> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	constructor(private readonly gitService: GitService) {}

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	async getChildren(element?: WorkingChangeFile): Promise<WorkingChangeFile[]> {
		if (element) {
			return [];
		}
		const files = await this.gitService.getWorkingChanges();
		// Sorted by path only — deliberately not re-grouped by staged/unstaged, so checking a box
		// doesn't reshuffle the list out from under you.
		return files.sort((a, b) => a.path.localeCompare(b.path));
	}

	getTreeItem(file: WorkingChangeFile): vscode.TreeItem {
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
