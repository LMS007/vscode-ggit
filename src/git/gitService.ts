import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { simpleGit, SimpleGit } from 'simple-git';
import {
	BranchInfo,
	ChangedFile,
	CommitInfo,
	ConflictedFile,
	FileStatus,
	RefBadge,
	RemoteBranchInfo,
	StashInfo,
	WorkingChangeFile,
} from './types';

const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const FIELD_SEP = '\x1f';
const LOG_FORMAT = ['%H', '%P', '%an', '%ae', '%aI', '%s', '%D'].join(FIELD_SEP);
const STASH_FORMAT = ['%gd', '%H', '%s', '%aI'].join(FIELD_SEP);

export class GitService {
	private readonly git: SimpleGit;
	private gitDirPath?: string;

	constructor(readonly repoRoot: string, private readonly logger?: (message: string) => void) {
		// simple-git blocks `-c core.editor=...` by default as a potential command-injection vector —
		// reasonable when that value could come from user input, but ours is always the hardcoded
		// literal "true" (see rebaseOnto/rebaseContinue/rebaseSkip below), never anything external.
		this.git = simpleGit({ baseDir: repoRoot, unsafe: { allowUnsafeEditor: true } });
	}

	/** Lets other classes holding a GitService reference (tree providers, panels) write to the same
	 * "GGit" output channel this is constructed with, without each one needing its own wiring. */
	log(message: string): void {
		this.logger?.(message);
	}

	/** Times an async block and logs it to the "GGit" output channel -- added specifically to
	 * diagnose Remote-SSH slowness (each view load, and the git spawns underneath it, is a lot more
	 * exposed to network/disk latency on the remote host than the same work is locally), so this can
	 * be dropped anywhere views seem slow to actually see where time goes, instead of guessing. */
	async time<T>(label: string, fn: () => Promise<T>): Promise<T> {
		const start = Date.now();
		try {
			return await fn();
		} finally {
			this.logger?.(`[timing] ${label}: ${Date.now() - start}ms`);
		}
	}

	async isGitRepository(): Promise<boolean> {
		return this.git.checkIsRepo();
	}

	/** Resolved via git itself (not a hardcoded ".git" join) so this also works for worktrees, where
	 * .git is a file pointing elsewhere rather than the directory itself. */
	private async getGitDir(): Promise<string> {
		if (!this.gitDirPath) {
			const raw = (await this.git.raw(['rev-parse', '--git-dir'])).trim();
			this.gitDirPath = path.isAbsolute(raw) ? raw : path.join(this.repoRoot, raw);
		}
		return this.gitDirPath;
	}

	/** git leaves a rebase-merge directory (or, for the legacy apply-based backend, rebase-apply) under
	 * .git for the entire span of an in-progress rebase — conflicted or not — until --continue finishes
	 * it or --abort/--skip clears it. That's the same thing plain `git status` checks to print "you are
	 * currently rebasing" banners. */
	async isRebaseInProgress(): Promise<boolean> {
		const gitDir = await this.getGitDir();
		return fs.existsSync(path.join(gitDir, 'rebase-merge')) || fs.existsSync(path.join(gitDir, 'rebase-apply'));
	}

	async listLocalBranches(): Promise<BranchInfo[]> {
		const [summary, trackingOut, worktreeOwners] = await Promise.all([
			this.time('listLocalBranches: branchLocal()', () => this.git.branchLocal()),
			this.time('listLocalBranches: for-each-ref', () =>
				this.git.raw(['for-each-ref', `--format=%(refname:short)${FIELD_SEP}%(upstream:track)`, 'refs/heads'])
			),
			this.time('listLocalBranches: getBranchWorktreeOwners', () => this.getBranchWorktreeOwners()),
		]);
		const tracking = new Map<string, { ahead?: number; behind?: number }>();
		for (const line of trackingOut.split('\n')) {
			if (!line) {
				continue;
			}
			const [name, track] = line.split(FIELD_SEP);
			const ahead = Number(track.match(/ahead (\d+)/)?.[1]);
			const behind = Number(track.match(/behind (\d+)/)?.[1]);
			tracking.set(name, {
				ahead: ahead > 0 ? ahead : undefined,
				behind: behind > 0 ? behind : undefined,
			});
		}
		// simple-git's branch-summary parser splits each `git branch -v` line on whitespace, which
		// mis-parses git's own synthetic "not really on a branch" status lines -- e.g. mid-rebase,
		// `git branch` shows "* (no branch, rebasing <branch>) <sha> <subject>", and the naive split
		// treats "(no" (just the first token) as the branch name. Verified against a real rebase:
		// simple-git returns summary.current === "(no" and includes "(no" in summary.all as if it
		// were a real branch -- and even its own `summary.detached` flag comes back false here (it
		// only recognizes the plain "(HEAD detached at ...)" phrasing, not this rebase-flavored one).
		// No real branch name can start with "(", so that's what filters it out here, rather than
		// matching the exact (and possibly locale-dependent) wording git uses.
		return summary.all
			.filter(name => !name.startsWith('('))
			.map(name => ({
				name,
				isHead: name === summary.current,
				...tracking.get(name),
				worktreePath: worktreeOwners.get(name),
			}));
	}

