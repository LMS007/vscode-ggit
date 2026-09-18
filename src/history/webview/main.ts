import type { ChangedFile, CommitInfo } from '../../git/types';
import type { HostMessage, WebviewMessage } from '../protocol';

declare function acquireVsCodeApi(): { postMessage(message: WebviewMessage): void };

const vscodeApi = acquireVsCodeApi();

const commitsEl = document.getElementById('commits')!;
const filesEl = document.getElementById('files')!;

let currentFiles: ChangedFile[] = [];
let selectedSha: string | undefined;

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

function renderCommits(commits: CommitInfo[]): void {
	if (commits.length === 0) {
		commitsEl.innerHTML = '<div class="empty">No commits on this branch.</div>';
		return;
	}
	commitsEl.innerHTML = commits
		.map(
			c => `<div class="row" data-sha="${c.hash}">
				<span class="commit-hash">${c.hash.slice(0, 7)}</span>${escapeHtml(c.message)}
				<div class="commit-meta">${escapeHtml(c.authorName)} · ${new Date(c.date).toLocaleString()}</div>
			</div>`
		)
		.join('');
}

function highlightSelectedCommit(sha: string): void {
	commitsEl.querySelectorAll('.row').forEach(row => {
		row.classList.toggle('selected', row.getAttribute('data-sha') === sha);
	});
}

function renderFiles(files: ChangedFile[]): void {
	currentFiles = files;
	if (files.length === 0) {
		filesEl.innerHTML = '<div class="empty">No file changes in this commit.</div>';
		return;
	}
	filesEl.innerHTML = files
		.map(
			(f, i) =>
				`<div class="row" data-index="${i}">
					<span class="file-status status-${f.status}">${f.status}</span>${escapeHtml(f.path)}
				</div>`
		)
		.join('');
}

function selectCommit(sha: string): void {
	selectedSha = sha;
	highlightSelectedCommit(sha);
	filesEl.innerHTML = '<div class="empty">Loading files…</div>';
	vscodeApi.postMessage({ type: 'selectCommit', sha });
}

commitsEl.addEventListener('click', event => {
	const row = (event.target as HTMLElement).closest<HTMLElement>('.row[data-sha]');
	if (row) {
		selectCommit(row.dataset.sha!);
	}
});

filesEl.addEventListener('click', event => {
	const row = (event.target as HTMLElement).closest<HTMLElement>('.row[data-index]');
	if (row && selectedSha) {
		const file = currentFiles[Number(row.dataset.index)];
		vscodeApi.postMessage({ type: 'openDiff', sha: selectedSha, file });
	}
});

window.addEventListener('message', event => {
	const message = event.data as HostMessage;
	switch (message.type) {
		case 'commits':
			renderCommits(message.commits);
			if (message.commits.length > 0) {
				selectCommit(message.commits[0].hash);
			} else {
				filesEl.innerHTML = '<div class="empty">Select a commit to see its changed files.</div>';
			}
			break;
		case 'files':
			if (message.sha === selectedSha) {
				renderFiles(message.files);
			}
			break;
		case 'error':
			commitsEl.innerHTML = `<div class="empty">Error: ${escapeHtml(message.message)}</div>`;
			break;
	}
});

vscodeApi.postMessage({ type: 'ready' });
