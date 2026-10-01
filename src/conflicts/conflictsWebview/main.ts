import type { ConflictsHostMessage, ConflictsHostState, ConflictsWebviewMessage } from '../conflictsProtocol';

declare function acquireVsCodeApi(): { postMessage(message: ConflictsWebviewMessage): void };

const vscodeApi = acquireVsCodeApi();

const progressEl = document.getElementById('progress')!;
const hintEl = document.getElementById('hint')!;
const continueButton = document.getElementById('continueButton') as HTMLButtonElement;
const continueLabelEl = document.getElementById('continueLabel')!;
const skipButton = document.getElementById('skipButton') as HTMLButtonElement;
const abortButton = document.getElementById('abortButton') as HTMLButtonElement;
const abortLabelEl = document.getElementById('abortLabel')!;
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

function renderState(state: ConflictsHostState): void {
	const isMerge = state.operation === 'merge';
	if (isMerge) {
		const from = state.branchName ?? 'a branch';
		const into = state.intoBranch ?? 'the current branch';
		progressEl.textContent = `Merging ${from} into ${into}`;
		// The editor's own conflict markers and Accept buttons only ever say "Current" and "Incoming" --
		// for a merge that's HEAD and the branch coming in, respectively (a rebase flips them, which is
		// why this is merge-only).
		hintEl.textContent = state.totalFilesThisCommit > 0 ? `In each file, Current is ${into} and Incoming is ${from}.` : '';
	} else {
		progressEl.textContent =
			state.total > 0 ? `Commit ${state.current} of ${state.total}${state.subject ? `: ${state.subject}` : ''}` : '';
		hintEl.textContent = '';
	}

	const remaining = state.files.length;
	const resolvedCount = state.totalFilesThisCommit - remaining;
	stagedTextEl.textContent = state.totalFilesThisCommit > 0 ? `Staged files: ${resolvedCount} / ${state.totalFilesThisCommit}` : '';

	// The label change (Finish, on the last commit) and the color/enabled change (once every file in
	// *this* commit is staged) are two independent rules -- see conflictsPanel.ts's doc comment. A merge
	// is a single step, so it's always "the last one" -- green once everything's staged.
	const isLastStep = isMerge || (state.total > 0 && state.current >= state.total);
	continueLabelEl.textContent = isMerge ? 'Commit Merge' : isLastStep ? 'Finish Rebase' : 'Next Commit';
	continueButton.disabled = remaining > 0;
	continueButton.classList.toggle('toolbar-btn-primary', remaining === 0 && !isLastStep);
	continueButton.classList.toggle('toolbar-btn-success', remaining === 0 && isLastStep);
	skipButton.hidden = isMerge;
	abortLabelEl.textContent = isMerge ? 'Abort Merge' : 'Abort Rebase';

	if (state.files.length === 0) {
		filesEl.innerHTML = isMerge
			? state.totalFilesThisCommit > 0
				? '<div class="empty">Every file is resolved -- click Commit Merge to finish.</div>'
				: // A --no-commit merge that went through cleanly -- nothing to resolve, just not committed yet.
					'<div class="empty">No conflicts -- the merged changes are staged. Review them in Working Copy, then click Commit Merge, or commit from the Commit tab to write your own message.</div>'
			: '<div class="empty">Every file is resolved -- click Next Commit / Finish Rebase to continue.</div>';
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
	const message = event.data as ConflictsHostMessage;
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