	/** One entry per worktree `git worktree` knows about, including whichever one GGit itself is
	 * running against. Parses `--porcelain` rather than the human-readable default, e.g.:
	 *   worktree /home/user/code/app
	 *   HEAD 1a2b3c4d...
	 *   branch refs/heads/main
	 * (a blank line separates entries; a detached-HEAD worktree has no `branch` line at all). */
	async listWorktrees(): Promise<{ path: string; branch?: string; isCurrent: boolean }[]> {
		const out = await this.git.raw(['worktree', 'list', '--porcelain']);
		// git always reports the *real* (symlink-resolved) path here, e.g. macOS's /var -> /private/var
		// — comparing against repoRoot with plain path.resolve looked right in isolation but silently
		// never matched the current worktree on macOS, since repoRoot (from workspaceFolder.uri.fsPath)
		// keeps the /var form. Verified by actually running `git worktree list --porcelain` from a repo
		// under a tmp dir before trusting the plain-resolve comparison.
		const realRepoRoot = safeRealpath(this.repoRoot);
		const worktrees: { path: string; branch?: string; isCurrent: boolean }[] = [];
		let currentPath: string | undefined;
		let currentBranch: string | undefined;
		const flush = () => {
			if (currentPath) {
				worktrees.push({
					path: currentPath,
					branch: currentBranch,
					isCurrent: safeRealpath(currentPath) === realRepoRoot,
				});
			}
			currentPath = undefined;
			currentBranch = undefined;
		};
		for (const line of out.split('\n')) {
			if (!line.trim()) {
				flush();
				continue;
			}
			if (line.startsWith('worktree ')) {
				currentPath = line.slice('worktree '.length).trim();
			} else if (line.startsWith('branch ')) {
				currentBranch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
			}
		}
		flush();
		return worktrees;
	}

	/** Maps branch name -> the path of the *other* worktree it's checked out in. Excludes whichever
	 * worktree GGit is currently running against — that branch is already flagged via
	 * BranchInfo.isHead, not this. */
	private async getBranchWorktreeOwners(): Promise<Map<string, string>> {
		const worktrees = await this.listWorktrees();
		const owners = new Map<string, string>();
		for (const wt of worktrees) {
			if (wt.branch && !wt.isCurrent) {
				owners.set(wt.branch, wt.path);
			}
		}
		return owners;
	}

	async listRemoteBranches(remote: string): Promise<RemoteBranchInfo[]> {
		const out = await this.git.raw(['branch', '-r', '--format=%(refname:short)']);
		return out
			.split('\n')
			.map(line => line.trim())
			.filter(name => name.startsWith(`${remote}/`) && name !== `${remote}/HEAD`)
			.map(name => ({ name }));
	}

	/** Every remote configured for this repo (e.g. ["origin", "upstream"]) -- drives the Remotes view
	 * showing one top-level folder per remote instead of assuming "origin" is the only one. */
	async listRemotes(): Promise<string[]> {
		const remotes = await this.git.getRemotes();
		return remotes.map(r => r.name);
	}

	/** `git remote add` -- validated by git itself (a duplicate name, an obviously malformed URL,
	 * etc. all surface as a raw git error), same convention as createBranch/renameBranch above rather
	 * than this extension trying to re-implement git's own name/URL rules. */
	async addRemote(name: string, url: string): Promise<void> {
		await this.git.raw(['remote', 'add', name, url]);
	}

