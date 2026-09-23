export type AddRemoteHostMessage = { type: 'error'; message: string };

export type AddRemoteWebviewMessage =
	| { type: 'ready' }
	| { type: 'add'; name: string; url: string }
	| { type: 'cancel' };
