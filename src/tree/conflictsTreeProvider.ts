import * as vscode from 'vscode';
import { toResolveConflictsUri } from './workingChangeDecoration';

/** The Conflicts view's only possible row -- see the class doc below. */
type ResolveConflictsNode = 'resolveConflicts';

/** Only shown at all while a rebase is in progress (see `ggit.rebaseInProgress` in extension.ts).
 * Resolving conflicts itself happens in the dedicated Rebase tab (see RebaseConflictsPanel), not
 * here -- this view is just a permanent, always-visible entry point back into that tab, so there's
 * still something in the sidebar to click even after the tab's been closed or moved out of focus. */
export class ConflictsTreeProvider implements vscode.TreeDataProvider<ResolveConflictsNode> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	getChildren(element?: ResolveConflictsNode): ResolveConflictsNode[] {
		return element ? [] : ['resolveConflicts'];
	}

	getTreeItem(): vscode.TreeItem {
		const item = new vscode.TreeItem('Resolve Conflicts', vscode.TreeItemCollapsibleState.None);
		item.resourceUri = toResolveConflictsUri();
		item.tooltip = 'Open the Rebase tab to resolve the current conflict.';
		item.command = { command: 'ggit.openRebaseTab', title: 'Resolve Conflicts' };
		return item;
	}
}
