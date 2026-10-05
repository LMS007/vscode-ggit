export type TagDialogMode = 'publish' | 'push' | 'delete';

export interface TagDialogRemote {
	name: string;
	/** False when that remote couldn't be checked -- `commit` is then unknown, not "doesn't have it". */
	known: boolean;
	/** The commit the remote's copy of the tag points at, if it has one. */
	commit: string | undefined;
}

export interface TagDialogState {
	mode: TagDialogMode;
	tagName: string;
	/** Undefined for a tag that only exists on a remote (delete mode only). */
	local: { commit: string; subject: string } | undefined;
	/** The remotes this action can target, already narrowed to the ones it makes sense for -- see
	 * TagPanel.offeredRemotes. Empty hides the remote picker. */
	remotes: TagDialogRemote[];
}

export type TagHostMessage = { type: 'init'; state: TagDialogState } | { type: 'error'; message: string };

export type TagWebviewMessage =
	| { type: 'ready' }
	/** `remote` is undefined for a delete that's local-only. */
	| { type: 'submit'; remote: string | undefined }
	| { type: 'cancel' };
