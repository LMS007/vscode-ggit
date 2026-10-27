import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { GGIT_SHOW_SCHEME, INDEX_REF } from '../diff/showContentProvider';
import { saveOpenDocumentIfDirty } from '../documentUtils';
import { GitService, parseStashSubject, splitRemoteBranch } from './gitService';
import { PickOperation, WorkingChangeFile } from './types';

/** Picks a remote with no prompt at all: `preferredRemote` if given (the History tab's own remote
 * dropdown already resolved that choice), else "origin" if configured, else whichever remote happens
 * to be first. Undefined only when no remote is configured at all. */
async function pickDefaultRemote(gitService: GitService, preferredRemote?: string): Promise<string | undefined> {
	const remotes = await gitService.listRemotes();
	if (preferredRemote && remotes.includes(preferredRemote)) {
		return preferredRemote;
	}
	return remotes.includes('origin') ? 'origin' : remotes[0];
}

/** Resolves which remote branch an action should target: the branch's tracked upstream if
 * it has one; otherwise a default remote (see pickDefaultRemote) paired with the same-named branch --
 * no prompt. This used to show a QuickPick of every branch on every remote when there was no
 * upstream; that's gone in favor of always just picking something sensible. If the guessed branch
 * doesn't actually exist on the chosen remote, the fetch/pull itself fails with a clear git error
 * instead of this asking first. */
async function resolveTargetRemoteBranch(gitService: GitService, branch: string, preferredRemote?: string): Promise<string> {
	const upstream = await gitService.getUpstreamBranch(branch);
	if (upstream) {
		return upstream;
	}
	const remote = await pickDefaultRemote(gitService, preferredRemote);
	if (!remote) {
		throw new Error('No remote configured -- add one from the Remotes view first.');
	}
	return `${remote}/${branch}`;
}

/** Names a remote's mainline usually has -- the fallback for a remote whose default branch git never
 * recorded (see GitService.getRemoteDefaultBranch), e.g. one added by hand rather than cloned. */
const MAINLINE_BRANCH_NAMES = ['main', 'master'];

/** Whether `current` tracking `upstream` looks like an accident rather than a choice: a feature branch
 * tracking its remote's mainline -- `git checkout -b alice/feature-x origin/main` sets that up on its
 * own -- or tracking anything else while a same-named branch already exists on that remote. Pull then
 * brings the mainline's commits in, and once both sides have new ones git stops with "Need to specify
 * how to reconcile divergent branches". A branch tracking a differently named one on purpose (local
 * "dev" tracking origin/develop) matches neither, so it's left alone. Returns the branch's own remote
 * branch name, and whether it exists yet, when the upstream looks wrong. */
async function findMistakenUpstream(
	gitService: GitService,
	current: string,
	upstream: string
): Promise<{ ownBranch: string; ownExists: boolean } | undefined> {
	const { remote, branch } = splitRemoteBranch(upstream);
	if (!remote || branch === current || MAINLINE_BRANCH_NAMES.includes(current)) {
		return undefined;
	}
	const ownBranch = `${remote}/${current}`;
	const [ownExists, defaultBranch] = await Promise.all([
		gitService.remoteBranchExists(ownBranch),
		gitService.getRemoteDefaultBranch(remote),
	]);
	const tracksMainline = upstream === defaultBranch || MAINLINE_BRANCH_NAMES.includes(branch);
	return ownExists || tracksMainline ? { ownBranch, ownExists } : undefined;
}

/** Runs before Pull and Sync: when the branch's upstream looks like an accident (see
 * findMistakenUpstream), asks before pulling from it, offering to track the branch's own remote
 * branch instead -- or, when it isn't on the remote yet, to stop tracking so Push can publish it.
 * Returns the remote branch to go ahead with, or undefined to stop. */
