import * as path from 'path';
import * as vscode from 'vscode';
import { GitService, unlessNotARepo } from '../git/gitService';
import { isStageable, WorkingChangeFile } from '../git/types';
import { toCreateCommitUri, toWorkingChangeFolderUri, toWorkingChangeUri } from './workingChangeDecoration';

/** Pinned above the file list — its checkbox is a check-all/uncheck-all for staging (checked only
 * when every change is already staged), and clicking the row itself opens the Commit panel. */
interface CreateCommitNode {
	kind: 'createCommit';
	allStaged: boolean;
	stagedCount: number;
}

/** A directory row, only in tree mode (see the ggit.workingCopy.viewMode setting). `label` can span
 * several path segments: a chain of folders whose only child is another folder is compacted into one
 * row, the same way the built-in Source Control view does it. Its checkbox stages/unstages
 * everything beneath it. */
export interface WorkingCopyFolderNode {
	kind: 'folder';
	path: string;
	label: string;
	children: WorkingCopyNode[];
	allStaged: boolean;
	/** Whether anything beneath it can be staged. A folder holding nothing but a repository GGit won't
	 * stage (see isStageable) gets no checkbox. */
	stageable: boolean;
}

export type WorkingCopyNode = WorkingChangeFile | CreateCommitNode | WorkingCopyFolderNode;

export type WorkingCopyViewMode = 'list' | 'tree';

export function getWorkingCopyViewMode(): WorkingCopyViewMode {
	return vscode.workspace.getConfiguration('ggit').get<WorkingCopyViewMode>('workingCopy.viewMode', 'tree');
}

export function isCreateCommitNode(node: WorkingCopyNode): node is CreateCommitNode {
	return 'kind' in node && node.kind === 'createCommit';
}

export function isFolderNode(node: WorkingCopyNode): node is WorkingCopyFolderNode {
	return 'kind' in node && node.kind === 'folder';
}

export function isWorkingChangeFile(node: WorkingCopyNode): node is WorkingChangeFile {
	return !('kind' in node);
}

/** Every file row at or beneath a node — the node itself for a file, nothing for Create Commit. */
export function collectWorkingChangeFiles(node: WorkingCopyNode): WorkingChangeFile[] {
	if (isWorkingChangeFile(node)) {
		return [node];
	}
	if (isFolderNode(node)) {
		return node.children.flatMap(collectWorkingChangeFiles);
	}
	return [];
}

/** A staged+unstaged file list, styled after the built-in Git extension's Changes views but
 * collapsed into a single section — staged vs. unstaged is the leading checkbox, which the tree view's
 * own onDidChangeCheckboxState handles (see extension.ts) to actually stage/unstage on click. Shown
 * either flat (directory as the description) or nested under folder rows, per
 * ggit.workingCopy.viewMode. */
