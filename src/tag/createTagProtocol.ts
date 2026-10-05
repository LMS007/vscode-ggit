export interface CreateTagDialogState {
	branch: string;
	/** The branch's tip when the dialog opened -- what gets tagged, even if the branch moves meanwhile. */
	commit: string;
	subject: string;
	/** Names the webview checks against as you type -- a tag can't reuse either (see CreateTagPanel). */
	existingTags: string[];
	branchNames: string[];
}

export type CreateTagHostMessage = { type: 'init'; state: CreateTagDialogState } | { type: 'error'; message: string };

export type CreateTagWebviewMessage =
	| { type: 'ready' }
	/** An empty `message` makes a lightweight tag. */
	| { type: 'create'; name: string; message: string }
	| { type: 'cancel' };