async function confirmPullTarget(
	gitService: GitService,
	current: string,
	target: string,
	verb: 'Pull' | 'Sync'
): Promise<string | undefined> {
	const mistake = await findMistakenUpstream(gitService, current, target);
	if (!mistake) {
		return target;
	}
	const { ownBranch, ownExists } = mistake;
	const fix = ownExists ? `Track ${ownBranch}` : 'Stop Tracking';
	const proceed = `${verb} Anyway`;
	const choice = await vscode.window.showWarningMessage(
		`"${current}" tracks ${target}, not a branch of its own.`,
		{
			modal: true,
			detail: ownExists
				? `This would bring ${target}'s commits into it. ${ownBranch} is this branch on the remote -- track that instead?`
				: `This would bring ${target}'s commits into it. This branch isn't on ${splitRemoteBranch(target).remote} yet: stop tracking ${target}, then Push publishes it as its own branch.`,
		},
		fix,
		proceed
	);
	if (choice === proceed) {
		return target;
	}
	if (choice !== fix) {
		return undefined;
	}
	if (ownExists) {
		await gitService.setUpstream(current, ownBranch);
		return ownBranch;
	}
	await gitService.unsetUpstream(current);
	return undefined;
}

function requireCurrentBranch(current: string | undefined): asserts current is string {
	if (!current) {
		throw new Error('Cannot do this while HEAD is detached (no current branch).');
	}
}

/** Fetch/Pull/Push/Sync below all act on `branchName` when given -- the History tab passes whichever
 * branch it's showing, checked out or not -- and on the checked-out branch otherwise (the Branches
 * view's toolbar, the Command Palette). */
export async function fetchLocalBranch(gitService: GitService, branchName?: string, preferredRemote?: string): Promise<void> {
	const branch = branchName ?? (await gitService.getCurrentBranch());
	requireCurrentBranch(branch);
	const target = await resolveTargetRemoteBranch(gitService, branch, preferredRemote);
	await gitService.fetchBranch(target);
}

/** A real pull merges into the working tree, so only the checked-out branch can have one. Any other
 * branch can only be fast-forwarded in place (see GitService.fastForwardBranch) -- when it has
 * diverged from `target`, that's reported as needing a checkout rather than as git's bare rejection. */
async function pullOrFastForward(gitService: GitService, branch: string, target: string): Promise<void> {
	if (branch === (await gitService.getCurrentBranch())) {
		await gitService.pullBranch(target);
		return;
	}
	try {
		await gitService.fastForwardBranch(branch, target);
	} catch (err) {
		if (isNonFastForwardRejection(err as Error)) {
			throw new Error(
				`"${branch}" and ${target} have diverged. A branch that isn't checked out can only be fast-forwarded -- check out "${branch}" to pull them together.`
			);
		}
		throw err;
	}
}

/** Every remote's new tags, after a pull -- `git pull <remote> <branch>` names the branch, which skips
 * git's usual download of the tags on the commits it brings in. From every remote, not just the one
 * pulled from: a repo's remotes should agree on their tags, and fetchTags never overwrites a local one
 * that differs. Best-effort, since the pull itself already succeeded -- a remote that can't be reached
 * is logged rather than failing it. */
async function fetchTagsFromAllRemotes(gitService: GitService): Promise<void> {
	for (const remote of await gitService.listRemotes()) {
		try {
			await gitService.fetchTags(remote);
		} catch (err) {
			gitService.log(`fetchTagsFromAllRemotes: couldn't fetch tags from ${remote}: ${(err as Error).message.trim()}`);
		}
	}
}

export async function pullLocalBranch(gitService: GitService, branchName?: string, preferredRemote?: string): Promise<void> {
	const branch = branchName ?? (await gitService.getCurrentBranch());
	requireCurrentBranch(branch);
	const target = await confirmPullTarget(
		gitService,
		branch,
		await resolveTargetRemoteBranch(gitService, branch, preferredRemote),
		'Pull'
	);
	if (!target) {
		return;
	}
	await pullOrFastForward(gitService, branch, target);
	await fetchTagsFromAllRemotes(gitService);
}

/** Resolves which remote a publish should target -- a QuickPick (VS Code's own "input box with a
 * dropdown") only when there's real ambiguity to resolve. With a single remote configured that's
 * obviously the only sensible target, so skipping the prompt there saves a click; with none at all,
 * there's nothing to publish to yet. Undefined only when the user cancels a multi-remote picker. */
