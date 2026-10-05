import type { CreateTagDialogState, CreateTagHostMessage, CreateTagWebviewMessage } from '../createTagProtocol';

declare function acquireVsCodeApi(): { postMessage(message: CreateTagWebviewMessage): void };

const vscodeApi = acquireVsCodeApi();

const branchEl = document.getElementById('branch')!;
const commitShaEl = document.getElementById('commitSha')!;
const commitSubjectEl = document.getElementById('commitSubject')!;
const nameInput = document.getElementById('name') as HTMLInputElement;
const nameProblemEl = document.getElementById('nameProblem')!;
const messageInput = document.getElementById('message') as HTMLTextAreaElement;
const errorEl = document.getElementById('error')!;
const createButton = document.getElementById('createButton') as HTMLButtonElement;
const cancelButton = document.getElementById('cancelButton') as HTMLButtonElement;

let state: CreateTagDialogState | undefined;
let submitting = false;

/** The problems worth catching while typing -- anything subtler about what makes a valid ref name
 * (no "..", no trailing ".lock", ...) is left to git, whose own error shows up below on Create. */
function nameProblem(name: string): string {
	if (!state || !name) {
		return '';
	}
	if (/\s/.test(name)) {
		return "Tag names can't contain spaces.";
	}
	if (state.existingTags.includes(name)) {
		return `A tag named "${name}" already exists.`;
	}
	if (state.branchNames.includes(name)) {
		return `There's already a branch named "${name}". Pick a different name so the two don't get mixed up.`;
	}
	return '';
}

function render(): void {
	const name = nameInput.value.trim();
	const problem = nameProblem(name);
	nameProblemEl.textContent = problem;
	createButton.disabled = !state || submitting || !name || problem !== '';
}

function submit(): void {
	if (createButton.disabled) {
		return;
	}
	errorEl.textContent = '';
	submitting = true;
	render();
	vscodeApi.postMessage({ type: 'create', name: nameInput.value.trim(), message: messageInput.value });
}

nameInput.addEventListener('input', render);
nameInput.addEventListener('keydown', event => {
	if (event.key === 'Enter') {
		submit();
	}
});
// Plain Enter is a newline in the message; Cmd/Ctrl+Enter submits, same as the Commit tab.
messageInput.addEventListener('keydown', event => {
	if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
		event.preventDefault();
		submit();
	}
});
createButton.addEventListener('click', submit);
cancelButton.addEventListener('click', () => vscodeApi.postMessage({ type: 'cancel' }));

window.addEventListener('keydown', event => {
	if (event.key === 'Escape') {
		vscodeApi.postMessage({ type: 'cancel' });
	}
});

window.addEventListener('message', event => {
	const message = event.data as CreateTagHostMessage;
	switch (message.type) {
		case 'init':
			state = message.state;
			branchEl.textContent = state.branch;
			commitShaEl.textContent = state.commit.slice(0, 7);
			commitSubjectEl.textContent = state.subject;
			commitSubjectEl.title = state.subject;
			errorEl.textContent = '';
			submitting = false;
			render();
			nameInput.focus();
			break;
		case 'error':
			errorEl.textContent = message.message;
			submitting = false;
			render();
			break;
	}
});

render();
vscodeApi.postMessage({ type: 'ready' });
