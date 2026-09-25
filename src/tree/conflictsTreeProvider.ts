import * as path from 'path';
import * as vscode from 'vscode';
import { GitService } from '../git/gitService';
import { ConflictedFile } from '../git/types';
import { toWorkingChangeUri } from './workingChangeDecoration';

/** Modeled on WorkingCopyTreeProvider, but for paths git has flagged as having an unresolved merge
 * conflict — kept in their own section (only shown at all while a rebase is in progress, see
 * `ggit.rebaseInProgress` in extension.ts) instead of mixed into Working Copy, reusing the same
 * conflict color VS Code's own built-in Git extension uses. Checking a row's box (handled by
 * onDidChangeCheckboxState in extension.ts) is the only way to mark it resolved — there's no
 * "unresolve" concept, so a row's box always starts Unchecked and the row simply disappears once
 * `git status` no longer reports it as conflicted. */
export class ConflictsTreeProvider implements vscode.TreeDataProvider<ConflictedFile> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	constructor(private readonly gitService: GitService) {}

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	async getChildren(element?: ConflictedFile): Promise<ConflictedFile[]> {
		if (element) {
			return [];
		}
		const files = await this.gitService.getConflictedFiles();
		return files.sort((a, b) => a.path.localeCompare(b.path));
	}

	getTreeItem(file: ConflictedFile): vscode.TreeItem {
		const dir = path.dirname(file.path);
		const item = new vscode.TreeItem(path.basename(file.path), vscode.TreeItemCollapsibleState.None);
		item.description = dir === '.' ? undefined : dir;
		item.resourceUri = toWorkingChangeUri(file.path, 'U');
		item.contextValue = 'conflictedFile';
		item.tooltip = `${file.path} — unresolved conflict. Check the box to mark it resolved (saves and stages it).`;
		item.checkboxState = vscode.TreeItemCheckboxState.Unchecked;
		// Just opens the real file — VS Code's built-in inline merge-conflict CodeLens (Accept Current
		// / Incoming / Both / Compare) already kicks in automatically for any document containing
		// standard <<<<<<<  =======  >>>>>>> markers, so there's nothing custom to wire up here.
		item.command = {
			command: 'ggit.openWorkingChangeFile',
			title: 'Open File',
			arguments: [file],
		};
		return item;
	}
}
