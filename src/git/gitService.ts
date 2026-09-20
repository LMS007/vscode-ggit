import { simpleGit, SimpleGit } from 'simple-git';
import { BranchInfo, ChangedFile, CommitInfo, FileStatus, RefBadge, RemoteBranchInfo, StashInfo, WorkingChangeFile } from './types';

const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const FIELD_SEP = '\x1f';
const LOG_FORMAT = ['%H', '%P', '%an', '%ae', '%aI', '%s', '%D'].join(FIELD_SEP);
const STASH_FORMAT = ['%gd', '%H', '%s', '%aI'].join(FIELD_SEP);

export class GitService {
	private readonly git: SimpleGit;

	constructor(readonly repoRoot: string) {
		this.git = simpleGit({ baseDir: repoRoot });
	}

	async isGitRepository(): Promise<boolean> {
		return this.git.checkIsRepo();
	}

	async listLocalBranches(): Promise<BranchInfo[]> {
		const [summary, trackingOut] = await Promise.all([
			this.git.branchLocal(),
			this.git.raw(['for-each-ref', `--format=%(refname:short)${FIELD_SEP}%(upstream:track)`, 'refs/heads']),
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
		return summary.all.map(name => ({ name, isHead: name === summary.current, ...tracking.get(name) }));
	}

	async listRemoteBranches(remote = 'origin'): Promise<RemoteBranchInfo[]> {
		const out = await this.git.raw(['branch', '-r', '--format=%(refname:short)']);
		return out
			.split('\n')
			.map(line => line.trim())
			.filter(name => name.startsWith(`${remote}/`) && name !== `${remote}/HEAD`)
			.map(name => ({ name }));
	}

	/** Returns the current branch name, or undefined if HEAD is detached. */
	async getCurrentBranch(): Promise<string | undefined> {
		const name = (await this.git.raw(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
		return name === 'HEAD' ? undefined : name;
	}

	async checkoutBranch(name: string): Promise<void> {
		await this.git.checkout(name);
	}

	/** Switches to the local branch tracking this remote branch, creating one (after fetching) if it doesn't exist yet. */
	async checkoutRemoteBranch(remoteBranchName: string, remote = 'origin'): Promise<void> {
		const localName = stripRemotePrefix(remoteBranchName, remote);
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

	/** The upstream remote branch a local branch tracks, e.g. "origin/main" — undefined if it isn't tracking one. */
	async getUpstreamBranch(branchName: string): Promise<string | undefined> {
		const out = (
			await this.git.raw(['for-each-ref', '--format=%(upstream:short)', `refs/heads/${branchName}`])
		).trim();
		return out || undefined;
	}

	async fetchBranch(remoteBranchName: string, remote = 'origin'): Promise<void> {
		await this.git.fetch(remote, stripRemotePrefix(remoteBranchName, remote));
	}

	async pullBranch(remoteBranchName: string, remote = 'origin'): Promise<void> {
		await this.git.pull(remote, stripRemotePrefix(remoteBranchName, remote));
	}

	/** Pushes an already-tracked branch to its upstream. */
	async pushBranch(branchName: string, remote = 'origin'): Promise<void> {
		await this.git.push(remote, branchName);
	}

	/** Pushes a never-before-published local branch and sets it up to track the new remote branch. */
	async publishBranch(branchName: string, remoteBranchName: string, remote = 'origin'): Promise<void> {
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
	async getLog(branchName: string): Promise<CommitInfo[]> {
		const upstream = await this.getUpstreamBranch(branchName);
		const refs = upstream ? [branchName, upstream] : [branchName];

		const [out, branchHashesOut] = await Promise.all([
			this.git.raw(['log', ...refs, `--pretty=format:${LOG_FORMAT}`, '--decorate=short', '--']),
			this.git.raw(['rev-list', branchName]),
		]);
		const branchHashes = new Set(branchHashesOut.split('\n').filter(Boolean));

		if (!out.trim()) {
			return [];
		}
		return out.split('\n').map(line => {
			const [hash, parents, authorName, authorEmail, date, message, refsField] = line.split(FIELD_SEP);
			return {
				hash,
				parentHashes: parents ? parents.split(' ').filter(Boolean) : [],
				authorName,
				authorEmail,
				date,
				message,
				refs: parseRefs(refsField ?? ''),
				onBranch: branchHashes.has(hash),
			};
		});
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
		const base = await this.getDiffBase(sha);
		const [nameStatusOut, numstatOut] = await Promise.all([
			this.git.raw(['diff', '--name-status', '-M', base, sha]),
			this.git.raw(['diff', '--numstat', '-M', base, sha]),
		]);
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

	/** Combined staged + unstaged working-tree changes, one entry per file. */
	async getWorkingChanges(): Promise<WorkingChangeFile[]> {
		const status = await this.git.status();
		return status.files.map(f => {
			const staged = f.index !== ' ' && f.index !== '?';
			return {
				path: f.path,
				status: mapStatusCode(staged ? f.index : f.working_dir),
				state: staged ? 'staged' : 'unstaged',
			};
		});
	}

	async fetch(remote = 'origin'): Promise<void> {
		await this.git.fetch(remote);
	}

	async pull(remote = 'origin'): Promise<void> {
		const current = await this.getCurrentBranch();
		if (!current) {
			throw new Error('Cannot pull: HEAD is detached (no current branch).');
		}
		await this.git.pull(remote, current);
	}
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

/** Remote branch names include the remote prefix (e.g. "origin/alice/feature-x"); strips it to get the bare branch name. */
export function stripRemotePrefix(remoteBranchName: string, remote = 'origin'): string {
	return remoteBranchName.startsWith(`${remote}/`) ? remoteBranchName.slice(remote.length + 1) : remoteBranchName;
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
