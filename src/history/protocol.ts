import type { ChangedFile, CommitInfo } from '../git/types';

export type HostMessage =
	| {
			type: 'commits';
			branchName: string;
			commits: CommitInfo[];
			/** True when this load came from the panel being opened or brought to the front (a new
			 * panel, showBranch's reveal) -- the webview selects the newest commit unconditionally in
			 * that case, rather than sticking with whatever was selected before, since a fresh look at
			 * the panel (e.g. right after committing) should show what's actually new. False for a
			 * background reload (e.g. after a fetch/pull while the panel isn't necessarily even
			 * visible), which keeps the existing sticky-selection behavior instead. */
			focusLatest: boolean;
			/** Whether there are more, older commits beyond this page -- drives whether the webview
			 * requests another page as the user scrolls near the bottom. */
			hasMore: boolean;
			/** How many commits are ready to push -- 0 means nothing to push. Drives the toolbar's
			 * Push button turning green. */
			aheadCount: number;
			/** Whether the branch has an upstream configured at all -- false means it's never been
			 * pushed, which is when the Push button becomes "Publish" instead. */
			hasUpstream: boolean;
			/** Every remote configured for this repo -- populates the toolbar's remote dropdown (always
			 * shown, even with just one entry). An empty array is what makes the Push button fall back
			 * to its disabled-grey "Publish" state -- there's nowhere to publish to yet. */
			remotes: string[];
			/** Which entry in `remotes` is the dropdown's current selection -- persisted host-side (see
			 * SELECTED_REMOTE_KEY) so it survives a panel reload, not just re-derived from scratch every
			 * time. Undefined only when `remotes` is empty. */
			selectedRemote: string | undefined;
			/** This branch's github.com "tree" URL (see GitService.getGitHubBranchUrl) -- undefined
			 * hides the toolbar's "View on GitHub" button entirely, whether that's because the branch
			 * isn't published yet or its remote just isn't GitHub. */
			githubUrl: string | undefined;
			/** Hashes of this branch's not-yet-pushed commits (see GitService.getUnpushedCommits) --
			 * their graph dot and line turn green. Covers later 'moreCommits' pages too, not just this
			 * first one. */
			unpushed: string[];
	  }
	/** A subsequent page, requested via 'loadMoreCommits' -- appended to, not replacing, what's
	 * already rendered. */
	| { type: 'moreCommits'; commits: CommitInfo[]; hasMore: boolean }
	/** A 'loadMoreCommits' request failed -- resets the webview's own loading guard (so scrolling
	 * again retries) without wiping anything already rendered, unlike the generic 'error' message. */
	| { type: 'moreCommitsFailed' }
	/** The bulk pre-load-for-search loop (see ensureCommitsForSearch) finished -- either it reached
	 * the requested minimum, or ran out of history first (hasMore false). Individual pages along the
	 * way still arrive as normal 'moreCommits' messages; this just marks when the loop is done so the
	 * webview knows the "Search older commits" affordance's state is now accurate. */
	| { type: 'searchLoadFinished'; totalLoaded: number; hasMore: boolean }
	| { type: 'files'; sha: string; files: ChangedFile[] }
	/** Every tag name the remotes have, from the Tags view's last check -- any tag badge not in it is
	 * local-only and shown purple. Undefined means no remote could be checked, so no badge is marked. */
	| { type: 'remoteTags'; names: string[] | undefined }
	/** Reply to 'getCommitMessage' -- the commit's full message, subject and body. */
	| { type: 'commitMessage'; sha: string; message: string }
	| { type: 'error'; message: string };

export type WebviewMessage =
	| { type: 'ready' }
	| { type: 'selectCommit'; sha: string }
	/** A commit row was double-clicked open -- its log entry only carries the subject line, so the
	 * full message is fetched separately for the expanded details. */
	| { type: 'getCommitMessage'; sha: string }
	| { type: 'openDiff'; sha: string; file: ChangedFile }
	| { type: 'setSplit'; commitsPercent: number }
	/** `remote` is only ever set for the Push button -- it's the toolbar dropdown's current selection,
	 * forwarded to `ggit.push` so a first-time publish targets it without asking again via its own
	 * picker. Every other toolbar button ignores the extra arg. */
	| { type: 'runAction'; command: string; remote?: string }
	/** The toolbar's remote dropdown was changed -- persisted (see SELECTED_REMOTE_KEY) so it's still
	 * selected next time the panel opens. */
	| { type: 'setRemote'; remote: string }
	| { type: 'resetHead'; sha: string; mode: 'mixed' | 'hard' }
	| { type: 'cherryPick'; sha: string }
	| { type: 'savePatch'; sha: string; subject: string }
	/** The commits pane was scrolled near its bottom and there's more to fetch (see 'commits'.hasMore
	 * / 'moreCommits'.hasMore). */
	| { type: 'loadMoreCommits' }
	/** The file-list pane's open-file icon was clicked -- opens the file's current working-tree copy
	 * for editing (not a historical revision, which wouldn't be editable). */
	| { type: 'openFileForEditing'; path: string }
	/** The search box was focused (first interaction) or "Search older commits" was clicked -- ensure
	 * at least `minCount` commits are loaded, fetching more pages if needed. A cheap no-op if already
	 * satisfied. */
	| { type: 'ensureCommitsForSearch'; minCount: number }
	/** "Copy Commit Hash" from the commit row's context menu -- always the full hash, not the
	 * 7-char short form shown in the row, so it's unambiguous when pasted elsewhere. */
	| { type: 'copyCommitHash'; sha: string }
	/** "Copy Relative Path" / "Copy Path" from a file row's context menu. */
	| { type: 'copyFilePath'; path: string; mode: 'relative' | 'full' }
	| { type: 'revealFileInExplorer'; path: string }
	| { type: 'revealFileInOS'; path: string }
	/** "View on GitHub" was clicked -- the webview can't call vscode.env.openExternal itself, so the
	 * already-host-computed URL (see 'commits'.githubUrl) just gets handed back to open. */
	| { type: 'openExternalUrl'; url: string };
