import * as vscode from 'vscode';
import { ConflictOperation } from '../conflicts/conflictsProtocol';
import { toResolveConflictsUri } from './workingChangeDecoration';

/** The Conflicts view's only possible row -- see the class doc below. */
type ResolveConflictsNode = 'resolveConflicts';

/** Only shown at all while a rebase, merge, cherry-pick, or revert is stopped (see
 * `ggit.rebaseInProgress` / `ggit.mergeInProgress` / `ggit.pickInProgress` in extension.ts). Resolving conflicts itself happens in the dedicated
 * Conflicts tab (see ConflictsPanel), not here -- this view is just a permanent, always-visible entry
 * point back into that tab, so there's still something in the sidebar to click even after the tab's
 * been closed or moved out of focus. */
export class ConflictsTreeProvider implements vscode.TreeDataProvider<ResolveConflictsNode> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private operation: ConflictOperation = 'rebase';

	/** Set by updateConflictContext in extension.ts before each refresh -- only changes the row's
	 * wording, since the tab it opens works out for itself which operation it's showing. */
	setOperation(operation: ConflictOperation): void {
		this.operation = operation;
	}

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	getChildren(element?: ResolveConflictsNode): ResolveConflictsNode[] {
		return element ? [] : ['resolveConflicts'];
	}

	getTreeItem(): vscode.TreeItem {
		// "Finish Merge" rather than "Resolve Conflicts" -- a --no-commit merge stops here too, with
		// nothing to resolve, only a commit left to make.
		const label = this.operation === 'merge' ? 'Finish Merge' : 'Resolve Conflicts';
		const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
		item.resourceUri = toResolveConflictsUri();
		item.tooltip =
			this.operation === 'merge'
				? 'Open the Merge tab to resolve any conflicts and commit the merge.'
				: this.operation === 'rebase'
					? 'Open the Rebase tab to resolve the current conflict.'
					: `Open the ${this.operation === 'revert' ? 'Revert' : 'Cherry-Pick'} tab to resolve its conflicts and commit it.`;
		item.command = { command: 'ggit.openConflictsTab', title: label };
		return item;
	}
}
