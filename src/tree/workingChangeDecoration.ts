import * as vscode from 'vscode';
import { FileStatus } from '../git/types';

/** A synthetic scheme (not a real file) purely so FileDecorationProvider has something to key off of
 * without colliding with the built-in Git extension's own decorations on real file:// URIs. */
export const GGIT_WORKING_CHANGE_SCHEME = 'ggit-workingchange';

export function toWorkingChangeUri(filePath: string, status: FileStatus): vscode.Uri {
	return vscode.Uri.from({ scheme: GGIT_WORKING_CHANGE_SCHEME, path: `/${filePath}`, query: status });
}

/** Not a real file status — a distinct query value so the same decoration provider can also color
 * the synthetic "Create Commit" row's label text, the same way it colors real files by status. */
const CREATE_COMMIT_MARKER = '__create_commit__';

export function toCreateCommitUri(): vscode.Uri {
	return vscode.Uri.from({ scheme: GGIT_WORKING_CHANGE_SCHEME, path: '/__create_commit__', query: CREATE_COMMIT_MARKER });
}

const STATUS_COLOR_TOKENS: Record<FileStatus, string> = {
	A: 'gitDecoration.addedResourceForeground',
	M: 'gitDecoration.modifiedResourceForeground',
	D: 'gitDecoration.deletedResourceForeground',
	R: 'gitDecoration.renamedResourceForeground',
	C: 'gitDecoration.renamedResourceForeground',
	T: 'gitDecoration.modifiedResourceForeground',
	'?': 'gitDecoration.untrackedResourceForeground',
	U: 'gitDecoration.conflictingResourceForeground',
};

export class WorkingChangeDecorationProvider implements vscode.FileDecorationProvider {
	private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
	readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

	refresh(): void {
		this._onDidChangeFileDecorations.fire(undefined);
	}

	provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
		if (uri.scheme !== GGIT_WORKING_CHANGE_SCHEME) {
			return undefined;
		}
		if (uri.query === CREATE_COMMIT_MARKER) {
			// Same link-blue VS Code itself uses for clickable text — no real file status to badge.
			return { color: new vscode.ThemeColor('textLink.foreground') };
		}
		const status = uri.query as FileStatus;
		return {
			badge: status,
			color: new vscode.ThemeColor(STATUS_COLOR_TOKENS[status] ?? STATUS_COLOR_TOKENS.M),
			tooltip: status,
		};
	}
}
