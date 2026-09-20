import * as vscode from 'vscode';
import { GitService } from '../git/gitService';

export const GGIT_BRANCH_SCHEME = 'ggit-branch';

export function toBranchUri(branchName: string): vscode.Uri {
	return vscode.Uri.from({ scheme: GGIT_BRANCH_SCHEME, path: `/${branchName}` });
}

/** Tints the active (HEAD) branch's label — a FileDecorationProvider is the only way to color a TreeItem's text without replacing its icon. */
export class ActiveBranchDecorationProvider implements vscode.FileDecorationProvider {
	private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
	readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

	constructor(private readonly gitService: GitService) {}

	refresh(): void {
		this._onDidChangeFileDecorations.fire(undefined);
	}

	async provideFileDecoration(uri: vscode.Uri): Promise<vscode.FileDecoration | undefined> {
		if (uri.scheme !== GGIT_BRANCH_SCHEME) {
			return undefined;
		}
		const branchName = uri.path.replace(/^\//, '');
		const current = await this.gitService.getCurrentBranch();
		if (branchName !== current) {
			return undefined;
		}
		return { color: new vscode.ThemeColor('charts.green') };
	}
}
