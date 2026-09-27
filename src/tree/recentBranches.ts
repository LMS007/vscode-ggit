import * as vscode from 'vscode';

const RECENT_BRANCHES_KEY = 'ggit.recentBranches';
const PINNED_COUNT_KEY = 'ggit.pinnedBranchCount';

export const DEFAULT_PINNED_BRANCH_COUNT = 5;
export const MIN_PINNED_BRANCH_COUNT = 1;
export const MAX_PINNED_BRANCH_COUNT = 30;

/** Most-recently-checked-out-first list of branch names -- git itself has no concept of this, so it's
 * tracked here and persisted per-workspace (workspaceState, not globalState: recency is meaningless
 * shared across unrelated repos opened in other windows). Persisted history is always kept up to the
 * hard ceiling (MAX_PINNED_BRANCH_COUNT) regardless of the user's current pin count -- only *display*
 * (see BranchesTreeProvider) is capped to that -- so turning the count back up after lowering it
 * immediately surfaces branches it already knew about, rather than needing them re-visited first. */
export class RecentBranches {
	private lastKnownCurrent: string | undefined;

	constructor(private readonly workspaceState: vscode.Memento) {}

	get(): string[] {
		return this.workspaceState.get<string[]>(RECENT_BRANCHES_KEY, []);
	}

	/** How many of `get()`'s branches the Branches view actually pins at the top -- set via the
	 * thumbtack button's input box (see extension.ts's ggit.setPinnedBranchCount). */
	getPinnedCount(): number {
		return this.workspaceState.get<number>(PINNED_COUNT_KEY, DEFAULT_PINNED_BRANCH_COUNT);
	}

	async setPinnedCount(count: number): Promise<void> {
		await this.workspaceState.update(PINNED_COUNT_KEY, count);
	}

	/** Called with whatever branch is currently checked out every time it might have changed -- records
	 * it as the new most-recent the moment it's actually different from last time, regardless of
	 * whether that checkout happened via GGit's own command or the integrated terminal. Returns whether
	 * it actually changed, so the caller knows whether the Branches view is worth refreshing again. */
	async syncCurrentBranch(current: string | undefined): Promise<boolean> {
		if (!current || current === this.lastKnownCurrent) {
			return false;
		}
		this.lastKnownCurrent = current;
		const existing = this.get().filter(name => name !== current);
		await this.workspaceState.update(RECENT_BRANCHES_KEY, [current, ...existing].slice(0, MAX_PINNED_BRANCH_COUNT));
		return true;
	}
}