	/** Returns the current branch name, or undefined if HEAD is detached. */
	async getCurrentBranch(): Promise<string | undefined> {
		const name = (await this.git.raw(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
		return name === 'HEAD' ? undefined : name;
	}

	/** Checked live (not from a cached branch list) because the whole point is to catch another
	 * worktree grabbing this branch between the last refresh and this click — git itself would
	 * refuse the checkout either way, but with a much less friendly "already used by worktree at
	 * ..." error surfacing straight from the raw command. */
	async checkoutBranch(name: string): Promise<void> {
		const owners = await this.getBranchWorktreeOwners();
		const ownerPath = owners.get(name);
		if (ownerPath) {
			throw new Error(`"${name}" is already checked out in another worktree at ${ownerPath} — open that worktree instead.`);
		}
		await this.git.checkout(name);
	}

	/** Switches to the local branch tracking this remote branch, creating one (after fetching) if it
	 * doesn't exist yet. The remote to fetch from is read off `remoteBranchName` itself (its leading
	 * "remote/" segment) rather than assumed to be "origin" -- the Remotes view can show branches from
	 * any configured remote now, not just origin. */
	async checkoutRemoteBranch(remoteBranchName: string): Promise<void> {
		const { remote, branch: localName } = splitRemoteBranch(remoteBranchName);
		const locals = await this.listLocalBranches();
		if (locals.some(b => b.name === localName)) {
			await this.checkoutBranch(localName);
			return;
		}
		await this.fetch(remote);
		await this.git.checkout(['-b', localName, '--track', remoteBranchName]);
	}

	async deleteBranch(name: string, force = false): Promise<void> {
		await this.git.raw(['branch', force ? '-D' : '-d', name]);
	}

	async renameBranch(oldName: string, newName: string): Promise<void> {
		await this.git.raw(['branch', '-m', oldName, newName]);
	}

	/** The upstream remote branch a local branch tracks, e.g. "origin/main" — undefined if it isn't
	 * tracking one, or if it's tracking a remote branch that's since been deleted and pruned. Git keeps
	 * the upstream configured in that "gone" case (same state `git branch -vv` flags as "[gone]") —
	 * %(upstream:short) happily returns the name regardless of whether it still resolves to anything,
	 * so this explicitly verifies it before handing it back, which is what was missing here before:
	 * getLog (and the fetch/pull/push/sync pickers, all of which call this) would otherwise pass a
	 * nonexistent ref straight to git and blow up with "fatal: bad revision". */
	async getUpstreamBranch(branchName: string): Promise<string | undefined> {
		const out = (
			await this.git.raw(['for-each-ref', '--format=%(upstream:short)', `refs/heads/${branchName}`])
		).trim();
		if (!out) {
			this.logger?.(`getUpstreamBranch(${branchName}): no upstream configured`);
			return undefined;
		}
		try {
			await this.git.raw(['rev-parse', '--verify', '--quiet', `${out}^{commit}`]);
			this.logger?.(`getUpstreamBranch(${branchName}): upstream "${out}" verified OK`);
			return out;
		} catch (err) {
			this.logger?.(
				`getUpstreamBranch(${branchName}): upstream "${out}" does not resolve (${(err as Error).message.trim()}) — treating as no upstream`
			);
			return undefined;
		}
	}

	/** How many commits `branchName` has that its upstream doesn't -- 0 if it has no upstream or is
	 * already fully pushed. Drives the History panel's Push button turning green when there's
	 * something to push. Same cheap for-each-ref plumbing as listLocalBranches' ahead/behind, not a
	 * commit-walking call, so this doesn't reintroduce the unbounded-cost problem getLog just fixed. */
	async getAheadCount(branchName: string): Promise<number> {
		const out = (await this.git.raw(['for-each-ref', '--format=%(upstream:track)', `refs/heads/${branchName}`])).trim();
		return Number(out.match(/ahead (\d+)/)?.[1] ?? 0);
	}

	async fetchBranch(remoteBranchName: string): Promise<void> {
		const { remote, branch } = splitRemoteBranch(remoteBranchName);
		await this.git.fetch(remote, branch);
	}

	async pullBranch(remoteBranchName: string): Promise<void> {
		const { remote, branch } = splitRemoteBranch(remoteBranchName);
		await this.git.pull(remote, branch);
	}

	/** Pushes an already-tracked branch to its upstream. `--force-with-lease` (not a blunt `--force`)
	 * when forcing -- refuses if the remote ref moved since your last fetch of it, so this can't
	 * silently clobber a push someone else made in the meantime the way plain `--force` could. */
	async pushBranch(branchName: string, remote: string, options?: { force?: boolean }): Promise<void> {
		const args = ['push'];
		if (options?.force) {
			args.push('--force-with-lease');
		}
		args.push(remote, branchName);
		await this.git.raw(args);
	}

	/** Pushes a never-before-published local branch and sets it up to track the new remote branch. */
	async publishBranch(branchName: string, remoteBranchName: string, remote: string): Promise<void> {
		await this.git.raw(['push', '-u', remote, `${branchName}:${remoteBranchName}`]);
	}

	/** Creates a new local branch off `startPoint`. `track` sets it up to track `startPoint` for push/pull; `checkout` switches to it immediately. */
	async createBranch(name: string, startPoint: string, options: { track: boolean; checkout: boolean }): Promise<void> {
		const trackFlag = options.track ? '--track' : '--no-track';
		if (options.checkout) {
			await this.git.raw(['checkout', '-b', name, trackFlag, startPoint]);
		} else {
			await this.git.raw(['branch', trackFlag, name, startPoint]);
		}
	}

	/** Includes the branch's upstream too (if it has one) so commits it's behind on are still shown
	 * — just tagged `onBranch: false` so the caller can dim them — rather than silently left out. */
	/** One page of a branch's own commit history, newest first. Paginated via skip/limit rather than
	 * ever fetching the whole history at once -- on a large, long-lived repo that can mean tens of
	 * thousands of commits, and rendering that many rows in the History webview (not just the git call
	 * itself) is what was actually behind multi-second-to-minute loads and even laggy hover, confirmed
	 * against a real large monorepo both over SSH and running locally against the same repo (ruling out
	 * network latency as the cause). Fetches limit+1 to cheaply know whether there's a next page
	 * without a separate, equally expensive count query.
	 *
	 * This also drops the previous "combined branch+upstream log, dimming commits only reachable via
	 * upstream" behavior -- that required a second, fully unbounded `git rev-list branchName` call just
	 * to tag which commits belonged to the branch itself, which on a huge repo was its own multi-second
	 * cost on every single load. `onBranch` is now always true; a branch's ahead/behind *counts* are
	 * still shown elsewhere (Branches view) via a cheap for-each-ref call, just not interleaved,
	 * dimmed commits in this list. */
	async getLog(branchName: string, options: { skip: number; limit: number }): Promise<{ commits: CommitInfo[]; hasMore: boolean }> {
		const { skip, limit } = options;
		const out = await this.time(`getLog(${branchName}, skip=${skip}, limit=${limit}): git log`, () =>
			this.git.raw([
				'log',
				branchName,
				`--skip=${skip}`,
				`--max-count=${limit + 1}`,
				`--pretty=format:${LOG_FORMAT}`,
				'--decorate=short',
				'--',
			])
		);
		if (!out.trim()) {
			return { commits: [], hasMore: false };
		}
		const lines = out.split('\n');
		const hasMore = lines.length > limit;
		const pageLines = hasMore ? lines.slice(0, limit) : lines;
		const commits = pageLines.map(line => {
			const [hash, parents, authorName, authorEmail, date, message, refsField] = line.split(FIELD_SEP);
			return {
				hash,
				parentHashes: parents ? parents.split(' ').filter(Boolean) : [],
				authorName,
				authorEmail,
				date,
				message,
				refs: parseRefs(refsField ?? ''),
				onBranch: true,
			};
		});
		this.logger?.(`getLog(${branchName}, skip=${skip}, limit=${limit}): ${commits.length} commit(s), hasMore=${hasMore}`);
		return { commits, hasMore };
	}

	/** The commit's first parent, or git's well-known empty-tree SHA for a root commit. */
	async getDiffBase(sha: string): Promise<string> {
		const revList = (await this.git.raw(['rev-list', '--parents', '-n', '1', sha])).trim().split(' ');
		return revList.length > 1 ? revList[1] : EMPTY_TREE_SHA;
	}

	/** Moves the current branch's HEAD to `sha`. "mixed" (git's default) unstages everything but
	 * leaves the working tree files alone; "hard" also overwrites the working tree, discarding
	 * uncommitted changes. Either way, commits after `sha` stop being part of this branch (though
	 * they remain recoverable via the reflog for a while). */
	async resetHead(sha: string, mode: 'mixed' | 'hard'): Promise<void> {
		await this.git.raw(['reset', `--${mode}`, sha]);
	}

	/** Replays `sha`'s changes as a new commit on top of the current branch. Throws (with git's own
	 * conflict message) if it can't apply cleanly — there's no in-extension conflict resolution, so
	 * that has to be sorted out in the terminal. */
	async cherryPick(sha: string): Promise<void> {
		await this.git.raw(['cherry-pick', sha]);
	}

	/** A single-commit patch in the standard git-am-able format (commit message, author, date included). */
	async getPatch(sha: string): Promise<string> {
		return this.git.raw(['format-patch', '-1', sha, '--stdout']);
	}

	async getCommitFiles(sha: string): Promise<ChangedFile[]> {
		const base = await this.time(`getCommitFiles(${sha}): getDiffBase`, () => this.getDiffBase(sha));
		const [nameStatusOut, numstatOut] = await this.time(`getCommitFiles(${sha}): diff name-status + numstat`, () =>
			Promise.all([
				this.git.raw(['diff', '--name-status', '-M', base, sha]),
				this.git.raw(['diff', '--numstat', '-M', base, sha]),
			])
		);
		if (!nameStatusOut.trim()) {
			return [];
		}
		const stats = parseNumstat(numstatOut);
		return nameStatusOut
			.split('\n')
			.filter(Boolean)
			.map((line, i) => {
				const parts = line.split('\t');
				const status = parts[0][0] as FileStatus;
				const stat = stats[i];
				if (status === 'R' || status === 'C') {
					return { status, oldPath: parts[1], path: parts[2], ...stat };
				}
				return { status, path: parts[1], ...stat };
			});
	}

	/** Throws if `relPath` did not exist at `sha` — used by the diff provider to detect add/delete. */
	async getFileContentAtRevision(sha: string, relPath: string): Promise<string> {
		return this.git.show([`${sha}:${relPath}`]);
	}

	/** A stash entry is itself a regular commit, so getCommitFiles/getFileContentAtRevision/
	 * openDiffForFile all already work against `stash.hash` unchanged — nothing stash-specific
	 * needed there. */
	async listStashes(): Promise<StashInfo[]> {
		const out = await this.git.raw(['stash', 'list', `--pretty=format:${STASH_FORMAT}`]);
		if (!out.trim()) {
			return [];
		}
		return out.split('\n').map(line => {
			const [ref, hash, message, date] = line.split(FIELD_SEP);
			return { ref, hash, message, date };
		});
	}

	async applyStash(ref: string): Promise<void> {
		await this.git.raw(['stash', 'apply', ref]);
	}

	async dropStash(ref: string): Promise<void> {
		await this.git.raw(['stash', 'drop', ref]);
	}

	/** getCommitFiles(stash.hash) alone only covers a stash's tracked-changes diff (its first
	 * parent) — a stash created with --include-untracked stores those files in a separate,
	 * parentless 3rd-parent commit that a normal base..stash diff never looks at. This merges both
	 * in, tagging the untracked-side entries with sourceRef so openDiffForFile knows to diff them
	 * against that commit instead of the stash's own hash. Verified against real git behavior:
	 * `git status` comes back clean after stashing an untracked file, and `stash apply` restores it
	 * correctly — the file was never actually missing from the stash, only from this file list. */
	async getStashFiles(stashHash: string): Promise<ChangedFile[]> {
		const trackedFiles = await this.getCommitFiles(stashHash);
		let untrackedRef: string;
		try {
			untrackedRef = (await this.git.raw(['rev-parse', `${stashHash}^3`])).trim();
		} catch {
			return trackedFiles;
		}
		const untrackedFiles = await this.getCommitFiles(untrackedRef);
		return [...trackedFiles, ...untrackedFiles.map(f => ({ ...f, sourceRef: untrackedRef }))];
	}

	async stageFile(relPath: string): Promise<void> {
		await this.git.raw(['add', '--', relPath]);
	}

	async unstageFile(relPath: string): Promise<void> {
		await this.git.raw(['reset', '--', relPath]);
	}

	/** Reverts a file to its last-committed (HEAD) state, in both the index and the working tree —
	 * this is what "discard local changes" means for a file that exists at HEAD. For a deleted file
	 * this recreates it (a "restore"); for a modified one it throws away the edits. Not valid for a
	 * new/untracked file — use discardNewFile for that. */
	async discardChanges(relPath: string): Promise<void> {
		await this.git.raw(['checkout', 'HEAD', '--', relPath]);
	}

	/** A new/untracked file has no committed state to revert to, so "discarding" it means deleting it
	 * outright. Unstages first (harmless no-op if it wasn't staged) since `git clean` only touches
	 * untracked paths, not ones still sitting in the index. */
	async discardNewFile(relPath: string): Promise<void> {
		await this.git.raw(['reset', '--', relPath]);
		await this.git.raw(['clean', '-f', '--', relPath]);
	}

	/** Commits whatever's currently staged. Git itself rejects this with "nothing added to commit" if
	 * the index is empty and `amend` isn't set — no smart-commit fallback to staging everything,
	 * matching the rest of GGit's explicit stage/unstage model rather than the built-in Git extension's
	 * implicit "commit all". */
	async commit(message: string, options: { amend?: boolean } = {}): Promise<void> {
		const args = ['commit', '-m', message];
		if (options.amend) {
			args.push('--amend');
		}
		await this.git.raw(args);
	}

	/** Aggregate +/- across everything currently staged — used for the Commit panel's summary line. */
	async getStagedStats(): Promise<{ insertions: number; deletions: number }> {
		const out = await this.git.raw(['diff', '--cached', '--numstat']);
		let insertions = 0;
		let deletions = 0;
		for (const line of out.split('\n')) {
			if (!line) {
				continue;
			}
			const [added, deleted] = line.split('\t');
			if (added === '-' || deleted === '-') {
				continue;
			}
			insertions += Number(added) || 0;
			deletions += Number(deleted) || 0;
		}
		return { insertions, deletions };
	}

	/** The current HEAD commit's message, split into subject/body — what the Commit panel's Amend
	 * checkbox pre-fills the form with. Undefined for a brand-new repo with no commits yet. */
	async getHeadCommitMessage(): Promise<{ subject: string; body: string } | undefined> {
		try {
			const out = await this.git.raw(['log', '-1', `--pretty=format:%s${FIELD_SEP}%b`]);
			const [subject, body] = out.split(FIELD_SEP);
			return { subject: subject ?? '', body: (body ?? '').trim() };
		} catch {
			return undefined;
		}
	}

	async stageAll(): Promise<void> {
		await this.git.raw(['add', '-A']);
	}

	async unstageAll(): Promise<void> {
		await this.git.raw(['reset']);
	}

	/** Stashes every working-tree change, tracked or not. */
	async stashAll(message?: string): Promise<void> {
		const args = ['stash', 'push', '--include-untracked'];
		if (message) {
			args.push('-m', message);
		}
		await this.git.raw(args);
	}

	/** Stashes only the given paths, leaving the rest of the working tree untouched. */
	async stashPaths(relPaths: string[], message?: string): Promise<void> {
		const args = ['stash', 'push', '--include-untracked'];
		if (message) {
			args.push('-m', message);
		}
		args.push('--', ...relPaths);
		await this.git.raw(args);
	}

	/** Combined staged + unstaged working-tree changes. Usually one entry per file, but a file with
	 * changes on *both* sides at once (git's status reports this as e.g. "MM" — some hunks staged,
	 * the rest still not) becomes two entries sharing the same path, one per state, rather than
	 * picking one side and silently hiding the other — there's no single FileStatus that could
	 * represent both. Verified against real `git status` output for a partially-staged file before
	 * relying on this: index and working_dir really do come back as two independent, simultaneously
	 * non-blank codes in that case. Excludes anything with an unresolved merge conflict — those get
	 * their own section via getConflictedFiles instead of showing up as an ordinary change. */
	async getWorkingChanges(): Promise<WorkingChangeFile[]> {
		const status = await this.git.status();
		const conflicted = new Set(status.conflicted);
		const changes: WorkingChangeFile[] = [];
		for (const f of status.files) {
			if (conflicted.has(f.path)) {
				continue;
			}
			if (f.index === '?') {
				// Untracked -- git reports both columns as '?'; nothing about it can be "staged" yet.
				changes.push({ path: f.path, status: '?', state: 'unstaged' });
				continue;
			}
			if (f.index !== ' ') {
				changes.push({ path: f.path, status: mapStatusCode(f.index), state: 'staged' });
			}
			if (f.working_dir !== ' ') {
				changes.push({ path: f.path, status: mapStatusCode(f.working_dir), state: 'unstaged' });
			}
			if (f.index !== ' ' && f.index !== '?' && f.working_dir !== ' ') {
				this.logger?.(
					`getWorkingChanges: "${f.path}" is split -- index="${f.index}" working_dir="${f.working_dir}"`
				);
			}
		}
		this.logger?.(
			`getWorkingChanges: ${status.files.length} raw entr${status.files.length === 1 ? 'y' : 'ies'} -> ${changes.length} row(s): ` +
				JSON.stringify(changes)
		);
		return changes;
	}

	/** Stages exactly one hunk of a file's currently-unstaged changes -- the hunk whose line range in
	 * the new (working-tree) file contains `line` (1-indexed). This is GGit's own replacement for the
	 * built-in Git extension's "Stage Selected Ranges": that command silently no-ops against GGit's
	 * diffs (verified -- it depends on the built-in extension's own document/URI model to know what to
	 * stage, which GGit's diff content providers don't match), so hunk staging needs its own real
	 * implementation rather than relying on a menu item that happens to render. */
	async stageHunkAtLine(relPath: string, startLine: number, endLine: number): Promise<void> {
		const diffText = await this.git.raw(['diff', '--', relPath]);
		const patch = extractHunkPatch(diffText, startLine, endLine);
		if (!patch) {
			throw new Error(`No unstaged change found at line ${startLine} in "${relPath}".`);
		}
		this.logger?.(`stageHunkAtLine(${relPath}, ${startLine}-${endLine}): applying:\n${patch}`);
		await this.applyPatchToIndex(patch);
	}

	/** The reverse of stageHunkAtLine -- un-stages exactly one hunk of a file's currently staged
	 * changes, found the same way but against the HEAD-vs-index diff instead. */
	async unstageHunkAtLine(relPath: string, startLine: number, endLine: number): Promise<void> {
		const diffText = await this.git.raw(['diff', '--cached', '--', relPath]);
		const patch = extractHunkPatch(diffText, startLine, endLine);
		if (!patch) {
			throw new Error(`No staged change found at line ${startLine} in "${relPath}".`);
		}
		this.logger?.(`unstageHunkAtLine(${relPath}, ${startLine}-${endLine}): reverse-applying:\n${patch}`);
		await this.applyPatchToIndex(patch, { reverse: true });
	}

	/** `git apply` only reads patches from a file, not stdin via simple-git's API -- writes the patch
	 * to a scratch file under the OS temp dir and cleans it up immediately after, success or failure. */
	private async applyPatchToIndex(patch: string, options: { reverse?: boolean } = {}): Promise<void> {
		const tmpFile = path.join(os.tmpdir(), `ggit-hunk-${Date.now()}-${Math.random().toString(36).slice(2)}.patch`);
		await fs.promises.writeFile(tmpFile, patch, 'utf8');
		try {
			const args = ['apply', '--cached'];
			if (options.reverse) {
				args.push('--reverse');
			}
			args.push(tmpFile);
			await this.git.raw(args);
		} finally {
			await fs.promises.unlink(tmpFile).catch(() => {});
		}
	}

	/** Paths git has flagged as having an unresolved merge conflict (mid-rebase, mid-merge, ...). */
	async getConflictedFiles(): Promise<ConflictedFile[]> {
		const status = await this.git.status();
		return status.conflicted.map(p => ({ path: p }));
	}

	/** Whichever branch is currently checked out gets rebased onto `branchName`. `--autostash` means a
	 * dirty working tree never blocks starting a rebase — it's stashed automatically beforehand and
	 * restored after, so there's no "you have local changes" failure mode to expose a checkbox for.
	 * `-c core.editor=true` no-ops any editor git would otherwise try to open (there's no TTY here for
	 * one to be usable anyway, so letting it try would just hang forever). */
	async rebaseOnto(branchName: string): Promise<void> {
		await this.git.raw(['-c', 'core.editor=true', 'rebase', branchName, '--autostash']);
	}

	/** Resumes a paused rebase — call this once every conflicted file has been resolved and staged. */
	async rebaseContinue(): Promise<void> {
		await this.git.raw(['-c', 'core.editor=true', 'rebase', '--continue']);
	}

	/** Drops the current commit being replayed entirely, instead of resolving its conflict. */
	async rebaseSkip(): Promise<void> {
		await this.git.raw(['-c', 'core.editor=true', 'rebase', '--skip']);
	}

	/** Restores the branch to exactly where it was before the rebase started. */
	async rebaseAbort(): Promise<void> {
		await this.git.raw(['rebase', '--abort']);
	}

	async fetch(remote: string): Promise<void> {
		await this.git.fetch(remote);
	}

	async pull(remote: string): Promise<void> {
		const current = await this.getCurrentBranch();
		if (!current) {
			throw new Error('Cannot pull: HEAD is detached (no current branch).');
		}
		await this.git.pull(remote, current);
	}
}

/** Resolves symlinks before comparing worktree paths — git itself always reports fully-resolved
 * paths from `worktree list`, so comparing against an unresolved path (e.g. one under macOS's
 * /var, which is a symlink to /private/var) would otherwise never match. Falls back to a plain
 * resolve if the path doesn't exist (e.g. a worktree directory deleted by hand, outside git). */
function safeRealpath(p: string): string {
	try {
		return fs.realpathSync(p);
	} catch {
		return path.resolve(p);
	}
}

/** Slices one hunk out of a single-file unified diff, keyed by which hunk's *new-file* line range
 * overlaps [startLine, endLine] (1-indexed, inclusive) -- the working-tree side for a plain
 * `git diff`, or the index side for `git diff --cached`. Returns the file header (the
 * `diff --git`/`index`/`---`/`+++` lines) plus just that one hunk's block, which `git apply` accepts
 * as a complete, self-contained patch on its own -- verified against a real multi-hunk file before
 * relying on this, since each hunk in unified-diff format carries its own absolute line numbers
 * rather than being cumulative with the others.
 *
 * A selection that overlaps a hunk's declared range is preferred, but a selection dragged a little
 * past a hunk's trailing context (VS Code's diff editor doesn't visually mark exactly where a hunk's
 * boundary is) falls back to the nearest hunk instead of failing outright -- verified against a real
 * repro: selecting from inside a change down into unrelated unchanged lines below it used to report
 * "no diff here" even though the selection clearly included a real change. Only returns undefined if
 * there's no diff for this file at all. */
function extractHunkPatch(diffText: string, startLine: number, endLine: number): string | undefined {
	const lines = diffText.split(/(?<=\n)/);
	const hunkStarts: number[] = [];
	lines.forEach((l, i) => {
		if (l.startsWith('@@')) {
			hunkStarts.push(i);
		}
	});
	if (hunkStarts.length === 0) {
		return undefined;
	}
	const header = lines.slice(0, hunkStarts[0]).join('');

	const hunks: { newStart: number; rangeEnd: number; block: string }[] = [];
	for (let i = 0; i < hunkStarts.length; i++) {
		const start = hunkStarts[i];
		const end = i + 1 < hunkStarts.length ? hunkStarts[i + 1] : lines.length;
		const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(lines[start]);
		if (!match) {
			continue;
		}
		const newStart = Number(match[1]);
		const newCount = match[2] !== undefined ? Number(match[2]) : 1;
		hunks.push({ newStart, rangeEnd: newStart + Math.max(newCount, 1) - 1, block: lines.slice(start, end).join('') });
	}
	if (hunks.length === 0) {
		return undefined;
	}

	const overlapping = hunks.find(h => h.newStart <= endLine && h.rangeEnd >= startLine);
	if (overlapping) {
		return header + overlapping.block;
	}

	const distance = (h: { newStart: number; rangeEnd: number }) =>
		h.rangeEnd < startLine ? startLine - h.rangeEnd : h.newStart - endLine;
	const nearest = hunks.reduce((best, h) => (distance(h) < distance(best) ? h : best));
	return header + nearest.block;
}

/** Maps a `git status --porcelain` code (index or working_dir column) to our FileStatus union. */
function mapStatusCode(code: string): FileStatus {
	switch (code) {
		case 'A':
		case 'M':
		case 'D':
		case 'R':
		case 'C':
		case 'T':
		case '?':
			return code;
		default:
			return 'M';
	}
}

/** Remote branch names always start with their own remote's name (e.g. "origin/main",
 * "upstream/alice/feature-x") -- splits off that leading segment. No "which remote" parameter
 * needed (and none should be assumed): with more than one remote configured, a caller hardcoding
 * "origin" as a default would silently mis-parse anything from another remote. */
export function splitRemoteBranch(remoteBranchName: string): { remote: string; branch: string } {
	const slashIndex = remoteBranchName.indexOf('/');
	if (slashIndex === -1) {
		return { remote: '', branch: remoteBranchName };
	}
	return { remote: remoteBranchName.slice(0, slashIndex), branch: remoteBranchName.slice(slashIndex + 1) };
}

export function stripRemotePrefix(remoteBranchName: string): string {
	return splitRemoteBranch(remoteBranchName).branch;
}

/** Parses `%D` ref-decoration output, e.g. "HEAD -> main, origin/main, origin/HEAD, tag: v1.0". */
function parseRefs(raw: string): RefBadge[] {
	if (!raw) {
		return [];
	}
	return raw
		.split(', ')
		.flatMap(part => part.split(' -> '))
		.map(name => name.trim())
		.filter(Boolean)
		.map(name => {
			if (name.startsWith('tag: ')) {
				return { name: name.slice('tag: '.length), kind: 'tag' as const };
			}
			return { name, kind: name.includes('/') ? ('remote' as const) : ('local' as const) };
		});
}

type NumstatEntry = Pick<ChangedFile, 'insertions' | 'deletions' | 'binary'>;

/** Parses `git diff --numstat` output. Relies on line order matching a `--name-status` diff run with identical arguments. */
function parseNumstat(out: string): NumstatEntry[] {
	return out
		.split('\n')
		.filter(Boolean)
		.map(line => {
			const [added, deleted] = line.split('\t');
			if (added === '-' || deleted === '-') {
				return { binary: true };
			}
			return { insertions: Number(added), deletions: Number(deleted) };
		});
}
