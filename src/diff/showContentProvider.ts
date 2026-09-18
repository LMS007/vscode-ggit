import * as vscode from 'vscode';
import { GitService } from '../git/gitService';

export const GGIT_SHOW_SCHEME = 'ggit-show';

/** Sentinel ref meaning "this side of the diff doesn't exist" (added/deleted file). */
export const EMPTY_REF = '__ggit_empty__';

export function toGgitShowUri(relPath: string, ref: string): vscode.Uri {
	const normalized = relPath.startsWith('/') ? relPath : `/${relPath}`;
	return vscode.Uri.from({
		scheme: GGIT_SHOW_SCHEME,
		path: normalized,
		query: `ref=${encodeURIComponent(ref)}`,
	});
}

export class GgitShowContentProvider implements vscode.TextDocumentContentProvider {
	private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
	readonly onDidChange = this._onDidChange.event;

	constructor(private readonly gitService: GitService) {}

	async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
		const ref = new URLSearchParams(uri.query).get('ref');
		if (!ref || ref === EMPTY_REF) {
			return '';
		}
		const relPath = uri.path.replace(/^\//, '');
		try {
			return await this.gitService.getFileContentAtRevision(ref, relPath);
		} catch {
			// Path didn't exist at this revision — treat as an empty side of the diff.
			return '';
		}
	}
}
