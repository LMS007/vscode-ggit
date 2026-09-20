export interface BranchTreeFolder<T> {
	kind: 'folder';
	name: string;
	/** The joined path of segments down to this folder (e.g. "alice") — stable across refreshes so
	 * TreeItem.id can be set to it, which is what lets VS Code remember a folder's expand/collapse
	 * state instead of resetting it every time the tree data is rebuilt from scratch. */
	id: string;
	children: BranchTreeNode<T>[];
}

export interface BranchTreeLeaf<T> {
	kind: 'leaf';
	name: string;
	/** The item's full, un-split name — already unique, so it doubles as a stable TreeItem.id. */
	id: string;
	item: T;
}

export type BranchTreeNode<T> = BranchTreeFolder<T> | BranchTreeLeaf<T>;

/** Groups items into a folder tree by splitting each item's name on `/`, e.g. "alice/feature-x" becomes folder "alice" containing leaf "feature-x". */
export function buildBranchTree<T>(items: T[], getName: (item: T) => string): BranchTreeNode<T>[] {
	const root: BranchTreeFolder<T> = { kind: 'folder', name: '', id: '', children: [] };
	for (const item of items) {
		const fullName = getName(item);
		const segments = fullName.split('/').filter(Boolean);
		let current = root;
		let folderPath = '';
		for (let i = 0; i < segments.length - 1; i++) {
			const segment = segments[i];
			folderPath = folderPath ? `${folderPath}/${segment}` : segment;
			const existing = current.children.find(
				(c): c is BranchTreeFolder<T> => c.kind === 'folder' && c.name === segment
			);
			if (existing) {
				current = existing;
			} else {
				const folder: BranchTreeFolder<T> = { kind: 'folder', name: segment, id: folderPath, children: [] };
				current.children.push(folder);
				current = folder;
			}
		}
		current.children.push({ kind: 'leaf', name: segments[segments.length - 1] ?? '', id: fullName, item });
	}
	return root.children;
}

/** Sorts a tree alphabetically (case-insensitive), with `pinned` names forced to the front at the top level only. */
export function sortTree<T>(nodes: BranchTreeNode<T>[], pinned: string[] = []): BranchTreeNode<T>[] {
	const sorted = [...nodes].sort((a, b) => {
		const aPin = pinned.indexOf(a.name);
		const bPin = pinned.indexOf(b.name);
		if (aPin !== -1 || bPin !== -1) {
			return aPin === -1 ? 1 : bPin === -1 ? -1 : aPin - bPin;
		}
		return a.name.localeCompare(b.name);
	});
	for (const node of sorted) {
		if (node.kind === 'folder') {
			node.children = sortTree(node.children);
		}
	}
	return sorted;
}
