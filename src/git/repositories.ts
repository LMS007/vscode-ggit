import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { GitService } from './gitService';

/** workspaceState: the repository GGit showed last, relative to the opened folder ('' for the folder itself). */
const ACTIVE_REPO_KEY = 'ggit.activeRepository';

/** A repository GGit can show: the opened folder itself, or a repository directly inside it. */
export interface RepoEntry {
	/** Absolute path; where git runs. */
	readonly root: string;
	/** What the Repository dropdown and the views' headers call it: the folder's own name for the
	 * opened folder, otherwise its path from there ("Atlas", "tools/lzham_codec"). */
	readonly name: string;
	/** Relative to the opened folder, '' for the folder itself. What's remembered between sessions. */
	readonly relative: string;
}

/** The repositories in the opened folder, and which one GGit is showing. That's the folder itself when
 * it's a repository, plus every repository directly inside it, which covers a folder of checkouts.
 * Deeper ones are listed only when the folder's own repository already knows about them, so nothing
 * crawls whole trees: its submodules (from .gitmodules), and the repositories inside it that it
 * doesn't track (from git's own untracked and ignored listings). Those are what show up as rows in
 * its Working Copy, and clicking one switches here. When nothing is found, the folder itself is the
 * only entry, so Working Copy offers to initialize it. */
export class Repositories {
	private readonly services = new Map<string, GitService>();
	private readonly folderEntry: RepoEntry;
	private list: RepoEntry[];
	private active: RepoEntry;
	private discovered = false;
	/** Runs discover() one at a time, since each one compares against the list the last one left. */
	private discovering: Promise<unknown> = Promise.resolve();
	private readonly _onDidChangeActive = new vscode.EventEmitter<RepoEntry>();
	/** After the active repository changes: a pick from the dropdown, or the active one disappearing. */
	readonly onDidChangeActive = this._onDidChangeActive.event;

	/** A GitService that acts on whichever repository is active at the moment each method is called.
	 * It's for the long-lived views and helpers that always show "the current repository". Anything
	 * that runs several git commands which must all land in the same repository (a panel, say) should
	 * hold `current` instead, so a switch partway through can't split its work across two repos. */
	readonly live: GitService;

	constructor(
		folder: vscode.WorkspaceFolder,
		private readonly state: vscode.Memento,
		private readonly logger: (message: string) => void
	) {
		this.folderEntry = { root: folder.uri.fsPath, name: folder.name, relative: '' };
		this.list = [this.folderEntry];
		this.active = this.folderEntry;
		this.live = new Proxy({} as GitService, {
			get: (_target, prop) => {
				const service = this.current;
				const value: unknown = Reflect.get(service, prop, service);
				return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(service) : value;
			},
		});
	}

	get current(): GitService {
		return this.serviceFor(this.active.root);
	}

	get activeEntry(): RepoEntry {
		return this.active;
	}

	get entries(): readonly RepoEntry[] {
		return this.list;
	}

	get isMultiRepo(): boolean {
		return this.list.length > 1;
	}

	/** The GitService for a listed repository, and undefined for any other path. That way a root that
	 * arrived from somewhere less trustworthy (a URI, a webview message) can't point git at an
	 * arbitrary folder. */
	serviceForListed(root: string): GitService | undefined {
		return this.list.some(e => e.root === root) ? this.serviceFor(root) : undefined;
	}

	/** Looks for repositories again and returns whether the list changed. The active one stays unless
	 * it's gone. On the first run, the one active last session is restored if it's still there. */
	discover(): Promise<boolean> {
		const run = this.discovering.then(() => this.discoverNow());
		this.discovering = run.catch(() => undefined);
		return run;
	}

	/** Makes a listed repository the active one and remembers it for next time. */
	select(root: string): void {
		const entry = this.list.find(e => e.root === root);
		if (!entry || entry.root === this.active.root) {
			return;
		}
		void this.state.update(ACTIVE_REPO_KEY, entry.relative);
		this.active = entry;
		this._onDidChangeActive.fire(entry);
	}

	private async discoverNow(): Promise<boolean> {
		const folderService = this.serviceFor(this.folderEntry.root);
		const [folderIsRepo, children] = await Promise.all([
			folderService.isGitRepository().catch(() => false),
			findChildRepos(this.folderEntry.root),
		]);
		const nested = folderIsRepo ? await findNestedRepos(folderService, this.logger) : [];
		const inside = sortEntries(dedupeEntries([...children, ...nested]));
		const list = folderIsRepo || inside.length === 0 ? [this.folderEntry, ...inside] : inside;
		const changed = list.length !== this.list.length || list.some((e, i) => e.root !== this.list[i].root);
		if (changed) {
			this.logger(`repositories: ${list.map(e => e.relative || `${e.name} (opened folder)`).join(', ')}`);
		}
		this.list = list;
		const preferred = this.discovered ? this.active.relative : this.state.get<string>(ACTIVE_REPO_KEY, '');
		this.discovered = true;
		const next = list.find(e => e.relative === preferred) ?? list[0];
		if (next.root !== this.active.root) {
			this.active = next;
			this._onDidChangeActive.fire(next);
		}
		return changed;
	}