export class WorkingCopyTreeProvider implements vscode.TreeDataProvider<WorkingCopyNode> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	// A file with both staged and unstaged changes at once renders as two rows sharing a path (see
	// GitService.getWorkingChanges) — this is how getTreeItem knows to visually tell them apart.
	// Populated by getChildren and read by getTreeItem; safe because VS Code always calls
	// getChildren for a freshly-rendered level before asking for its items' TreeItems.
	private splitPaths = new Set<string>();
	// Snapshot of the mode the current rows were built in, so getTreeItem stays consistent with
	// getChildren even if the setting flips mid-render.
	private viewMode: WorkingCopyViewMode = 'tree';

	constructor(private readonly gitService: GitService) {}

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	async getChildren(element?: WorkingCopyNode): Promise<WorkingCopyNode[]> {
		if (element) {
			return isFolderNode(element) ? element.children : [];
		}
		const files = await unlessNotARepo(
			this.gitService.time('WorkingCopyTreeProvider.getChildren: getWorkingChanges', () => this.gitService.getWorkingChanges()),
			undefined
		);
		// Not a repo: no Create Commit row either, not just no files.
		if (!files) {
			return [];
		}
		// Sorted by path first — deliberately not re-grouped by staged/unstaged, so checking a box
		// doesn't reshuffle the list out from under you — then staged-before-unstaged only to give a
		// deterministic order to the two rows a split (partially-staged) path produces.
		const sorted = files.sort(
			(a, b) => a.path.localeCompare(b.path) || (a.state === b.state ? 0 : a.state === 'staged' ? -1 : 1)
		);
		const pathCounts = new Map<string, number>();
		for (const f of sorted) {
			pathCounts.set(f.path, (pathCounts.get(f.path) ?? 0) + 1);
		}
		this.splitPaths = new Set([...pathCounts].filter(([, count]) => count > 1).map(([p]) => p));
		this.viewMode = getWorkingCopyViewMode();
		const stagedCount = sorted.filter(f => f.state === 'staged').length;
		// Rows without a checkbox (a repository GGit won't stage) can't hold Create Commit unchecked.
		const stageable = sorted.filter(isStageable);
		const allStaged = stageable.length > 0 && stageable.every(f => f.state === 'staged');
		this.gitService.log(
			`WorkingCopyTreeProvider.getChildren: ${sorted.length} row(s), mode=${this.viewMode}, splitPaths=${JSON.stringify([...this.splitPaths])}`
		);
		const rows = this.viewMode === 'tree' ? buildFileTree(sorted) : sorted;
		return [{ kind: 'createCommit', allStaged, stagedCount }, ...rows];
	}

	getTreeItem(node: WorkingCopyNode): vscode.TreeItem {
		if (isCreateCommitNode(node)) {
			const item = new vscode.TreeItem('Create Commit', vscode.TreeItemCollapsibleState.None);
			item.iconPath = new vscode.ThemeIcon('git-commit', new vscode.ThemeColor('textLink.foreground'));
			item.resourceUri = toCreateCommitUri();
			item.checkboxState = node.allStaged ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
			// TreeItem.description is the only slot that renders after the label — same trick already
			// used for branch ahead/behind counts — so it's the closest thing to "right-aligned" here.
			item.description = String(node.stagedCount);
			item.tooltip = 'Check to stage everything, uncheck to unstage everything. Click to open Commit.';
			item.contextValue = 'createCommitAction';
			item.command = { command: 'ggit.commit', title: 'Create Commit' };
			return item;
		}
		if (isFolderNode(node)) {
			const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
			// A stable id keeps each folder's expanded/collapsed state across refreshes, which
			// rebuild every node object from scratch.
			item.id = `ggit-folder:${node.path}`;
			item.iconPath = vscode.ThemeIcon.Folder;
			item.resourceUri = toWorkingChangeFolderUri(node.path);
			if (node.stageable) {
				item.checkboxState = node.allStaged ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
			}
			item.tooltip = node.stageable ? `${node.path} — check to stage everything in this folder, uncheck to unstage it` : node.path;
			item.contextValue = 'workingChangeFolder';
			return item;
		}
		const file = node;
		const dir = path.dirname(file.path);
		// In tree mode the enclosing folder rows already say where the file lives.
		const dirLabel = dir === '.' || this.viewMode === 'tree' ? undefined : dir;
		if (file.nested) {
			return nestedRepoItem(file, dirLabel);
		}
		const item = new vscode.TreeItem(path.basename(file.path), vscode.TreeItemCollapsibleState.None);
		item.resourceUri = toWorkingChangeUri(file.path, file.status);
		if (file.status === 'U') {
			// Unchecked until resolved: checking it stages the file as-is, which is exactly what marks a
			// conflict resolved in git (see confirmStagingConflicts for the conflict-marker check).
			item.description = [dirLabel, '(conflicted)'].filter(Boolean).join('  ');
			item.checkboxState = vscode.TreeItemCheckboxState.Unchecked;
			item.contextValue = 'workingChangeConflicted';
			item.tooltip = `${file.path} — conflicted. Resolve it in the editor, then check it to mark it resolved, or Discard Changes to go back to HEAD's version.`;
			// The file itself, not a diff: there's no single index version of an unmerged file to diff
			// against, and opening it plainly is what brings up the editor's own conflict-marker
			// actions (Accept Current/Incoming, Resolve in Merge Editor).
			item.command = { command: 'ggit.openWorkingChangeFile', title: 'Open File', arguments: [file] };
			return item;
		}
		const isSplit = this.splitPaths.has(file.path);
		// Placeholder until real hunk-level staging UI exists: a file with both staged and unstaged
		// changes at once (see GitService.getWorkingChanges) renders as two rows sharing a name, so
		// this label is the only thing telling them apart right now.
		item.description = isSplit
			? [dirLabel, file.state === 'staged' ? '(staged)' : '(unstaged)'].filter(Boolean).join('  ')
			: dirLabel;
		item.checkboxState =
			file.state === 'staged' ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
		item.contextValue = file.state === 'staged' ? 'workingChangeStaged' : 'workingChangeUnstaged';
		item.tooltip = isSplit
			? `${file.path} — ${file.state === 'staged' ? 'staged portion' : 'remaining unstaged changes'} (this file has both)`
			: `${file.path} (${file.state})`;
		item.command = {
			command: 'ggit.openWorkingChangeDiff',
			title: 'Open Diff',
			arguments: [file],
		};
		return item;
	}
}

/** A repository inside the one Working Copy shows (see NestedRepoInfo): a repo icon, what's changed
 * in it, and a checkbox only when staging does something. Clicking it switches GGit to that
 * repository. When it has both a staged and an unstaged row, they already read differently, so they
 * don't need the "(staged)"/"(unstaged)" suffix a file gets. */
