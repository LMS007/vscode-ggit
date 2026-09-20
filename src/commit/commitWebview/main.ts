import type { CommitHostMessage, CommitStagedFile, CommitWebviewMessage } from '../commitProtocol';

declare function acquireVsCodeApi(): { postMessage(message: CommitWebviewMessage): void };

const vscodeApi = acquireVsCodeApi();

const subjectInput = document.getElementById('subject') as HTMLInputElement;
const bodyTextarea = document.getElementById('body') as HTMLTextAreaElement;
const amendCheckbox = document.getElementById('amend') as HTMLInputElement;
const errorEl = document.getElementById('error')!;
const commitButton = document.getElementById('commitButton') as HTMLButtonElement;
const statsEl = document.getElementById('stats')!;
const filesEl = document.getElementById('files')!;
const subtitleEl = document.getElementById('subtitle')!;
const checkAllButton = document.getElementById('checkAllButton') as HTMLButtonElement;
const uncheckAllButton = document.getElementById('uncheckAllButton') as HTMLButtonElement;

let lastCommitSubject = '';
let lastCommitBody = '';
// What the user actually typed before checking Amend — restored if they uncheck it again, so toggling
// Amend on and back off doesn't lose an in-progress message.
let draftSubject = '';
let draftBody = '';
let stagedCount = 0;

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

function updateCommitEnabled(): void {
	const hasSubject = subjectInput.value.trim().length > 0;
	// Amending is still valid with nothing staged (e.g. just fixing up the last commit's message), so
	// that case skips the "must have something staged" requirement — everything else needs it, same as
	// git itself rejecting a plain commit with an empty index.
	const hasSomethingToCommit = stagedCount > 0 || amendCheckbox.checked;
	commitButton.disabled = !hasSubject || !hasSomethingToCommit;
}

function renderStaged(files: CommitStagedFile[], insertions: number, deletions: number): void {
	const stagedFileCount = files.filter(f => f.staged).length;
	statsEl.innerHTML =
		stagedFileCount === 0
			? 'Nothing staged'
			: `${stagedFileCount} file${stagedFileCount === 1 ? '' : 's'} staged &middot; ` +
				`<span class="stat-add">+${insertions}</span><span class="stat-del">-${deletions}</span>`;

	filesEl.innerHTML = files
		.map(
			f =>
				`<div class="file-row">` +
				`<input type="checkbox" class="file-checkbox" data-path="${escapeHtml(f.path)}"${f.staged ? ' checked' : ''} />` +
				`<span class="file-status status-${f.status}">${f.status}</span>` +
				`<span class="file-name">${escapeHtml(f.path)}</span></div>`
		)
		.join('');
}

function submit(): void {
	const subject = subjectInput.value.trim();
	if (!subject) {
		return;
	}
	errorEl.textContent = '';
	commitButton.disabled = true;
	vscodeApi.postMessage({ type: 'commit', subject, body: bodyTextarea.value.trim(), amend: amendCheckbox.checked });
}

amendCheckbox.addEventListener('change', () => {
	if (amendCheckbox.checked) {
		draftSubject = subjectInput.value;
		draftBody = bodyTextarea.value;
		subjectInput.value = lastCommitSubject;
		bodyTextarea.value = lastCommitBody;
	} else {
		subjectInput.value = draftSubject;
		bodyTextarea.value = draftBody;
	}
	updateCommitEnabled();
});

subjectInput.addEventListener('input', updateCommitEnabled);
commitButton.addEventListener('click', submit);

// Delegated rather than attached per-row, since renderStaged rebuilds #files' innerHTML wholesale on
// every refresh (a fresh set of checkboxes each time, not the same elements with updated properties).
filesEl.addEventListener('change', event => {
	const checkbox = event.target as HTMLElement;
	if (!(checkbox instanceof HTMLInputElement) || !checkbox.classList.contains('file-checkbox')) {
		return;
	}
	vscodeApi.postMessage({ type: 'setStaged', path: checkbox.dataset.path!, staged: checkbox.checked });
});

checkAllButton.addEventListener('click', () => vscodeApi.postMessage({ type: 'setAllStaged', staged: true }));
uncheckAllButton.addEventListener('click', () => vscodeApi.postMessage({ type: 'setAllStaged', staged: false }));

window.addEventListener('message', event => {
	const message = event.data as CommitHostMessage;
	switch (message.type) {
		case 'staged':
			lastCommitSubject = message.lastCommitSubject;
			lastCommitBody = message.lastCommitBody;
			stagedCount = message.files.filter(f => f.staged).length;
			subtitleEl.textContent = message.branch ?? '(detached HEAD)';
			amendCheckbox.disabled = !message.hasHead;
			if (amendCheckbox.checked) {
				subjectInput.value = lastCommitSubject;
				bodyTextarea.value = lastCommitBody;
			}
			renderStaged(message.files, message.insertions, message.deletions);
			updateCommitEnabled();
			break;
		case 'committed':
			subjectInput.value = '';
			bodyTextarea.value = '';
			amendCheckbox.checked = false;
			draftSubject = '';
			draftBody = '';
			subjectInput.focus();
			break;
		case 'error':
			errorEl.textContent = message.message;
			commitButton.disabled = false;
			break;
	}
});

updateCommitEnabled();
vscodeApi.postMessage({ type: 'ready' });
