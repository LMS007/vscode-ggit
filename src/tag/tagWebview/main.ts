import type { TagDialogRemote, TagDialogState, TagHostMessage, TagWebviewMessage } from '../tagProtocol';

declare function acquireVsCodeApi(): { postMessage(message: TagWebviewMessage): void };

const vscodeApi = acquireVsCodeApi();

const titleEl = document.getElementById('title')!;
const subtitleEl = document.getElementById('subtitle')!;
const tagNameTextEl = document.getElementById('tagNameText')!;
const tagDetailEl = document.getElementById('tagDetail')!;
const warningEl = document.getElementById('warning')!;
const warningTextEl = document.getElementById('warningText')!;
const deleteRemoteField = document.getElementById('deleteRemoteField')!;
const deleteRemoteCheckbox = document.getElementById('deleteRemote') as HTMLInputElement;
const deleteRemoteLabelEl = document.getElementById('deleteRemoteLabel')!;
const deleteRemoteDescEl = document.getElementById('deleteRemoteDesc')!;
const remoteField = document.getElementById('remoteField')!;
const remoteSelect = document.getElementById('remote') as HTMLSelectElement;
const allRemotesField = document.getElementById('allRemotesField')!;
const allRemotesCheckbox = document.getElementById('allRemotes') as HTMLInputElement;
const allRemotesDescEl = document.getElementById('allRemotesDesc')!;
const noteEl = document.getElementById('note')!;
const errorEl = document.getElementById('error')!;
const submitButton = document.getElementById('submitButton') as HTMLButtonElement;
const cancelButton = document.getElementById('cancelButton') as HTMLButtonElement;

let state: TagDialogState | undefined;

const SUBMIT_LABELS = { publish: 'Publish', push: 'Overwrite Remote Tag', delete: 'Delete Tag' };

function short(sha: string): string {
	return sha.slice(0, 7);
}

function selectedRemote(): TagDialogRemote | undefined {
	return state?.remotes.find(r => r.name === remoteSelect.value);
}

/** Delete with a local tag makes the remote half optional (the checkbox); everything else that
 * offers remotes needs one. */
function usesRemote(): boolean {
	if (!state || state.remotes.length === 0) {
		return false;
	}
	return state.mode !== 'delete' || !state.local || deleteRemoteCheckbox.checked;
}

/** Delete from every offered remote instead of the picked one -- only offered with 2+ of them. */
function deletingFromAll(): boolean {
	return usesRemote() && !allRemotesField.hidden && allRemotesCheckbox.checked;
}

/** Everything that depends on which remote is picked (or whether one is) -- re-run on every change. */
function render(): void {
	if (!state) {
		return;
	}
	const { mode, tagName, local } = state;
	const remote = selectedRemote();
	remoteSelect.disabled = !usesRemote() || deletingFromAll();
	allRemotesCheckbox.disabled = !usesRemote();

	warningEl.hidden = true;
	noteEl.textContent = '';
	if (mode === 'push' && remote?.commit && local) {
		warningEl.hidden = false;
		warningTextEl.textContent =
			(remote.commit === local.commit
				? `${remote.name} has its own "${tagName}" on the same commit, but it's a different tag (re-created, or with a different message).`
				: `${remote.name}'s "${tagName}" points at ${short(remote.commit)}; yours points at ${short(local.commit)}.`) +
			` Pushing overwrites the remote's tag (a force push). Anyone who already fetched the old one keeps it until they delete it and fetch again.`;
	}
	if (deletingFromAll()) {
		const unknown = state.remotes.filter(r => !r.known).map(r => r.name);
		if (unknown.length > 0) {
			noteEl.textContent = `Couldn't check whether ${unknown.join(', ')} ${unknown.length === 1 ? 'has' : 'have'} this tag. GGit tries anyway.`;
		}
	} else if (usesRemote() && remote && !remote.known) {
		noteEl.textContent =
			mode === 'publish'
				? `Couldn't check whether ${remote.name} already has this tag. If it does, git refuses rather than overwriting it.`
				: `Couldn't check whether ${remote.name} has this tag.`;
	}
	if (mode !== 'delete' && state.remotes.length === 0) {
		noteEl.textContent = mode === 'publish' ? 'Every remote already has this tag.' : 'No remote has a different copy of this tag.';
	}
	submitButton.disabled = mode !== 'delete' ? !remote : !local && !remote;
}

