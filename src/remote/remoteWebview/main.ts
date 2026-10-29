import type { RemoteHostMessage, RemoteWebviewMessage } from '../remoteProtocol';

declare function acquireVsCodeApi(): { postMessage(message: RemoteWebviewMessage): void };

const vscodeApi = acquireVsCodeApi();

const nameInput = document.getElementById('name') as HTMLInputElement;
const urlInput = document.getElementById('url') as HTMLInputElement;
// Only rendered in edit mode -- see RemotePanel.getHtml.
const pushUrlInput = document.getElementById('pushUrl') as HTMLInputElement | null;
const errorEl = document.getElementById('error')!;
const submitButton = document.getElementById('submitButton') as HTMLButtonElement;
const cancelButton = document.getElementById('cancelButton') as HTMLButtonElement;

function updateSubmitEnabled(): void {
	submitButton.disabled = nameInput.value.trim().length === 0 || urlInput.value.trim().length === 0;
}

function submit(): void {
	const name = nameInput.value.trim();
	const url = urlInput.value.trim();
	if (!name || !url) {
		return;
	}
	errorEl.textContent = '';
	vscodeApi.postMessage({ type: 'submit', state: { name, url, pushUrl: pushUrlInput?.value.trim() ?? '' } });
}

const inputs = [nameInput, urlInput, ...(pushUrlInput ? [pushUrlInput] : [])];
for (const input of inputs) {
	input.addEventListener('input', updateSubmitEnabled);
	input.addEventListener('keydown', event => {
		if (event.key === 'Enter' && !submitButton.disabled) {
			submit();
		}
	});
}

submitButton.addEventListener('click', submit);
cancelButton.addEventListener('click', () => vscodeApi.postMessage({ type: 'cancel' }));

window.addEventListener('keydown', event => {
	if (event.key === 'Escape') {
		vscodeApi.postMessage({ type: 'cancel' });
	}
});

window.addEventListener('message', event => {
	const message = event.data as RemoteHostMessage;
	if (message.type === 'init') {
		nameInput.value = message.state.name;
		urlInput.value = message.state.url;
		if (pushUrlInput) {
			pushUrlInput.value = message.state.pushUrl;
		}
		updateSubmitEnabled();
	} else if (message.type === 'error') {
		errorEl.textContent = message.message;
	}
});

updateSubmitEnabled();
nameInput.focus();
vscodeApi.postMessage({ type: 'ready' });
