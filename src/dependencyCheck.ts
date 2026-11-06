import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { GitService } from './git/gitService';

/** Lockfiles at the repo root, the package manager that installs from each, and the files that
 * manager rewrites under node_modules on every install -- whichever exists is how to tell an install
 * already happened since the lockfile last changed. */
const LOCKFILES: { file: string; manager: string; installMarkers: string[] }[] = [
	{ file: 'pnpm-lock.yaml', manager: 'pnpm', installMarkers: ['node_modules/.modules.yaml'] },
	{ file: 'package-lock.json', manager: 'npm', installMarkers: ['node_modules/.package-lock.json'] },
	{ file: 'yarn.lock', manager: 'yarn', installMarkers: ['node_modules/.yarn-state.yml', 'node_modules/.yarn-integrity'] },
	{ file: 'bun.lock', manager: 'bun', installMarkers: [] },
	{ file: 'bun.lockb', manager: 'bun', installMarkers: [] },
];

const SETTING = 'suggestInstallOnLockfileChange';

/** Offers to reinstall dependencies when the checked-out commit changes and takes a different
 * lockfile with it -- a checkout, pull, rebase or merge, from GGit or the terminal. Otherwise the
 * first sign of stale node_modules is something failing later for no obvious reason, like a pre-push
 * hook that can't resolve a package the new commits started using. Checked on every refresh, which
 * is cheap: one `rev-parse` unless HEAD moved. */
export class DependencyCheck {
	/** HEAD as of the last check. Not updated mid-rebase or mid-merge: the check waits for it to
	 * finish, then compares against where it started. */
	private lastHead: string | undefined;

	constructor(private readonly gitService: GitService) {}

	async check(): Promise<void> {
		if (!vscode.workspace.getConfiguration('ggit').get<boolean>(SETTING, true)) {
			this.lastHead = undefined;
			return;
		}
		if ((await this.gitService.isRebaseInProgress()) || (await this.gitService.isMergeInProgress())) {
			return;
		}
		const head = await this.gitService.getHeadSha();
		// Read and replaced with no await in between, so overlapping checks (refreshes come in bursts)
		// can't both see the same move.
		const previous = this.lastHead;
		this.lastHead = head;
		if (!previous || !head || previous === head) {
			return;
		}
		const changed = await this.gitService.changedPaths(previous, head, LOCKFILES.map(l => l.file));
		const lockfile = LOCKFILES.find(l => changed.includes(l.file));
		if (!lockfile || !this.installLooksStale(lockfile)) {
			return;
		}
		this.gitService.log(`dependencyCheck: ${lockfile.file} changed between ${previous.slice(0, 7)} and ${head.slice(0, 7)}`);
		const install = `Run ${lockfile.manager} install`;
		const stopAsking = "Don't Ask Again";
		const choice = await vscode.window.showInformationMessage(
			`GGit: Dependencies changed (${lockfile.file}). Run ${lockfile.manager} install?`,
			install,
			stopAsking
		);
		if (choice === install) {
			const terminal = vscode.window.createTerminal({ name: `GGit: ${lockfile.manager} install`, cwd: this.gitService.repoRoot });
			terminal.show();
			terminal.sendText(`${lockfile.manager} install`);
		} else if (choice === stopAsking) {
			await vscode.workspace.getConfiguration('ggit').update(SETTING, false, vscode.ConfigurationTarget.Global);
		}
	}

	/** Whether node_modules is older than the lockfile on disk. Nothing to say when there's no
	 * node_modules at all (never installed here, or not a JS project). A lockfile the new commit
	 * changed, but that an install has since caught up with -- e.g. one `pnpm add` just rewrote, then
	 * got committed -- doesn't count. Without a known marker to go by, assume it's stale. */
	private installLooksStale(lockfile: (typeof LOCKFILES)[number]): boolean {
		const root = this.gitService.repoRoot;
		try {
			if (!fs.existsSync(path.join(root, 'node_modules'))) {
				return false;
			}
			const lockfileTime = fs.statSync(path.join(root, lockfile.file)).mtimeMs;
			const marker = lockfile.installMarkers.map(m => path.join(root, m)).find(m => fs.existsSync(m));
			return !marker || fs.statSync(marker).mtimeMs < lockfileTime;
		} catch {
			// The lockfile itself is gone -- the new commit deleted it.
			return false;
		}
	}
}
