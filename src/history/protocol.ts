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
	  }
	/** A subsequent page, requested via 'loadMoreCommits' -- appended to, not replacing, what's
	 * already rendered. */
	| { type: 'moreCommits'; commits: CommitInfo[]; hasMore: boolean }
	/** A 'loadMoreCommits' request failed -- resets the webview's own loading guard (so scrolling
	 * again retries) without wiping anything already rendered, unlike the generic 'error' message. */
	| { type: 'moreCommitsFailed' }
	| { type: 'files'; sha: string; files: ChangedFile[] }
	| { type: 'error'; message: string };

export type WebviewMessage =
	| { type: 'ready' }
	| { type: 'selectCommit'; sha: string }
	| { type: 'openDiff'; sha: string; file: ChangedFile }
	| { type: 'setSplit'; commitsPercent: number }
	| { type: 'runAction'; command: string }
	| { type: 'resetHead'; sha: string; mode: 'mixed' | 'hard' }
	| { type: 'cherryPick'; sha: string }
	| { type: 'savePatch'; sha: string; subject: string }
	/** The commits pane was scrolled near its bottom and there's more to fetch (see 'commits'.hasMore
	 * / 'moreCommits'.hasMore). */
	| { type: 'loadMoreCommits' };
