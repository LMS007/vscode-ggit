import { simpleGit, SimpleGit } from 'simple-git';
import { BranchInfo, ChangedFile, CommitInfo, FileStatus, RemoteBranchInfo } from './types';

const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const FIELD_SEP = '\x1f';
const LOG_FORMAT = ['%H', '%P', '%an', '%ae', '%aI', '%s'].join(FIELD_SEP);

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

	async getLog(branchName: string): Promise<CommitInfo[]> {
		const out = await this.git.raw(['log', branchName, `--pretty=format:${LOG_FORMAT}`, '--']);
		if (!out.trim()) {
			return [];
		}
		return out.split('\n').map(line => {
			const [hash, parents, authorName, authorEmail, date, message] = line.split(FIELD_SEP);
			return {
				hash,
				parentHashes: parents ? parents.split(' ').filter(Boolean) : [],
				authorName,
				authorEmail,
				date,
				message,
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
		const out = await this.git.raw(['diff', '--name-status', '-M', base, sha]);
		if (!out.trim()) {
			return [];
		}
		return out
			.split('\n')
			.filter(Boolean)
			.map(line => {
				const parts = line.split('\t');
				const status = parts[0][0] as FileStatus;
				if (status === 'R' || status === 'C') {
					return { status, oldPath: parts[1], path: parts[2] };
				}
				return { status, path: parts[1] };
			});
	}

	/** Throws if `relPath` did not exist at `sha` — used by the diff provider to detect add/delete. */
	async getFileContentAtRevision(sha: string, relPath: string): Promise<string> {
		return this.git.show([`${sha}:${relPath}`]);
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
