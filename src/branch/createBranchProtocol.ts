export type CreateBranchHostMessage =
	| { type: 'init'; branches: string[]; currentBranch: string }
	| { type: 'error'; message: string };

export type CreateBranchWebviewMessage =
	| { type: 'ready' }
	| { type: 'create'; name: string; startPoint: string; track: boolean; checkout: boolean }
	| { type: 'cancel' };
