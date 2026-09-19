export interface BranchTreeFolder<T> {
	kind: 'folder';
	name: string;
	children: BranchTreeNode<T>[];
}

export interface BranchTreeLeaf<T> {
	kind: 'leaf';
	name: string;
	item: T;
}

export type BranchTreeNode<T> = BranchTreeFolder<T> | BranchTreeLeaf<T>;

/** Groups items into a folder tree by splitting each item's name on `/`, e.g. "alice/feature-x" becomes folder "alice" containing leaf "feature-x". */
export function buildBranchTree<T>(items: T[], getName: (item: T) => string): BranchTreeNode<T>[] {
	const root: BranchTreeFolder<T> = { kind: 'folder', name: '', children: [] };
	for (const item of items) {
		const segments = getName(item).split('/').filter(Boolean);
		let current = root;
		for (let i = 0; i < segments.length - 1; i++) {
			const segment = segments[i];
			const existing = current.children.find(
				(c): c is BranchTreeFolder<T> => c.kind === 'folder' && c.name === segment
			);
			if (existing) {
				current = existing;
			} else {
				const folder: BranchTreeFolder<T> = { kind: 'folder', name: segment, children: [] };
				current.children.push(folder);
				current = folder;
			}
		}
		current.children.push({ kind: 'leaf', name: segments[segments.length - 1] ?? '', item });
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
