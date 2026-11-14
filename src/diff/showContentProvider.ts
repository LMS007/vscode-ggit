import * as vscode from 'vscode';
import { GitService } from '../git/gitService';

export const GGIT_SHOW_SCHEME = 'ggit-show';

/** Sentinel ref meaning "this side of the diff doesn't exist" (added/deleted file). */
export const EMPTY_REF = '__ggit_empty__';

/** Sentinel ref meaning "the staged (index) copy of this file" — git's `:path` show syntax. */
export const INDEX_REF = '__ggit_index__';

/** The only ref shapes the extension itself ever puts in a ggit-show URI besides the two sentinels
 * above: a hex object id (commit SHAs and the empty-tree SHA, see openDiff.ts) or the literal HEAD.
 * Anything else is refused before it reaches `git show`, so a crafted URI (from a restored editor or
 * another extension) can't smuggle an option such as `--output=` in through the ref slot. */
const SAFE_REF = /^(?:HEAD|[0-9a-f]{4,64})$/;

/** `repoRoot` says which repository the content comes from -- with several in the opened folder, a
 * diff stays on its own repo's content after GGit switches to another one. */
export function toGGitShowUri(relPath: string, ref: string, repoRoot: string): vscode.Uri {
	const normalized = relPath.startsWith('/') ? relPath : `/${relPath}`;
	return vscode.Uri.from({
		scheme: GGIT_SHOW_SCHEME,
		path: normalized,
		query: `ref=${encodeURIComponent(ref)}&repo=${encodeURIComponent(repoRoot)}`,
	});
}

/** The repository a ggit-show URI reads from. Undefined for one made before URIs carried it (an
 * editor restored from an older session), which reads from the active repository. */
export function ggitShowRepo(uri: vscode.Uri): string | undefined {
	return new URLSearchParams(uri.query).get('repo') ?? undefined;
}

export class GGitShowContentProvider implements vscode.TextDocumentContentProvider {
	private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
	readonly onDidChange = this._onDidChange.event;

	/** `serviceFor` maps a URI's repository to its GitService: the active one's when the URI names
	 * none, and undefined for a path that isn't one of the repositories GGit lists. */
	constructor(private readonly serviceFor: (repoRoot: string | undefined) => GitService | undefined) {}

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
		if (ref !== INDEX_REF && !SAFE_REF.test(ref)) {
			return '';
		}
		const gitService = this.serviceFor(ggitShowRepo(uri));
		if (!gitService) {
			return '';
		}
		const relPath = uri.path.replace(/^\//, '');
		const revision = ref === INDEX_REF ? '' : ref;
		try {
			return await gitService.getFileContentAtRevision(revision, relPath);
		} catch {
			// Path didn't exist at this revision — treat as an empty side of the diff.
			return '';
		}
	}
}