	private serviceFor(root: string): GitService {
		let service = this.services.get(root);
		if (!service) {
			service = new GitService(root, this.logger);
			this.services.set(root, service);
		}
		return service;
	}
}

/** Where a repository's git data lives, for watching it: `<root>/.git` itself, or, when .git is a
 * file pointing elsewhere, the directory it points to. A submodule's points into the superproject's
 * .git/modules. A linked worktree's points at its own folder under the main repository's
 * .git/worktrees, which also names the shared git dir holding the refs. That shared dir is what's
 * returned, since the worktree's own HEAD and index sit under its worktrees/ subfolder there. */
export function resolveGitDir(root: string): string {
	const dotGit = path.join(root, '.git');
	try {
		if (!fs.statSync(dotGit).isFile()) {
			return dotGit;
		}
		const pointer = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'))?.[1].trim();
		if (!pointer) {
			return dotGit;
		}
		const gitDir = path.resolve(root, pointer);
		const commonDirFile = path.join(gitDir, 'commondir');
		return fs.existsSync(commonDirFile) ? path.resolve(gitDir, fs.readFileSync(commonDirFile, 'utf8').trim()) : gitDir;
	} catch {
		// No .git at all: not a repository (yet). Watching where it would appear is what notices a `git init`.
		return dotGit;
	}
}

/** Whether `target` is `folder` or somewhere inside it. */
export function isInsideFolder(folder: string, target: string): boolean {
	const relative = path.relative(folder, target);
	return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** The folders directly inside `folder` that hold a repository: a .git directory, or the .git file a
 * submodule or linked worktree has instead. */
async function findChildRepos(folder: string): Promise<RepoEntry[]> {
	let dirents: fs.Dirent[];
	try {
		dirents = await fs.promises.readdir(folder, { withFileTypes: true });
	} catch {
		return [];
	}
	const found = await Promise.all(
		dirents
			.filter(d => d.isDirectory() && d.name !== '.git')
			.map(async d => {
				const root = path.join(folder, d.name);
				const hasGit = await fs.promises.access(path.join(root, '.git')).then(
					() => true,
					() => false
				);
				return hasGit ? { root, name: d.name, relative: d.name } : undefined;
			})
	);
	return found.filter((e): e is RepoEntry => e !== undefined);
}

/** The repositories the folder's own repository knows about, at any depth: its submodules that are
 * checked out, and the repositories inside it that it doesn't track, ignored ones included (so one
 * that's been ignored stays switchable). Each lookup that fails is just skipped. */
async function findNestedRepos(folder: GitService, logger: (message: string) => void): Promise<RepoEntry[]> {
	const lookup = <T>(what: string, run: () => Promise<T>, fallback: T): Promise<T> =>
		run().catch(err => {
			logger(`repositories: couldn't list ${what}: ${(err as Error).message}`);
			return fallback;
		});
	const [registered, untracked, ignored] = await Promise.all([
		lookup('submodules', () => folder.getRegisteredSubmodulePaths(), new Set<string>()),
		lookup('untracked repositories', () => folder.getUntrackedNestedRepos(), []),
		lookup('ignored repositories', () => folder.getIgnoredNestedRepos(), []),
	]);
	// A submodule that's never been checked out (`git submodule update --init`) is an empty folder.
	const checkedOut = await Promise.all(
		[...registered].map(async rel =>
			fs.promises.access(path.join(folder.repoRoot, rel, '.git')).then(
				() => rel,
				() => undefined
			)
		)
	);
	const relatives = [...checkedOut.filter((rel): rel is string => rel !== undefined), ...untracked, ...ignored];
	return relatives.map(rel => ({ root: path.join(folder.repoRoot, ...rel.split('/')), name: rel, relative: rel }));
}

/** Drops a repository found twice (a submodule directly inside the folder is found both ways). */
function dedupeEntries(entries: RepoEntry[]): RepoEntry[] {
	const seen = new Set<string>();
	return entries.filter(entry => {
		// Windows paths don't care about case, and .gitmodules could spell a folder differently.
		const key = process.platform === 'win32' ? entry.root.toLowerCase() : entry.root;
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	});
}

/** By path, ignoring case, so tools/lzham_alpha sorts among the t's. */
function sortEntries(entries: RepoEntry[]): RepoEntry[] {
	return entries.sort((a, b) => a.relative.localeCompare(b.relative, undefined, { sensitivity: 'base' }));
}
