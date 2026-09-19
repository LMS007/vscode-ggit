import type { ChangedFile, CommitInfo } from '../../git/types';
import type { HostMessage, WebviewMessage } from '../protocol';

declare function acquireVsCodeApi(): {
	postMessage(message: WebviewMessage): void;
	getState(): unknown;
	setState(state: unknown): void;
};

const vscodeApi = acquireVsCodeApi();

const layoutEl = document.getElementById('layout')!;
const commitsEl = document.getElementById('commits')!;
const filesEl = document.getElementById('files')!;
const splitterEl = document.getElementById('splitter')!;

let currentFiles: ChangedFile[] = [];
let currentCommits: CommitInfo[] = [];
let selectedSha: string | undefined;

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

function renderRefBadges(refs: CommitInfo['refs']): string {
	return refs.map(r => `<span class="ref-badge ref-badge-${r.kind}">${escapeHtml(r.name)}</span>`).join('');
}

function renderCommits(commits: CommitInfo[]): void {
	currentCommits = commits;
	if (commits.length === 0) {
		commitsEl.innerHTML = '<div class="empty">No commits on this branch.</div>';
		return;
	}
	commitsEl.innerHTML = commits
		.map(
			c => `<div class="commit-row-wrapper">
				<div class="commit-graph">
					<div class="commit-graph-line"></div>
					<div class="commit-graph-dot"></div>
				</div>
				<div class="row commit-row" data-sha="${c.hash}">
					<div class="commit-line1">
						<span class="commit-author">${escapeHtml(c.authorName)}</span>
						<span class="commit-refs">${renderRefBadges(c.refs)}</span>
						<span class="commit-date">${new Date(c.date).toLocaleDateString()}</span>
					</div>
					<div class="commit-line2">
						<span class="commit-hash">${c.hash.slice(0, 7)}</span>
						<span class="commit-title">${escapeHtml(c.message)}</span>
					</div>
				</div>
			</div>`
		)
		.join('');
}

function highlightSelectedCommit(sha: string): void {
	commitsEl.querySelectorAll('.row').forEach(row => {
		row.classList.toggle('selected', row.getAttribute('data-sha') === sha);
	});
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

function renderFiles(files: ChangedFile[]): void {
	currentFiles = files;
	if (files.length === 0) {
		filesEl.innerHTML = '<div class="empty">No file changes in this commit.</div>';
		return;
	}
	filesEl.innerHTML = files
		.map(
			(f, i) =>
				`<div class="row file-row" data-index="${i}">
					<span class="file-status status-${f.status}">${f.status}</span>
					<span class="file-name">${escapeHtml(f.path)}</span>
					<span class="file-stats">${renderFileStats(f)}</span>
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

function selectCommitByOffset(offset: number): void {
	if (currentCommits.length === 0) {
		return;
	}
	const currentIndex = currentCommits.findIndex(c => c.hash === selectedSha);
	const nextIndex = Math.min(
		currentCommits.length - 1,
		Math.max(0, (currentIndex === -1 ? 0 : currentIndex) + offset)
	);
	const next = currentCommits[nextIndex];
	if (next.hash === selectedSha) {
		return;
	}
	selectCommit(next.hash);
	commitsEl.querySelector<HTMLElement>(`.row[data-sha="${next.hash}"]`)?.scrollIntoView({ block: 'nearest' });
}

window.addEventListener('keydown', event => {
	if (event.key === 'ArrowDown') {
		event.preventDefault();
		selectCommitByOffset(1);
	} else if (event.key === 'ArrowUp') {
		event.preventDefault();
		selectCommitByOffset(-1);
	}
});

filesEl.addEventListener('click', event => {
	const row = (event.target as HTMLElement).closest<HTMLElement>('.row[data-index]');
	if (row && selectedSha) {
		vscodeApi.postMessage({ type: 'openDiff', sha: selectedSha, files: currentFiles });
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

const MIN_PANE_WIDTH_PX = 120;
let dragging = false;

function applySplit(commitsPercent: number): void {
	commitsEl.style.flexBasis = `${commitsPercent}%`;
}

function restoreSplit(): void {
	const state = vscodeApi.getState() as { commitsPercent?: number } | undefined;
	applySplit(state?.commitsPercent ?? 60);
}

splitterEl.addEventListener('pointerdown', event => {
	dragging = true;
	splitterEl.setPointerCapture(event.pointerId);
	splitterEl.classList.add('dragging');
	document.body.style.userSelect = 'none';
});

splitterEl.addEventListener('pointermove', event => {
	if (!dragging) {
		return;
	}
	const rect = layoutEl.getBoundingClientRect();
	const minPercent = (MIN_PANE_WIDTH_PX / rect.width) * 100;
	const rawPercent = ((event.clientX - rect.left) / rect.width) * 100;
	const percent = Math.min(100 - minPercent, Math.max(minPercent, rawPercent));
	applySplit(percent);
});

function endDrag(): void {
	if (!dragging) {
		return;
	}
	dragging = false;
	splitterEl.classList.remove('dragging');
	document.body.style.userSelect = '';
	const rect = layoutEl.getBoundingClientRect();
	const commitsPercent = (commitsEl.getBoundingClientRect().width / rect.width) * 100;
	vscodeApi.setState({ commitsPercent });
}

splitterEl.addEventListener('pointerup', endDrag);
splitterEl.addEventListener('pointercancel', endDrag);

restoreSplit();

vscodeApi.postMessage({ type: 'ready' });