async function pickRemote(gitService: GitService, branchName: string): Promise<string | undefined> {
	const remotes = await gitService.listRemotes();
	if (remotes.length === 0) {
		throw new Error('No remote configured -- add one from the Remotes view first.');
	}
	if (remotes.length === 1) {
		return remotes[0];
	}
	return vscode.window.showQuickPick(remotes, {
		placeHolder: `Which remote should "${branchName}" publish to?`,
		ignoreFocusOut: true,
	});
}

/** Git's own message for a push rejected because the remote has commits the local branch doesn't --
 * distinct from other push failures (auth, network, ...), which should still just surface as a
 * normal error rather than offering to force. */
function isNonFastForwardRejection(err: Error): boolean {
	return /\[rejected\]/.test(err.message) && /non-fast-forward|fetch first/i.test(err.message);
}

/** Tries a normal push first; only on a non-fast-forward rejection does this escalate to a second,
 * explicit force-push confirmation -- same "try safe first, confirm before escalating" pattern as
 * deleteLocalBranch's force-delete path below. Keeps the common case (a push that just succeeds)
 * free of any extra dialog. */
async function pushWithForceEscalation(gitService: GitService, branchName: string, remote: string): Promise<void> {
	try {
		await gitService.pushBranch(branchName, remote);
	} catch (err) {
		if (!isNonFastForwardRejection(err as Error)) {
			throw err;
		}
		const forceConfirmed = await vscode.window.showWarningMessage(
			`Push rejected: the remote has commits "${branchName}" doesn't have. Force push anyway? This can overwrite them.`,
			{ modal: true },
			'Force Push'
		);
		if (forceConfirmed !== 'Force Push') {
			return;
		}
		await gitService.pushBranch(branchName, remote, { force: true });
	}
}

/** If the branch is already published, pushes it to its actual tracked remote (not necessarily
 * "origin" -- see splitRemoteBranch); otherwise publishes + tracks it against `preferredRemote` if
 * given (the History tab's own remote dropdown already resolved that choice, so there's no need to ask
 * again), or falls back to `pickRemote`'s picker -- used when this is invoked from somewhere with no
 * such dropdown, e.g. the Branches view's Push button. Neither needs the branch checked out. */
export async function pushLocalBranch(gitService: GitService, branchName?: string, preferredRemote?: string): Promise<void> {
	const branch = branchName ?? (await gitService.getCurrentBranch());
	requireCurrentBranch(branch);

	const upstream = await gitService.getUpstreamBranch(branch);
	if (upstream) {
		await pushWithForceEscalation(gitService, branch, splitRemoteBranch(upstream).remote);
		return;
	}

	const remote = preferredRemote ?? (await pickRemote(gitService, branch));
	if (!remote) {
		return;
	}

	const remoteName = await vscode.window.showInputBox({
		prompt: `Publish "${branch}" to ${remote} as:`,
		value: branch,
		validateInput: value => (value.trim() ? undefined : 'Enter a branch name.'),
		ignoreFocusOut: true,
	});
	if (remoteName) {
		await gitService.publishBranch(branch, remoteName.trim(), remote);
	}
}

/** Pulls from the target remote branch (only a fast-forward, for a branch that isn't checked out --
 * see pullOrFastForward), then pushes back — publishing first if the branch isn't tracked yet. */
export async function syncLocalBranch(gitService: GitService, branchName?: string, preferredRemote?: string): Promise<void> {
	const branch = branchName ?? (await gitService.getCurrentBranch());
	requireCurrentBranch(branch);

	const target = await confirmPullTarget(
		gitService,
		branch,
		await resolveTargetRemoteBranch(gitService, branch, preferredRemote),
		'Sync'
	);
	if (!target) {
		return;
	}
	await pullOrFastForward(gitService, branch, target);
	await fetchTagsFromAllRemotes(gitService);

	const upstream = await gitService.getUpstreamBranch(branch);
	if (upstream) {
		await pushWithForceEscalation(gitService, branch, splitRemoteBranch(upstream).remote);
	} else {
		const { remote, branch: remoteBranch } = splitRemoteBranch(target);
		await gitService.publishBranch(branch, remoteBranch, remote);
	}
}

/** Tries a safe (`-d`) delete first; git itself refuses that when the branch isn't fully merged, so
 * only then do we escalate to a second, explicit force-delete confirmation — that's the "checkbox
 * for --force if needed" from the request, since a modal dialog can only offer buttons, not a
 * checkbox. */
