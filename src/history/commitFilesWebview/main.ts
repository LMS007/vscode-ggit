import type { ChangedFile } from '../../git/types';
import type { CommitFilesHostMessage, CommitFilesWebviewMessage } from '../commitFilesProtocol';

declare function acquireVsCodeApi(): { postMessage(message: CommitFilesWebviewMessage): void };

const vscodeApi = acquireVsCodeApi();

const headerEl = document.getElementById('header')!;
const filesEl = document.getElementById('files')!;

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

function renderFileStats(f: ChangedFile): string {
	if (f.binary) {
		return '<span class="stat-binary">bin</span>';
	}
	if (f.insertions === undefined || f.deletions === undefined) {
		return '';
	}
	const parts: string[] = [];
	if (f.insertions > 0) {
		parts.push(`<span class="stat-add">+${f.insertions}</span>`);
	}
	if (f.deletions > 0) {
		parts.push(`<span class="stat-del">-${f.deletions}</span>`);
	}
	return parts.join('');
}

let currentFiles: ChangedFile[] = [];
let selectedIndex = -1;

function render(message: CommitFilesHostMessage): void {
	headerEl.textContent = `${message.sha.slice(0, 7)} ${message.commitMessage}`;
	currentFiles = message.files;
	selectedIndex = message.selectedIndex;

	if (message.files.length === 0) {
		filesEl.innerHTML = '<div class="empty">No file changes in this commit.</div>';
		return;
	}

	filesEl.innerHTML = message.files
		.map(
			(f, i) =>
				`<div class="row file-row${i === message.selectedIndex ? ' selected' : ''}" data-index="${i}">
					<span class="file-status status-${f.status}">${f.status}</span>
					<span class="file-name">${escapeHtml(f.path)}</span>
					<span class="file-stats">${renderFileStats(f)}</span>
				</div>`
		)
		.join('');
}

function selectFile(index: number): void {
	selectedIndex = index;
	filesEl.querySelectorAll('.row').forEach(row => {
		row.classList.toggle('selected', Number((row as HTMLElement).dataset.index) === index);
	});
	filesEl.querySelector<HTMLElement>(`.row[data-index="${index}"]`)?.scrollIntoView({ block: 'nearest' });
	vscodeApi.postMessage({ type: 'selectFile', index });
}

function selectFileByOffset(offset: number): void {
	if (currentFiles.length === 0) {
		return;
	}
	const nextIndex = Math.min(currentFiles.length - 1, Math.max(0, (selectedIndex === -1 ? 0 : selectedIndex) + offset));
	if (nextIndex !== selectedIndex) {
		selectFile(nextIndex);
	}
}

filesEl.addEventListener('click', event => {
	const row = (event.target as HTMLElement).closest<HTMLElement>('.row[data-index]');
	if (row) {
		selectFile(Number(row.dataset.index));
	}
});

window.addEventListener('keydown', event => {
	if (event.key === 'ArrowDown') {
		event.preventDefault();
		selectFileByOffset(1);
	} else if (event.key === 'ArrowUp') {
		event.preventDefault();
		selectFileByOffset(-1);
	}
});

window.addEventListener('message', event => {
	const message = event.data as CommitFilesHostMessage;
	if (message.type === 'files') {
		render(message);
	}
});

vscodeApi.postMessage({ type: 'ready' });
