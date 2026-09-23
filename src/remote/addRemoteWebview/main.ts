import type { AddRemoteHostMessage, AddRemoteWebviewMessage } from '../addRemoteProtocol';

declare function acquireVsCodeApi(): { postMessage(message: AddRemoteWebviewMessage): void };

const vscodeApi = acquireVsCodeApi();

const nameInput = document.getElementById('name') as HTMLInputElement;
const urlInput = document.getElementById('url') as HTMLInputElement;
const errorEl = document.getElementById('error')!;
const addButton = document.getElementById('addButton') as HTMLButtonElement;
const cancelButton = document.getElementById('cancelButton') as HTMLButtonElement;

function updateAddEnabled(): void {
	addButton.disabled = nameInput.value.trim().length === 0 || urlInput.value.trim().length === 0;
}

function submit(): void {
	const name = nameInput.value.trim();
	const url = urlInput.value.trim();
	if (!name || !url) {
		return;
	}
	errorEl.textContent = '';
	vscodeApi.postMessage({ type: 'add', name, url });
}

nameInput.addEventListener('input', updateAddEnabled);
urlInput.addEventListener('input', updateAddEnabled);

for (const input of [nameInput, urlInput]) {
	input.addEventListener('keydown', event => {
		if (event.key === 'Enter' && !addButton.disabled) {
			submit();
		}
	});
}

addButton.addEventListener('click', submit);
cancelButton.addEventListener('click', () => vscodeApi.postMessage({ type: 'cancel' }));

window.addEventListener('keydown', event => {
	if (event.key === 'Escape') {
		vscodeApi.postMessage({ type: 'cancel' });
	}
});

window.addEventListener('message', event => {
	const message = event.data as AddRemoteHostMessage;
	if (message.type === 'error') {
		errorEl.textContent = message.message;
	}
});

updateAddEnabled();
nameInput.focus();
vscodeApi.postMessage({ type: 'ready' });