export async function deleteLocalBranch(gitService: GitService, branchName: string): Promise<void> {
	const confirmed = await vscode.window.showWarningMessage(
		`Delete local branch "${branchName}"?`,
		{ modal: true },
		'Delete Branch'
	);
	if (confirmed !== 'Delete Branch') {
		return;
	}

	try {
		await gitService.deleteBranch(branchName);
		return;
	} catch (err) {
		if (!/not fully merged/i.test((err as Error).message)) {
			throw err;
		}
	}

	const forceConfirmed = await vscode.window.showWarningMessage(
		`"${branchName}" isn't fully merged. Force delete anyway? This can permanently lose commits.`,
		{ modal: true },
		'Force Delete'
	);
	if (forceConfirmed !== 'Force Delete') {
		return;
	}
	await gitService.deleteBranch(branchName, true);
}

export async function renameLocalBranch(gitService: GitService, branchName: string): Promise<void> {
	const newName = await vscode.window.showInputBox({
		prompt: `Rename branch "${branchName}" to:`,
		value: branchName,
		ignoreFocusOut: true,
		validateInput: value => {
			const trimmed = value.trim();
			if (!trimmed) {
				return 'Enter a branch name.';
			}
			if (trimmed === branchName) {
				return 'Enter a different name.';
			}
			return undefined;
		},
	});
	if (!newName) {
		return;
	}
	await gitService.renameBranch(branchName, newName.trim());
}

type UpstreamPick = vscode.QuickPickItem & { upstream?: string };

/** Points a local branch (the current one when none is given) at a different remote branch, or at
 * none -- the fix for a branch tracking the wrong one, e.g. after `git checkout -b alice/feature-x
 * origin/main`, which tracks origin/main on its own. Same-named remote branches are listed first,
 * since that's nearly always the right pick. A branch on no remote yet has nothing to pick here:
 * Push publishes it and sets up tracking in one go. */
export async function setBranchUpstream(gitService: GitService, branchName?: string): Promise<void> {
	const name = branchName ?? (await gitService.getCurrentBranch());
	requireCurrentBranch(name);
	const [configured, remotes] = await Promise.all([gitService.getConfiguredUpstream(name), gitService.listRemotes()]);
	if (remotes.length === 0) {
		throw new Error('No remote configured -- add one from the Remotes view first.');
	}
	const remoteBranches = (await Promise.all(remotes.map(remote => gitService.listRemoteBranches(remote))))
		.flat()
		.map(b => b.name);
	const sameName = remoteBranches.filter(b => splitRemoteBranch(b).branch === name);
	const others = remoteBranches.filter(b => !sameName.includes(b));

	const toItem = (b: string): UpstreamPick => ({
		label: b,
		description: b === configured ? 'current' : undefined,
		upstream: b,
	});
	const separator = (label: string): UpstreamPick => ({ label, kind: vscode.QuickPickItemKind.Separator });
	const items: UpstreamPick[] = [
		...(sameName.length > 0 ? [separator('Same name'), ...sameName.map(toItem), separator('Other branches')] : []),
		...others.map(toItem),
	];
	if (configured) {
		items.push(separator(''), {
			label: '$(circle-slash) Stop Tracking',
			description: remoteBranches.includes(configured) ? configured : `${configured} (gone)`,
		});
	}

	const tracking = configured ? `Tracks ${configured}.` : "Doesn't track anything.";
	const pick = await vscode.window.showQuickPick(items, {
		title: `Set Upstream for "${name}"`,
		placeHolder:
			sameName.length > 0
				? `${tracking} Pick the remote branch to track.`
				: `${tracking} Not on any remote yet -- Push publishes it and tracks it.`,
		ignoreFocusOut: true,
	});
	if (!pick || pick.upstream === configured) {
		return;
	}
	if (pick.upstream) {
		await gitService.setUpstream(name, pick.upstream);
	} else {
		await gitService.unsetUpstream(name);
	}
}

/** "Mixed" (git's default) is offered as the non-scary option since it keeps working-tree files
 * intact — only "hard" gets the stronger warning, since that's the mode that can actually destroy
 * uncommitted work. */