function renderInit(next: TagDialogState): void {
	state = next;
	const { mode, tagName, local, remotes } = next;
	titleEl.textContent = mode === 'publish' ? 'Publish Tag' : mode === 'push' ? 'Push Tag' : 'Delete Tag';
	tagNameTextEl.textContent = tagName;
	tagDetailEl.innerHTML = '';
	if (local) {
		const sha = document.createElement('span');
		sha.className = 'sha';
		sha.textContent = short(local.commit);
		tagDetailEl.append(sha, ` ${local.subject}`);
	} else {
		tagDetailEl.textContent = `Only on ${remotes.map(r => r.name).join(', ')}`;
	}

	if (mode === 'publish') {
		subtitleEl.textContent = 'Sends this tag to a remote, so anyone who fetches from it gets the tag too.';
	} else if (mode === 'push') {
		subtitleEl.textContent = 'Updates a tag that a remote already has, to match your local one.';
	} else if (local) {
		subtitleEl.textContent = "Deletes the local tag. The commit it points at isn't affected.";
	} else {
		subtitleEl.textContent = 'This tag only exists on a remote. Deleting it there removes it for everyone who fetches from it.';
	}

	// Delete's remote half is an opt-in checkbox when there's a local tag to delete anyway; with no
	// remote to offer at all (none configured, or none has it) only the local delete applies.
	deleteRemoteField.hidden = mode !== 'delete' || !local || remotes.length === 0;
	deleteRemoteCheckbox.checked = false;
	deleteRemoteLabelEl.textContent = 'Also delete from remote';
	deleteRemoteDescEl.textContent =
		'Removes it from the remote too, for everyone who fetches from it. Anyone who already fetched it keeps their own copy.';

	remoteField.hidden = remotes.length === 0;
	// Pointless with a single remote to choose from -- the dropdown already is "all of them".
	allRemotesField.hidden = mode !== 'delete' || remotes.length < 2;
	allRemotesCheckbox.checked = false;
	allRemotesDescEl.textContent = `Deletes it from ${remotes.map(r => r.name).join(', ')}.`;
	remoteSelect.innerHTML = '';
	for (const r of remotes) {
		const option = document.createElement('option');
		option.value = r.name;
		option.textContent = r.name;
		remoteSelect.append(option);
	}
	const preferred = remotes.find(r => r.name === 'origin') ?? remotes[0];
	if (preferred) {
		remoteSelect.value = preferred.name;
	}

	errorEl.textContent = '';
	submitButton.textContent = SUBMIT_LABELS[mode];
	render();
	submitButton.focus();
}

function submit(): void {
	if (!state || submitButton.disabled) {
		return;
	}
	errorEl.textContent = '';
	submitButton.disabled = true;
	vscodeApi.postMessage({ type: 'submit', remote: usesRemote() ? remoteSelect.value : undefined, allRemotes: deletingFromAll() });
}

deleteRemoteCheckbox.addEventListener('change', render);
allRemotesCheckbox.addEventListener('change', render);
remoteSelect.addEventListener('change', render);
submitButton.addEventListener('click', submit);
cancelButton.addEventListener('click', () => vscodeApi.postMessage({ type: 'cancel' }));

window.addEventListener('keydown', event => {
	if (event.key === 'Escape') {
		vscodeApi.postMessage({ type: 'cancel' });
	}
});

window.addEventListener('message', event => {
	const message = event.data as TagHostMessage;
	switch (message.type) {
		case 'init':
			renderInit(message.state);
			break;
		case 'error':
			errorEl.textContent = message.message;
			render();
			break;
	}
});

vscodeApi.postMessage({ type: 'ready' });
