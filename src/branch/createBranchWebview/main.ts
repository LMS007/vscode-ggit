import type { CreateBranchHostMessage, CreateBranchWebviewMessage } from '../createBranchProtocol';

declare function acquireVsCodeApi(): { postMessage(message: CreateBranchWebviewMessage): void };

const vscodeApi = acquireVsCodeApi();

const nameInput = document.getElementById('name') as HTMLInputElement;
const startPointSelect = document.getElementById('startPoint') as HTMLSelectElement;
const trackCheckbox = document.getElementById('track') as HTMLInputElement;
const checkoutCheckbox = document.getElementById('checkout') as HTMLInputElement;
const errorEl = document.getElementById('error')!;
const createButton = document.getElementById('createButton') as HTMLButtonElement;
const cancelButton = document.getElementById('cancelButton') as HTMLButtonElement;

function updateCreateEnabled(): void {
	createButton.disabled = nameInput.value.trim().length === 0;
}

function submit(): void {
	const name = nameInput.value.trim();
	if (!name) {
		return;
	}
	errorEl.textContent = '';
	vscodeApi.postMessage({
		type: 'create',
		name,
		startPoint: startPointSelect.value,
		track: trackCheckbox.checked,
		checkout: checkoutCheckbox.checked,
	});
}

function renderBranches(branches: string[], currentBranch: string): void {
	startPointSelect.innerHTML = '';
	for (const branch of branches) {
		const option = document.createElement('option');
		option.value = branch;
		option.textContent = branch;
		if (branch === currentBranch) {
			option.selected = true;
		}
		startPointSelect.appendChild(option);
	}
}

nameInput.addEventListener('input', updateCreateEnabled);
nameInput.addEventListener('keydown', event => {
	if (event.key === 'Enter') {
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
	const message = event.data as CreateBranchHostMessage;
	switch (message.type) {
		case 'init':
			renderBranches(message.branches, message.currentBranch);
			nameInput.focus();
			break;
		case 'error':
			errorEl.textContent = message.message;
			break;
	}
});

updateCreateEnabled();
vscodeApi.postMessage({ type: 'ready' });