export async function resetHeadToCommit(gitService: GitService, sha: string, mode: 'mixed' | 'hard'): Promise<void> {
	const shortSha = sha.slice(0, 7);
	if (mode === 'hard') {
		const confirmed = await vscode.window.showWarningMessage(
			`Hard reset to ${shortSha}? This discards all uncommitted changes and permanently removes this branch's commits after this point (if they aren't reachable from anywhere else). This cannot be undone.`,
			{ modal: true },
			'Hard Reset'
		);
		if (confirmed !== 'Hard Reset') {
			return;
		}
	} else {
		const confirmed = await vscode.window.showWarningMessage(
			`Reset to ${shortSha}? This branch's commits after this point will no longer be part of it (your working tree changes are kept, and nothing staged is lost either — that's what "mixed" means here).`,
			{ modal: true },
			'Reset'
		);
		if (confirmed !== 'Reset') {
			return;
		}
	}
	await gitService.resetHead(sha, mode);
}

/** Cherry-picks or reverts `sha` onto the checked-out branch, from the History tab's context menu.
 * Revert confirms first: it adds a commit to whatever branch is checked out, which needn't be the one
 * the History tab is showing. Stopping on conflicts isn't treated as a failure -- the Conflicts tab
 * opens for it on the refresh that follows (see updateConflictContext in extension.ts). */
export async function applyCommitToCurrentBranch(gitService: GitService, operation: PickOperation, sha: string): Promise<void> {
	const [{ subject, isMerge }, current] = await Promise.all([gitService.getCommitSummary(sha), gitService.getCurrentBranch()]);
	const shortSha = sha.slice(0, 7);
	const target = current ? `"${current}"` : 'the detached HEAD';
	if (operation === 'revert') {
		const mergeNote = isMerge ? " It's a merge commit, so this undoes everything the merge brought in." : '';
		const confirmed = await vscode.window.showWarningMessage(
			`Revert ${shortSha} "${subject}"?`,
			{
				modal: true,
				detail: `Adds a new commit to ${target} that undoes this commit's changes. The original stays in history, so this is safe even if it's already been pushed.${mergeNote}`,
			},
			'Revert'
		);
		if (confirmed !== 'Revert') {
			return;
		}
	}
	const outcome = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: `${operation === 'revert' ? 'Reverting' : 'Cherry-picking'} ${shortSha}…` },
		() => gitService.applyCommit(operation, sha)
	);
	if (outcome === 'conflicts') {
		void vscode.window.showInformationMessage(
			`GGit: The ${operation} of ${shortSha} stopped on conflicts. Resolve them in the Conflicts tab, then commit it there.`
		);
	} else if (outcome === 'empty') {
		void vscode.window.showInformationMessage(
			operation === 'revert'
				? `GGit: Nothing to revert -- ${target} already has ${shortSha}'s changes undone.`
				: `GGit: Nothing to cherry-pick -- ${target} already has ${shortSha}'s changes.`
		);
	}
}

/** Confirms, with wording tailored to what's actually about to happen — a new/untracked file gets
 * permanently deleted (there's no committed state to fall back to), a deleted file gets restored,
 * and anything else just gets its edits reverted to HEAD/index. A mixed selection gets a single
 * combined confirmation covering every category present. A conflicted file goes back to HEAD's
 * version like any other change, which also resolves its conflict -- unless HEAD doesn't have it at
 * all (e.g. "deleted by us"), in which case discarding it deletes it. */
