import * as vscode from 'vscode';

export const GGIT_BRANCH_SCHEME = 'ggit-branch';

/** "active" = checked out here (green), "checked-out-elsewhere" = checked out in another worktree
 * (blue, and un-checkoutable from here), "none" = plain. Baked into the URI at tree-build time
 * (branchesTreeProvider already knows all three from BranchInfo) rather than looked up here, so
 * this provider never has to make its own git call per row. */
export type BranchDecorationState = 'active' | 'checked-out-elsewhere' | 'none';

export function toBranchUri(branchName: string, state: BranchDecorationState): vscode.Uri {
	return vscode.Uri.from({ scheme: GGIT_BRANCH_SCHEME, path: `/${branchName}`, query: state });
}

/** Tints a branch's label — a FileDecorationProvider is the only way to color a TreeItem's text without replacing its icon. */
export class ActiveBranchDecorationProvider implements vscode.FileDecorationProvider {
	private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
	readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

	refresh(): void {
		this._onDidChangeFileDecorations.fire(undefined);
	}

	provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
		if (uri.scheme !== GGIT_BRANCH_SCHEME) {
			return undefined;
		}
		if (uri.query === 'active') {
			return { color: new vscode.ThemeColor('charts.green') };
		}
		if (uri.query === 'checked-out-elsewhere') {
			return { color: new vscode.ThemeColor('charts.blue') };
		}
		return undefined;
	}
}