function nestedRepoItem(file: WorkingChangeFile, dirLabel: string | undefined): vscode.TreeItem {
	const nested = file.nested!;
	const item = new vscode.TreeItem(path.basename(file.path), vscode.TreeItemCollapsibleState.None);
	item.resourceUri = toWorkingChangeUri(file.path, file.status);
	item.iconPath = new vscode.ThemeIcon(nested.kind === 'submodule' ? 'file-submodule' : 'repo');
	item.description = [dirLabel, describeNestedRepo(file)].filter(Boolean).join('  ');
	if (isStageable(file)) {
		item.checkboxState =
			file.state === 'staged' ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
	}
	item.contextValue =
		nested.kind === 'untracked'
			? 'workingChangeNestedRepo'
			: nested.registered
				? 'workingChangeSubmodule'
				: 'workingChangeSubmoduleUnregistered';
	item.tooltip = nestedRepoTooltip(file);
	item.command = { command: 'ggit.openNestedRepository', title: 'Switch to This Repository', arguments: [file] };
	return item;
}

/** "new commits", "changes inside", "not a submodule"... */
function describeNestedRepo(file: WorkingChangeFile): string {
	const nested = file.nested!;
	if (nested.kind === 'untracked') {
		return 'not a submodule';
	}
	let what: string;
	if (file.status === 'A') {
		what = 'added as submodule';
	} else if (file.status === 'D') {
		what = 'submodule removed';
	} else if (file.state === 'staged') {
		what = 'new commits';
	} else {
		const parts = [nested.newCommits && 'new commits', nested.modified && 'changes inside', nested.untracked && 'new files inside'];
		what = parts.filter(Boolean).join(', ') || 'changed';
	}
	return nested.registered ? what : `${what} · not in .gitmodules`;
}

function nestedRepoTooltip(file: WorkingChangeFile): string {
	const nested = file.nested!;
	const name = file.path;
	if (nested.kind === 'untracked') {
		return [
			`${name} is a separate git repository that this one doesn't track. Click to switch to it.`,
			"It has no checkbox: staging it would record a bare commit that clones of this repository can't fetch. Right-click to add it as a submodule, or to ignore it.",
		].join('\n\n');
	}
	const lines: string[] = [];
	if (file.state === 'staged') {
		lines.push(`${name}: staged. Committing records the commit it's checked out at.`);
	} else if (isStageable(file)) {
		lines.push(`${name} is checked out at a different commit than this repository has recorded. Check it to record that commit.`);
	}
	if (file.state === 'unstaged' && (nested.modified || nested.untracked)) {
		lines.push(`${name} has uncommitted changes. Commit them in ${name} first; this repository can then record that commit.`);
	}
	if (!nested.registered) {
		lines.push(
			"It isn't listed in .gitmodules, so clones of this repository won't know where to fetch it. Right-click → Add as Submodule… to list it."
		);
	}
	lines.push('Click to switch to it.');
	return lines.join('\n\n');
}

/** Nests path-sorted files under folder rows: folders before files at each level (like the
 * Explorer), single-folder chains compacted into one row, files keeping their incoming order. */
function buildFileTree(files: WorkingChangeFile[]): WorkingCopyNode[] {
	interface Dir {
		dirs: Map<string, Dir>;
		files: WorkingChangeFile[];
	}
	const root: Dir = { dirs: new Map(), files: [] };
	for (const file of files) {
		const segments = file.path.split('/');
		segments.pop();
		let dir = root;
		for (const segment of segments) {
			let next = dir.dirs.get(segment);
			if (!next) {
				next = { dirs: new Map(), files: [] };
				dir.dirs.set(segment, next);
			}
			dir = next;
		}
		dir.files.push(file);
	}

	const toNodes = (dir: Dir, parentPath: string): WorkingCopyNode[] => {
		const folders = [...dir.dirs.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([name, child]): WorkingCopyFolderNode => {
				let label = name;
				let folderPath = parentPath ? `${parentPath}/${name}` : name;
				while (child.files.length === 0 && child.dirs.size === 1) {
					const [[onlyName, onlyChild]] = child.dirs;
					label = `${label}/${onlyName}`;
					folderPath = `${folderPath}/${onlyName}`;
					child = onlyChild;
				}
				const children = toNodes(child, folderPath);
				const node: WorkingCopyFolderNode = { kind: 'folder', path: folderPath, label, children, allStaged: false, stageable: false };
				const stageable = collectWorkingChangeFiles(node).filter(isStageable);
				node.stageable = stageable.length > 0;
				node.allStaged = node.stageable && stageable.every(f => f.state === 'staged');
				return node;
			});
		return [...folders, ...dir.files];
	};
	return toNodes(root, '');
}