export async function discardWorkingChanges(gitService: GitService, files: WorkingChangeFile[]): Promise<void> {
	if (files.length === 0) {
		return;
	}

	const conflictsNotAtHead = new Set<string>();
	for (const f of files) {
		if (f.status === 'U' && !(await gitService.existsAtHead(f.path))) {
			conflictsNotAtHead.add(f.path);
		}
	}
	const newFiles = files.filter(f => f.status === 'A' || f.status === '?');
	const deletedFiles = files.filter(f => f.status === 'D');
	const removedConflicts = files.filter(f => conflictsNotAtHead.has(f.path));
	const otherFiles = files.filter(
		f => f.status !== 'A' && f.status !== '?' && f.status !== 'D' && !conflictsNotAtHead.has(f.path)
	);

	let message: string;
	let confirmLabel: string;
	if (files.length === 1) {
		const fileName = files[0].path.split('/').pop() ?? files[0].path;
		if (newFiles.length === 1) {
			message = `Delete "${fileName}"? It's a new file with no commit history, so this can't be undone.`;
			confirmLabel = 'Delete File';
		} else if (removedConflicts.length === 1) {
			message = `Delete "${fileName}"? HEAD doesn't have this file, so discarding its conflict deletes it. This can't be undone.`;
			confirmLabel = 'Delete File';
		} else if (files[0].status === 'U') {
			message = `Discard changes in "${fileName}"? This resolves its conflict by going back to HEAD's version, and is irreversible.`;
			confirmLabel = 'Discard Changes';
		} else if (deletedFiles.length === 1) {
			message = `Restore "${fileName}"?`;
			confirmLabel = 'Restore File';
		} else {
			message = `Discard changes in "${fileName}"? This is irreversible.`;
			confirmLabel = 'Discard Changes';
		}
	} else {
		const parts: string[] = [];
		if (otherFiles.length > 0) {
			parts.push(`discard changes in ${otherFiles.length} file${otherFiles.length === 1 ? '' : 's'}`);
		}
		if (deletedFiles.length > 0) {
			parts.push(`restore ${deletedFiles.length} deleted file${deletedFiles.length === 1 ? '' : 's'}`);
		}
		if (newFiles.length > 0) {
			parts.push(`permanently delete ${newFiles.length} new file${newFiles.length === 1 ? '' : 's'}`);
		}
		if (removedConflicts.length > 0) {
			parts.push(
				`delete ${removedConflicts.length} conflicted file${removedConflicts.length === 1 ? '' : 's'} that HEAD doesn't have`
			);
		}
		message = `This will ${joinWithAnd(parts)}. This is irreversible.`;
		confirmLabel = 'Continue';
	}

	const confirmed = await vscode.window.showWarningMessage(message, { modal: true }, confirmLabel);
	if (confirmed !== confirmLabel) {
		return;
	}

	for (const f of files) {
		if (f.status === 'A' || f.status === '?' || conflictsNotAtHead.has(f.path)) {
			await gitService.discardNewFile(f.path);
		} else {
			await gitService.discardChanges(f.path);
		}
	}
}

/** A line starting a conflict's "ours" or ending its "theirs" side. `=======` alone is left out --
 * plenty of ordinary files (Markdown/RST underlines) have one. */
const CONFLICT_MARKER = /^(<{7}|>{7})(\s|$)/m;

/** Staging a conflicted file is what marks it resolved, and git stages exactly what's on disk --
 * conflict markers and all. So any open copy with unsaved edits is saved first (see
 * saveOpenDocumentIfDirty), and, like the built-in Git extension, this asks before staging a file
 * that still has markers in it. Returns whether to go ahead with the stage. */
export async function confirmStagingConflicts(gitService: GitService, conflictedPaths: string[]): Promise<boolean> {
	const withMarkers: string[] = [];
	for (const relPath of conflictedPaths) {
		const absPath = gitService.resolveRepoPath(relPath);
		await saveOpenDocumentIfDirty(absPath);
		// Nothing on disk to check when the conflict is one side deleting the file.
		const content = await fs.promises.readFile(absPath, 'utf8').catch(() => '');
		if (CONFLICT_MARKER.test(content)) {
			withMarkers.push(relPath);
		}
	}
	if (withMarkers.length === 0) {
		return true;
	}
	const names = withMarkers.map(p => path.basename(p));
	const message =
		withMarkers.length === 1
			? `"${names[0]}" still has conflict markers in it. Mark it resolved anyway?`
			: `${withMarkers.length} files still have conflict markers in them: ${names.join(', ')}. Mark them resolved anyway?`;
	const confirmLabel = 'Mark Resolved';
	return (await vscode.window.showWarningMessage(message, { modal: true }, confirmLabel)) === confirmLabel;
}

