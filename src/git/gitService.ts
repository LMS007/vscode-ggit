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
	MergeAnalysis,
	MergeOptions,
	MergeProgress,
	RebaseProgress,
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
		// --no-optional-locks stops `git status` from opportunistically taking .git/index.lock to write
		// back its refreshed stat cache -- which it holds for the *whole* status run, untracked scan
		// included. On a big repo under load that's tens of seconds, and an extension host killed in
		// that window (e.g. a Remote-SSH laptop sleeping) leaves an orphaned 0-byte index.lock that
		// blocks every later commit/checkout until it's deleted by hand. Only *optional* locks are
		// skipped, so writes (add, commit, checkout, ...) still lock exactly as before. It goes in as a
		// binary prefix (spawning `git --no-optional-locks <args>`) rather than GIT_OPTIONAL_LOCKS=0 via
		// .env(), because a custom env must then carry all of process.env, and simple-git refuses to
		// run anything at all when that includes EDITOR/PAGER/GIT_ASKPASS -- which most login shells set.
		this.git = simpleGit({
			baseDir: repoRoot,
			binary: ['git', '--no-optional-locks'],
			unsafe: { allowUnsafeEditor: true },
		});
	}

	/** Lets other classes holding a GitService reference (tree providers, panels) write to the same
	 * "GGit" output channel this is constructed with, without each one needing its own wiring. */
	log(message: string): void {
		this.logger?.(message);
	}

	/** Absolute path for a repo-relative one, refusing anything that would land outside repoRoot. Paths
	 * git itself reports are always root-relative with no "..", so this only ever matters for a path
	 * that arrived from somewhere less trustworthy (a webview message, another extension's command
	 * call) -- those must never turn into an open/reveal/save of an arbitrary file on disk. */
	resolveRepoPath(relPath: string): string {
		const absolute = path.resolve(this.repoRoot, relPath);
		const relative = path.relative(this.repoRoot, absolute);
		if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
			throw new Error(`"${relPath}" is outside the repository.`);
		}
		return absolute;
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
		assertNotOptionLike(name, 'remote name');
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
		assertNotOptionLike(newName, 'branch name');
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

	/** This branch's GitHub "tree" URL, e.g. https://github.com/owner/repo/tree/branch-name --
	 * undefined if it has no upstream, that upstream's remote can't be resolved to a URL, or the URL
	 * isn't a github.com remote (GitHub Enterprise, GitLab, a local path, ...). Drives the History
	 * panel's "View on GitHub" button, which only makes sense once a branch is actually published
	 * somewhere GitHub can render this URL. */
	async getGitHubBranchUrl(branchName: string): Promise<string | undefined> {
		const upstream = await this.getUpstreamBranch(branchName);
		if (!upstream) {
			return undefined;
		}
		const { remote } = splitRemoteBranch(upstream);
		const remotes = await this.git.getRemotes(true);
		const url = remotes.find(r => r.name === remote)?.refs.fetch;
		if (!url) {
			return undefined;
		}
		const ownerRepo = parseGitHubOwnerRepo(url);
		if (!ownerRepo) {
			return undefined;
		}
		// Branch names commonly carry their own "/"-separated segments (e.g.
		// "alice/feature-1234-...") -- GitHub's /tree/ URLs expect those literally, not
		// %2F-encoded, so only each segment's own content gets escaped.
		const branchPath = branchName.split('/').map(encodeURIComponent).join('/');
		return `https://github.com/${ownerRepo.owner}/${ownerRepo.repo}/tree/${branchPath}`;
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
		assertNotOptionLike(name, 'branch name');
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
		assertObjectId(sha);
		const revList = (await this.git.raw(['rev-list', '--parents', '-n', '1', sha])).trim().split(' ');
		return revList.length > 1 ? revList[1] : EMPTY_TREE_SHA;
	}

	/** Moves the current branch's HEAD to `sha`. "mixed" (git's default) unstages everything but
	 * leaves the working tree files alone; "hard" also overwrites the working tree, discarding
	 * uncommitted changes. Either way, commits after `sha` stop being part of this branch (though
	 * they remain recoverable via the reflog for a while). */
	async resetHead(sha: string, mode: 'mixed' | 'hard'): Promise<void> {
		assertObjectId(sha);
		if (mode !== 'mixed' && mode !== 'hard') {
			throw new Error(`Unsupported reset mode: "${mode}"`);
		}
		await this.git.raw(['reset', `--${mode}`, sha]);
	}

	/** Replays `sha`'s changes as a new commit on top of the current branch. Throws (with git's own
	 * conflict message) if it can't apply cleanly — there's no in-extension conflict resolution, so
	 * that has to be sorted out in the terminal. */
	async cherryPick(sha: string): Promise<void> {
		assertObjectId(sha);
		await this.git.raw(['cherry-pick', sha]);
	}

	/** A single-commit patch in the standard git-am-able format (commit message, author, date included). */
	async getPatch(sha: string): Promise<string> {
		assertObjectId(sha);
		return this.git.raw(['format-patch', '-1', sha, '--stdout']);
	}

	async getCommitFiles(sha: string): Promise<ChangedFile[]> {
		assertObjectId(sha);
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
		assertObjectId(stashHash);
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

	/** Whether every one of these absolute paths is gitignored (and untracked) -- i.e. a change to
	 * them can't possibly show up in `git status`. VS Code's file watchers honor files.watcherExclude
	 * but not .gitignore, so a build or test run streaming into an ignored logs/ or out/ dir inside the
	 * worktree otherwise looks exactly like real edits. Fails open (false) on anything unexpected --
	 * a path outside the repo, git erroring -- since a needless refresh beats a stale Working Copy. */
	async allIgnored(absPaths: string[]): Promise<boolean> {
		const relPaths: string[] = [];
		for (const absPath of absPaths) {
			const rel = path.relative(this.repoRoot, absPath);
			if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
				return false;
			}
			relPaths.push(rel);
		}
		try {
			// Chunked only to stay well under the OS argv limit when a build touches thousands of files.
			// git prints one line per ignored path (quoting any with odd characters, newlines included),
			// and exits 1 with no output when none are -- which simple-git treats as success.
			for (let i = 0; i < relPaths.length; i += 500) {
				const chunk = relPaths.slice(i, i + 500);
				const out = await this.git.raw(['check-ignore', '--', ...chunk]);
				if (out.split('\n').filter(Boolean).length < chunk.length) {
					return false;
				}
			}
			return true;
		} catch (err) {
			this.logger?.(`allIgnored: check-ignore failed, treating as not ignored: ${err}`);
			return false;
		}
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
	 * to a scratch file under the OS temp dir and cleans it up immediately after, success or failure.
	 * Created exclusively (`wx`) and owner-only (0600) so a pre-existing file or symlink at that name
	 * is refused rather than followed, and other local users can't read the staged source. */
	private async applyPatchToIndex(patch: string, options: { reverse?: boolean } = {}): Promise<void> {
		const tmpFile = path.join(os.tmpdir(), `ggit-hunk-${Date.now()}-${Math.random().toString(36).slice(2)}.patch`);
		await fs.promises.writeFile(tmpFile, patch, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
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

	/** git's progress through the current rebase -- which commit is being applied (1-based) out of
	 * how many, plus (merge backend only) its subject and the branch being rebased. Undefined if no
	 * rebase is in progress. Drives the Rebase tab's header and its Continue-vs-Finish button choice.
	 * git tracks this in plain files under .git/rebase-merge (the modern default backend) or
	 * .git/rebase-apply (the older apply-based one) -- the same files a shell prompt reads to show
	 * "REBASE 2/5". */
	async getRebaseProgress(): Promise<RebaseProgress | undefined> {
		const gitDir = await this.getGitDir();
		const mergeDir = path.join(gitDir, 'rebase-merge');
		if (fs.existsSync(mergeDir)) {
			const current = Number(readFileIfExists(path.join(mergeDir, 'msgnum')) ?? 0);
			const total = Number(readFileIfExists(path.join(mergeDir, 'end')) ?? 0);
			const branchName = parseHeadName(readFileIfExists(path.join(mergeDir, 'head-name')));
			// The last line of `done` is the todo-list entry currently being applied -- git appends it
			// the moment it starts processing a step, before that step can fail/conflict, so it's still
			// there (as the final line) throughout the pause.
			const doneLines = (readFileIfExists(path.join(mergeDir, 'done')) ?? '')
				.trim()
				.split('\n')
				.filter(Boolean);
			return { current, total, subject: parseTodoSubject(doneLines.at(-1)), branchName };
		}
		const applyDir = path.join(gitDir, 'rebase-apply');
		if (fs.existsSync(applyDir)) {
			// The older backend doesn't keep a `done`/todo-list equivalent this cheap to read, so the
			// current commit's subject just isn't available here -- only the branch and progress count.
			const current = Number(readFileIfExists(path.join(applyDir, 'next')) ?? 0);
			const total = Number(readFileIfExists(path.join(applyDir, 'last')) ?? 0);
			const branchName = parseHeadName(readFileIfExists(path.join(applyDir, 'head-name')));
			return { current, total, subject: undefined, branchName };
		}
		return undefined;
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

	/** git writes MERGE_HEAD the moment a merge stops short of committing -- on conflicts, or because
	 * --no-commit asked it to -- and removes it once that merge is committed or aborted. It's what
	 * `git status` checks to print "You have unmerged paths" / "All conflicts fixed but you are still
	 * merging". A --squash merge never writes one (see mergeBranch). */
	async isMergeInProgress(): Promise<boolean> {
		const gitDir = await this.getGitDir();
		return fs.existsSync(path.join(gitDir, 'MERGE_HEAD'));
	}

	/** Which branch the stopped merge is bringing in, and into what. Undefined if no merge is in
	 * progress. Drives the Conflicts tab's header, the same way getRebaseProgress does for a rebase. */
	async getMergeProgress(): Promise<MergeProgress | undefined> {
		const gitDir = await this.getGitDir();
		const mergeHead = readFileIfExists(path.join(gitDir, 'MERGE_HEAD'));
		if (!mergeHead) {
			return undefined;
		}
		const subject = readFileIfExists(path.join(gitDir, 'MERGE_MSG'))?.split('\n')[0];
		return {
			branchName: parseMergedBranchName(subject) ?? mergeHead.slice(0, 7),
			intoBranch: await this.getCurrentBranch(),
		};
	}

	/** Works out what merging `branchName` into HEAD would do without touching the working tree or
	 * index: how many commits each side has that the other doesn't (`rev-list --left-right --count`
	 * prints "<HEAD-only> <branch-only>"), and -- only when a real merge is needed -- which files it
	 * would conflict on. `git merge-tree --write-tree` (git 2.38+) runs the same merge machinery as
	 * `git merge` but entirely in the object store, and with --name-only lists each conflicted path
	 * after the result tree's id on its first line. Its exit status can't be used for this -- simple-git
	 * only rejects when git also writes to stderr, and merge-tree doesn't, conflicts or not -- so the
	 * listing itself is what gets read. */
	async analyzeMerge(branchName: string): Promise<MergeAnalysis> {
		assertNotOptionLike(branchName, 'branch name');
		const counts = (await this.git.raw(['rev-list', '--left-right', '--count', `HEAD...${branchName}`])).trim();
		const [outgoing, incoming] = counts.split(/\s+/).map(Number);
		if (incoming === 0 || outgoing === 0) {
			// Nothing to merge, or a fast-forward -- neither can conflict.
			return { incoming, outgoing, conflicts: [] };
		}
		try {
			const out = await this.git.raw(['merge-tree', '--write-tree', '--name-only', '--no-messages', 'HEAD', branchName]);
			const conflicts = [...new Set(out.split('\n').slice(1).filter(Boolean))];
			return { incoming, outgoing, conflicts };
		} catch (err) {
			// Only a prediction -- the merge itself still stops on any real conflict and hands off to the
			// Conflicts tab either way, so failing here (e.g. a git too old for --write-tree) just means
			// the dialog can't warn about them up front.
			this.logger?.(`analyzeMerge(${branchName}): merge-tree failed, skipping conflict prediction: ${err}`);
			return { incoming, outgoing, conflicts: [] };
		}
	}

	/** Merges `branchName` into the current branch. A merge that stops on conflicts does NOT throw:
	 * git reports those on stdout alone, and simple-git only rejects when stderr has output too
	 * (verified: a conflicted `git merge` resolves normally here) -- callers check isMergeInProgress
	 * afterward instead, which is what hands off to the Conflicts tab. Real failures (an unknown
	 * branch, local changes git won't merge over, ...) do go to stderr, and throw as usual.
	 *
	 * `--autostash` works as it does for rebaseOnto: uncommitted changes are stashed first, held
	 * (as MERGE_AUTOSTASH) through any conflict pause, and restored once the merge is committed or
	 * aborted. --squash deliberately goes without it -- a squash never writes MERGE_HEAD, so if it
	 * stopped on a conflict there'd be no merge to abort and the stash would stay parked out of sight
	 * until some later commit happened to release it. Plain git already refuses to squash over local
	 * changes that would collide, and leaves any others unstaged and out of the squash commit. */
	async mergeBranch(branchName: string, options: MergeOptions): Promise<void> {
		assertNotOptionLike(branchName, 'branch name');
		if (options.squash) {
			await this.git.raw(['merge', '--squash', branchName]);
			if (!options.commit) {
				return;
			}
			const conflicted = await this.getConflictedFiles();
			if (conflicted.length > 0) {
				throw new Error(
					`The squash stopped on conflicts in ${conflicted.map(f => f.path).join(', ')}. Resolve and stage them, then commit to finish.`
				);
			}
			// core.editor=true (see rebaseOnto) accepts git's own squash message -- the squashed
			// commits' log -- as-is.
			await this.git.raw(['-c', 'core.editor=true', 'commit']);
			return;
		}
		const args = ['merge', '--autostash'];
		// A --no-commit merge that fast-forwards has nothing left to "not commit" -- git would just move
		// the branch -- so leaving the commit for later implies a real merge commit, too.
		if (options.noFastForward || !options.commit) {
			args.push('--no-ff');
		}
		args.push(options.commit ? '--no-edit' : '--no-commit', branchName);
		await this.git.raw(args);
	}

	/** Moves the current branch up to `branchName` only if that's a pure fast-forward -- `--ff-only`
	 * makes git refuse rather than quietly create a merge commit, in case the branches diverged since
	 * the confirmation that promised a fast-forward was shown. */
	async fastForwardTo(branchName: string): Promise<void> {
		assertNotOptionLike(branchName, 'branch name');
		await this.git.raw(['merge', '--ff-only', '--autostash', branchName]);
	}

	/** Concludes a stopped merge with git's own message ("Merge branch '...'"). core.editor=true (see
	 * rebaseOnto) rather than --no-edit: after a conflict git appends "# Conflicts:" lines to that
	 * message, and only an editor pass strips comment lines -- verified that --no-edit commits them
	 * verbatim. Also what restores a MERGE_AUTOSTASH stashed by mergeBranch. */
	async mergeCommit(): Promise<void> {
		await this.git.raw(['-c', 'core.editor=true', 'commit']);
	}

	/** Restores the branch (and any autostashed local changes) to exactly where it was before the merge. */
	async mergeAbort(): Promise<void> {
		await this.git.raw(['merge', '--abort']);
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

/** Every commit/stash hash handed to this service is a full or abbreviated hex object id -- never a
 * symbolic ref, and never anything git could read as an option. Revision arguments sit in positional
 * slots that a `--` can't protect (`rev-list -n 1 --output=x` is parsed as an option regardless of
 * what precedes it, and git opens that file before failing), so the shape is checked up front rather
 * than trusting whoever sent it -- e.g. a History webview message -- to have passed a real hash. */
function assertObjectId(sha: string): void {
	if (!/^[0-9a-f]{4,64}$/.test(sha)) {
		throw new Error(`Not a valid commit hash: "${sha}"`);
	}
}

/** Rejects a user-typed name that git's option parser would read as a flag instead of a name --
 * verified that `git branch --no-track -D <startPoint>` (the result of naming a branch "-D") deletes
 * startPoint outright, so this can't be left to git's own name validation, which runs too late. */
function assertNotOptionLike(name: string, what: string): void {
	if (name.startsWith('-')) {
		throw new Error(`Invalid ${what} "${name}": it can't start with "-".`);
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

/** Parses a git remote URL into { owner, repo } only when it points at github.com -- handles both
 * the SSH form (git@github.com:owner/repo.git) and HTTPS form (https://github.com/owner/repo.git),
 * with or without the trailing .git. Anything else (GitHub Enterprise, GitLab, a local path, ...)
 * returns undefined rather than guessing. */
function parseGitHubOwnerRepo(url: string): { owner: string; repo: string } | undefined {
	const match =
		url.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/) ?? url.match(/^https?:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/);
	return match ? { owner: match[1], repo: match[2] } : undefined;
}

function readFileIfExists(filePath: string): string | undefined {
	try {
		return fs.readFileSync(filePath, 'utf8').trim();
	} catch {
		return undefined;
	}
}

/** `head-name` holds the full ref being rebased, e.g. "refs/heads/branch-b" (or, for a detached-HEAD
 * rebase, the literal string "detached"). */
function parseHeadName(headName: string | undefined): string | undefined {
	if (!headName || headName === 'detached') {
		return undefined;
	}
	return headName.startsWith('refs/heads/') ? headName.slice('refs/heads/'.length) : headName;
}

/** The first line of MERGE_MSG, e.g. "Merge branch 'alice/feature-x'" or "Merge branch 'b' into c" ->
 * the branch being merged in. Undefined for anything else git might have written there (e.g. "Merge
 * commit '1a2b3c4'" when merging a bare hash). */
function parseMergedBranchName(subject: string | undefined): string | undefined {
	return subject?.match(/^Merge (?:remote-tracking )?branch '([^']+)'/)?.[1];
}

/** Parses one line of git's rebase-todo syntax, e.g. "pick a1b2c3d Fix the thing" -> "Fix the thing". */
function parseTodoSubject(todoLine: string | undefined): string | undefined {
	return todoLine?.match(/^(?:pick|p)\s+\S+\s+(.*)$/)?.[1];
}

/** git's default stash subject is "WIP on <branch>: <sha> <subject>", or "On <branch>: <message>" when
 * `git stash push -m` supplied one -- splits off the branch it was stashed from (never containing ":"
 * -- git itself forbids that in a ref name, so this split is unambiguous) from the actual name/message
 * that follows it. Falls back to the raw text as the name, with no branch, for anything that doesn't
 * match either form (e.g. a stash created by some other tool). Shared by the Stashes tree view and
 * the Apply Stash quick-pick so both present a stash the same way, rather than the quick-pick
 * showing git's raw "WIP on/On ..." subject verbatim. */
export function parseStashSubject(subject: string): { branch: string | undefined; name: string } {
	const match = subject.match(/^(?:WIP on|On) ([^:]+):\s*(.*)$/);
	return match ? { branch: match[1], name: match[2] } : { branch: undefined, name: subject };
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
