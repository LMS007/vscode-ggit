import type { RebaseHostMessage, RebaseHostState, RebaseWebviewMessage } from '../rebaseProtocol';

declare function acquireVsCodeApi(): { postMessage(message: RebaseWebviewMessage): void };

const vscodeApi = acquireVsCodeApi();

const progressEl = document.getElementById('progress')!;
const continueButton = document.getElementById('continueButton') as HTMLButtonElement;
const continueLabelEl = document.getElementById('continueLabel')!;
const skipButton = document.getElementById('skipButton') as HTMLButtonElement;
const abortButton = document.getElementById('abortButton') as HTMLButtonElement;
const stagedTextEl = document.getElementById('stagedText')!;
const errorEl = document.getElementById('error')!;
const filesEl = document.getElementById('files')!;

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

function renderState(state: RebaseHostState): void {
	progressEl.textContent =
		state.total > 0 ? `Commit ${state.current} of ${state.total}${state.subject ? `: ${state.subject}` : ''}` : '';

	const remaining = state.files.length;
	const resolvedCount = state.totalFilesThisCommit - remaining;
	stagedTextEl.textContent = `Staged files: ${resolvedCount} / ${state.totalFilesThisCommit}`;

	// The label change (Finish, on the last commit) and the color/enabled change (once every file in
	// *this* commit is staged) are two independent rules -- see rebaseConflictsPanel.ts's doc comment.
	const isLastCommit = state.total > 0 && state.current >= state.total;
	continueLabelEl.textContent = isLastCommit ? 'Finish Rebase' : 'Next Commit';
	continueButton.disabled = remaining > 0;
	continueButton.classList.toggle('toolbar-btn-primary', remaining === 0 && !isLastCommit);
	continueButton.classList.toggle('toolbar-btn-success', remaining === 0 && isLastCommit);

	if (state.files.length === 0) {
		filesEl.innerHTML = '<div class="empty">Every file is resolved -- click Next Commit / Finish Rebase to continue.</div>';
		return;
	}
	filesEl.innerHTML = state.files
		.map(
			f =>
				`<div class="file-row" data-path="${escapeHtml(f.path)}">` +
				`<input type="checkbox" class="file-checkbox" data-path="${escapeHtml(f.path)}" />` +
				`<span class="file-name">${escapeHtml(f.path)}</span></div>`
		)
		.join('');
}

// Delegated rather than attached per-row, since renderState rebuilds #files' innerHTML wholesale on
// every refresh.
filesEl.addEventListener('click', event => {
	const target = event.target as HTMLElement;
	// The checkbox's own 'change' listener below handles a check -- this listener is only for opening
	// the file, so a click landing directly on the checkbox itself must not also open it.
	if (target instanceof HTMLInputElement) {
		return;
	}
	const row = target.closest<HTMLElement>('.file-row[data-path]');
	if (row) {
		vscodeApi.postMessage({ type: 'openFile', path: row.dataset.path! });
	}
});

filesEl.addEventListener('change', event => {
	const checkbox = event.target as HTMLElement;
	if (!(checkbox instanceof HTMLInputElement) || !checkbox.classList.contains('file-checkbox')) {
		return;
	}
	// No "unresolve" affordance -- a row's box always starts unchecked (see renderState), and the row
	// disappears on its own once the next 'state' message no longer lists it, so unchecking isn't a
	// state this list can actually be in.
	if (checkbox.checked) {
		vscodeApi.postMessage({ type: 'setResolved', path: checkbox.dataset.path! });
	}
});

continueButton.addEventListener('click', () => vscodeApi.postMessage({ type: 'continue' }));
skipButton.addEventListener('click', () => vscodeApi.postMessage({ type: 'skip' }));
abortButton.addEventListener('click', () => vscodeApi.postMessage({ type: 'abort' }));

window.addEventListener('message', event => {
	const message = event.data as RebaseHostMessage;
	switch (message.type) {
		case 'state':
			errorEl.textContent = '';
			renderState(message.state);
			break;
		case 'error':
			errorEl.textContent = message.message;
			break;
	}
});

vscodeApi.postMessage({ type: 'ready' });