function joinWithAnd(parts: string[]): string {
	if (parts.length <= 1) {
		return parts.join('');
	}
	return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** Whichever branch is currently checked out gets rebased; the branch picked here is what it's rebased
 * onto. Only local branches are offered — mirrors Create Branch's Starting Point picker — since
 * rebasing onto a remote branch you haven't fetched yet would just replay onto stale history anyway
 * (run Fetch/Pull first for that). `--autostash` is always on (see GitService.rebaseOnto), so there's
 * no "you have local changes" failure mode to expose a checkbox for, and interactive rebase
 * (reordering/squashing/rewording commits) is a big enough feature on its own that it's deliberately
 * left out of this first pass — this only ever does a plain, non-interactive rebase. */
export async function rebaseCurrentBranchWithPicker(gitService: GitService): Promise<void> {
	const current = await gitService.getCurrentBranch();
	requireCurrentBranch(current);

	const branches = await gitService.listLocalBranches();
	const picked = await vscode.window.showQuickPick(
		branches.filter(b => b.name !== current).map(b => b.name),
		{ placeHolder: `Rebase "${current}" onto…`, ignoreFocusOut: true }
	);
	if (!picked) {
		return;
	}
	await gitService.rebaseOnto(picked);
}

export async function applyStashWithPicker(gitService: GitService): Promise<void> {
	const stashes = await gitService.listStashes();
	if (stashes.length === 0) {
		void vscode.window.showInformationMessage('GGit: No stashes to apply.');
		return;
	}

	// Same "name" / "branch - date" split the Stashes tree view uses (see parseStashSubject) --
	// label/description match its bright-label/dim-description look, rather than showing git's raw
	// "WIP on <branch>: ..." subject here while the tree already shows the parsed, friendlier form.
	const picked = await vscode.window.showQuickPick(
		stashes.map(stash => {
			const { branch, name } = parseStashSubject(stash.message);
			const date = new Date(stash.date).toLocaleDateString();
			return {
				label: name,
				description: [branch, date].filter(Boolean).join(' - '),
				detail: stash.ref,
				stash,
			};
		}),
		{ placeHolder: 'Select a stash to apply', ignoreFocusOut: true }
	);
	if (picked) {
		await applyStashReportingConflicts(gitService, picked.stash.ref);
	}
}

/** A `git stash apply` that stops on conflicts resolves rather than throws (git reports them on
 * stdout alone -- see GitService.mergeBranch), and leaves nothing like MERGE_HEAD behind for the
 * Conflicts tab to open on, so on its own it looks exactly like a clean apply. The conflicted files
 * themselves show up in Working Copy. */
export async function applyStashReportingConflicts(gitService: GitService, ref: string): Promise<void> {
	await gitService.applyStash(ref);
	const conflicted = await gitService.getConflictedFiles();
	if (conflicted.length > 0) {
		void vscode.window.showWarningMessage(
			`GGit: Applying ${ref} left conflicts in ${conflicted.length} file${conflicted.length === 1 ? '' : 's'} -- ` +
				'they\'re marked "!" in Working Copy. Resolve each one, then check it to mark it resolved. The stash is kept.'
		);
	}
}

/** A single free-text field, so a plain InputBox is the right-sized UI here — no need for a
 * Create-Branch-style custom form. Escape cancels the stash entirely; submitting empty text stashes
 * with git's own default message. */
export async function stashAllWithMessage(gitService: GitService): Promise<void> {
	const message = await vscode.window.showInputBox({
		prompt: 'Stash message (optional)',
		placeHolder: 'e.g. WIP on feature X',
		ignoreFocusOut: true,
	});
	if (message === undefined) {
		return;
	}
	await gitService.stashAll(message.trim() || undefined);
}

export async function stashPathsWithMessage(gitService: GitService, paths: string[]): Promise<void> {
	const message = await vscode.window.showInputBox({
		prompt: `Stash message for ${paths.length} file${paths.length === 1 ? '' : 's'} (optional)`,
		ignoreFocusOut: true,
	});
	if (message === undefined) {
		return;
	}
	await gitService.stashPaths(paths, message.trim() || undefined);
}

/** Resolves the file + 1-indexed line range GGit's own hunk stage/unstage commands should act on,
 * from whatever's currently focused. Uses the full selection (`start`/`end`, always in document
 * order regardless of which direction it was dragged) rather than just the cursor's resting point --
 * GitService.extractHunkPatch matches against the whole range, which is what makes a selection that
 * overlaps a hunk without landing exactly inside its declared bounds still resolve correctly. `side`
 * picks which half of a GGit working-change diff this is meaningful from: the real working-tree file
 * (right side of an unstaged row's diff) to stage a hunk, or the index-content side (right side of a
 * staged row's diff, GGit's own ggit-show scheme with the INDEX_REF marker) to unstage one. Throws a
 * clear, actionable error instead of a raw "cannot read property of undefined" if the cursor isn't
 * somewhere this makes sense. */
function resolveHunkTarget(
	gitService: GitService,
	side: 'unstaged' | 'staged'
): { relPath: string; startLine: number; endLine: number } {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		throw new Error('No active editor — place the cursor in a diff first.');
	}
	const uri = editor.document.uri;
	const startLine = editor.selection.start.line + 1;
	const endLine = editor.selection.end.line + 1;

	if (side === 'unstaged') {
		if (uri.scheme !== 'file') {
			throw new Error("Place the cursor in the working-tree (right) side of an unstaged change's diff.");
		}
		return { relPath: path.relative(gitService.repoRoot, uri.fsPath), startLine, endLine };
	}
	if (uri.scheme !== GGIT_SHOW_SCHEME) {
		throw new Error("Place the cursor in the staged (index) side of a staged change's diff.");
	}
	const ref = new URLSearchParams(uri.query).get('ref');
	if (ref !== INDEX_REF) {
		throw new Error("This isn't a staged-changes diff.");
	}
	return { relPath: uri.path.replace(/^\//, ''), startLine, endLine };
}

/** GGit's own replacement for the built-in Git extension's "Stage Selected Ranges" — that command
 * silently no-ops against GGit's diffs (verified: it depends on the built-in extension's own
 * document/URI model to know what to stage, which GGit's diff content providers don't match), so
 * this stages the hunk under the cursor directly via GitService instead of relying on it. */
export async function stageHunkAtCursor(gitService: GitService): Promise<void> {
	const { relPath, startLine, endLine } = resolveHunkTarget(gitService, 'unstaged');
	await gitService.stageHunkAtLine(relPath, startLine, endLine);
}

export async function unstageHunkAtCursor(gitService: GitService): Promise<void> {
	const { relPath, startLine, endLine } = resolveHunkTarget(gitService, 'staged');
	await gitService.unstageHunkAtLine(relPath, startLine, endLine);
}

/** Appends one or more paths to the repo's top-level .gitignore, creating the file if it doesn't
 * exist yet. Only adds a path if it (or a rooted "/path" form of it) isn't already present verbatim
 * -- doesn't try to interpret existing glob patterns, so it won't catch e.g. "*.log" already
 * covering a path being added, but it also won't ever produce a nonsensical duplicate for the exact
 * common case. This only edits .gitignore itself; like the built-in Git extension's equivalent
 * action, it doesn't also `git rm --cached` an already-tracked file -- .gitignore has no effect on
 * a file git is already tracking, so this is only really useful for untracked ones. Opens the file
 * afterward so what changed is visible, not silent. */
export async function addPathsToGitignore(gitService: GitService, paths: string[]): Promise<void> {
	const gitignorePath = path.join(gitService.repoRoot, '.gitignore');
	let existingLines: string[] = [];
	try {
		existingLines = (await fs.promises.readFile(gitignorePath, 'utf8')).split('\n');
	} catch {
		// No .gitignore yet -- fine, this creates one.
	}
	const existing = new Set(existingLines.map(l => l.trim()).filter(Boolean));
	const newPaths = paths.filter(p => !existing.has(p) && !existing.has(`/${p}`));
	if (newPaths.length === 0) {
		return;
	}
	const needsLeadingNewline = existingLines.length > 0 && existingLines[existingLines.length - 1].trim() !== '';
	await fs.promises.appendFile(gitignorePath, (needsLeadingNewline ? '\n' : '') + newPaths.join('\n') + '\n', 'utf8');
	const doc = await vscode.workspace.openTextDocument(gitignorePath);
	await vscode.window.showTextDocument(doc, { preview: false });
}
