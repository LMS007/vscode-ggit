import * as vscode from 'vscode';
import { GitService } from '../git/gitService';

export const GGIT_SHOW_SCHEME = 'ggit-show';

/** Sentinel ref meaning "this side of the diff doesn't exist" (added/deleted file). */
export const EMPTY_REF = '__ggit_empty__';

/** Sentinel ref meaning "the staged (index) copy of this file" — git's `:path` show syntax. */
export const INDEX_REF = '__ggit_index__';

export function toGGitShowUri(relPath: string, ref: string): vscode.Uri {
	const normalized = relPath.startsWith('/') ? relPath : `/${relPath}`;
	return vscode.Uri.from({
		scheme: GGIT_SHOW_SCHEME,
		path: normalized,
		query: `ref=${encodeURIComponent(ref)}`,
	});
}

export class GGitShowContentProvider implements vscode.TextDocumentContentProvider {
	private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
	readonly onDidChange = this._onDidChange.event;

	constructor(private readonly gitService: GitService) {}

	/** Tells VS Code to re-fetch content for every currently-open ggit-show document (HEAD/index
	 * views). This was never called anywhere before, which is why an already-open diff went stale
	 * after staging, unstaging, committing, or discarding changes elsewhere -- provideTextDocumentContent
	 * only re-runs when this event fires for a given URI, and nothing ever fired it. There's no cheap
	 * way to know exactly which URIs' underlying git content actually changed, so this just re-fetches
	 * all open ones; each is a single small `git show`, not expensive to redo on every refresh. */
	refresh(): void {
		for (const doc of vscode.workspace.textDocuments) {
			if (doc.uri.scheme === GGIT_SHOW_SCHEME) {
				this._onDidChange.fire(doc.uri);
			}
		}
	}

	async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
		const ref = new URLSearchParams(uri.query).get('ref');
		if (!ref || ref === EMPTY_REF) {
			return '';
		}
		const relPath = uri.path.replace(/^\//, '');
		const revision = ref === INDEX_REF ? '' : ref;
		try {
			return await this.gitService.getFileContentAtRevision(revision, relPath);
		} catch {
			// Path didn't exist at this revision — treat as an empty side of the diff.
			return '';
		}
	}
}
