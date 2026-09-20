import { simpleGit, SimpleGit } from 'simple-git';
import { BranchInfo, ChangedFile, CommitInfo, FileStatus, RefBadge, RemoteBranchInfo, WorkingChangeFile } from './types';

const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const FIELD_SEP = '\x1f';
const LOG_FORMAT = ['%H', '%P', '%an', '%ae', '%aI', '%s', '%D'].join(FIELD_SEP);

export class GitService {
	private readonly git: SimpleGit;

	constructor(readonly repoRoot: string) {
		this.git = simpleGit({ baseDir: repoRoot });
	}

	async isGitRepository(): Promise<boolean> {
		return this.git.checkIsRepo();
	}

	async listLocalBranches(): Promise<BranchInfo[]> {
		const summary = await this.git.branchLocal();
		return summary.all.map(name => ({ name, isHead: name === summary.current }));
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

	async getLog(branchName: string): Promise<CommitInfo[]> {
		const out = await this.git.raw(['log', branchName, `--pretty=format:${LOG_FORMAT}`, '--decorate=short', '--']);
		if (!out.trim()) {
			return [];
		}
		return out.split('\n').map(line => {
			const [hash, parents, authorName, authorEmail, date, message, refs] = line.split(FIELD_SEP);
			return {
				hash,
				parentHashes: parents ? parents.split(' ').filter(Boolean) : [],
				authorName,
				authorEmail,
				date,
				message,
				refs: parseRefs(refs ?? ''),
			};
		});
	}

	/** The commit's first parent, or git's well-known empty-tree SHA for a root commit. */
	async getDiffBase(sha: string): Promise<string> {
		const revList = (await this.git.raw(['rev-list', '--parents', '-n', '1', sha])).trim().split(' ');
		return revList.length > 1 ? revList[1] : EMPTY_TREE_SHA;
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

	async stageFile(relPath: string): Promise<void> {
		await this.git.raw(['add', '--', relPath]);
	}

	async unstageFile(relPath: string): Promise<void> {
		await this.git.raw(['reset', '--', relPath]);
	}

	/** Reverts a file to its last-committed (HEAD) state, in both the index and the working tree —
	 * this is what "discard local changes" means here. Only valid for a path that exists at HEAD;
	 * never call this for a new/untracked file (nothing to revert to). */
	async discardChanges(relPath: string): Promise<void> {
		await this.git.raw(['checkout', 'HEAD', '--', relPath]);
	}

	async stageAll(): Promise<void> {
		await this.git.raw(['add', '-A']);
	}

	async unstageAll(): Promise<void> {
		await this.git.raw(['reset']);
	}

	/** Stashes every working-tree change, tracked or not. */
	async stashAll(): Promise<void> {
		await this.git.raw(['stash', 'push', '--include-untracked']);
	}

	/** Stashes only the given paths, leaving the rest of the working tree untouched. */
	async stashPaths(relPaths: string[]): Promise<void> {
		await this.git.raw(['stash', 'push', '--include-untracked', '--', ...relPaths]);
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
