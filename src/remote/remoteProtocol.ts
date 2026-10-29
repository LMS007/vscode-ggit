export interface RemoteDialogState {
	name: string;
	url: string;
	/** Empty unless a separate push URL is configured -- pushes then go to `url`. */
	pushUrl: string;
}

export type RemoteHostMessage = { type: 'init'; state: RemoteDialogState } | { type: 'error'; message: string };

export type RemoteWebviewMessage =
	| { type: 'ready' }
	| { type: 'submit'; state: RemoteDialogState }
	| { type: 'cancel' };
