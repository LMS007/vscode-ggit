import type { ChangedFile, CommitInfo } from '../../git/types';
import type { HostMessage, WebviewMessage } from '../protocol';

declare function acquireVsCodeApi(): {
	postMessage(message: WebviewMessage): void;
};

const vscodeApi = acquireVsCodeApi();

const layoutEl = document.getElementById('layout')!;
const commitsEl = document.getElementById('commits')!;
const filesEl = document.getElementById('files')!;
const splitterEl = document.getElementById('splitter')!;
const toolbarEl = document.getElementById('toolbar')!;
const commitContextMenuEl = document.getElementById('commitContextMenu')!;

toolbarEl.addEventListener('click', event => {
	const btn = (event.target as HTMLElement).closest<HTMLElement>('.toolbar-btn[data-command]');
	if (btn) {
		vscodeApi.postMessage({ type: 'runAction', command: btn.dataset.command! });
	}
});

let currentFiles: ChangedFile[] = [];
let currentCommits: CommitInfo[] = [];
let selectedSha: string | undefined;
let selectedFileIndex = -1;
let activePane: 'commits' | 'files' = 'commits';

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
			c => `<div class="commit-row-wrapper${c.onBranch ? '' : ' not-on-branch'}">
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
	selectedFileIndex = -1;
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
	activePane = 'commits';
	const row = (event.target as HTMLElement).closest<HTMLElement>('.row[data-sha]');
	if (row) {
		selectCommit(row.dataset.sha!);
	}
});

let contextMenuSha: string | undefined;

function hideContextMenu(): void {
	commitContextMenuEl.hidden = true;
	contextMenuSha = undefined;
}

function showContextMenu(x: number, y: number, sha: string): void {
	contextMenuSha = sha;
	commitContextMenuEl.hidden = false;
	commitContextMenuEl.style.left = `${x}px`;
	commitContextMenuEl.style.top = `${y}px`;
	// Re-clamp after layout so the menu never renders partially off-screen near an edge.
	requestAnimationFrame(() => {
		const rect = commitContextMenuEl.getBoundingClientRect();
		if (rect.right > window.innerWidth) {
			commitContextMenuEl.style.left = `${Math.max(0, window.innerWidth - rect.width - 4)}px`;
		}
		if (rect.bottom > window.innerHeight) {
			commitContextMenuEl.style.top = `${Math.max(0, window.innerHeight - rect.height - 4)}px`;
		}
	});
}

commitsEl.addEventListener('contextmenu', event => {
	const row = (event.target as HTMLElement).closest<HTMLElement>('.row[data-sha]');
	if (!row) {
		return;
	}
	event.preventDefault();
	activePane = 'commits';
	selectCommit(row.dataset.sha!);
	showContextMenu(event.clientX, event.clientY, row.dataset.sha!);
});

commitContextMenuEl.addEventListener('click', event => {
	const item = (event.target as HTMLElement).closest<HTMLElement>('.context-menu-item[data-action]');
	const sha = contextMenuSha;
	hideContextMenu();
	if (!item || !sha) {
		return;
	}
	const commit = currentCommits.find(c => c.hash === sha);
	switch (item.dataset.action) {
		case 'resetMixed':
			vscodeApi.postMessage({ type: 'resetHead', sha, mode: 'mixed' });
			break;
		case 'resetHard':
			vscodeApi.postMessage({ type: 'resetHead', sha, mode: 'hard' });
			break;
		case 'cherryPick':
			vscodeApi.postMessage({ type: 'cherryPick', sha });
			break;
		case 'savePatch':
			vscodeApi.postMessage({ type: 'savePatch', sha, subject: commit?.message ?? sha });
			break;
	}
});

window.addEventListener('click', event => {
	if (!commitContextMenuEl.hidden && !commitContextMenuEl.contains(event.target as Node)) {
		hideContextMenu();
	}
});
window.addEventListener('blur', hideContextMenu);

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

function selectFile(index: number): void {
	if (!selectedSha) {
		return;
	}
	selectedFileIndex = index;
	filesEl.querySelectorAll('.row').forEach(row => {
		row.classList.toggle('selected', Number((row as HTMLElement).dataset.index) === index);
	});
	const file = currentFiles[index];
	vscodeApi.postMessage({ type: 'openDiff', sha: selectedSha, file });
}

function selectFileByOffset(offset: number): void {
	if (currentFiles.length === 0) {
		return;
	}
	const nextIndex = Math.min(
		currentFiles.length - 1,
		Math.max(0, (selectedFileIndex === -1 ? 0 : selectedFileIndex) + offset)
	);
	if (nextIndex === selectedFileIndex) {
		return;
	}
	selectFile(nextIndex);
	filesEl.querySelector<HTMLElement>(`.row[data-index="${nextIndex}"]`)?.scrollIntoView({ block: 'nearest' });
}

window.addEventListener('keydown', event => {
	if (event.key === 'Escape') {
		hideContextMenu();
		return;
	}
	if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
		return;
	}
	event.preventDefault();
	const offset = event.key === 'ArrowDown' ? 1 : -1;
	if (activePane === 'commits') {
		selectCommitByOffset(offset);
	} else {
		selectFileByOffset(offset);
	}
});

filesEl.addEventListener('click', event => {
	activePane = 'files';
	const row = (event.target as HTMLElement).closest<HTMLElement>('.row[data-index]');
	if (row) {
		selectFile(Number(row.dataset.index));
	}
});

window.addEventListener('message', event => {
	const message = event.data as HostMessage;
	switch (message.type) {
		case 'commits': {
			renderCommits(message.commits);
			if (message.commits.length === 0) {
				filesEl.innerHTML = '<div class="empty">Select a commit to see its changed files.</div>';
				break;
			}
			if (message.focusLatest) {
				// The panel was just opened or brought to the front (e.g. right after committing) --
				// always jump to the newest commit rather than sticking with whatever was selected
				// before, since the point of focusing it is to see what's actually new.
				selectCommit(message.commits[0].hash);
				commitsEl.querySelector<HTMLElement>(`.row[data-sha="${message.commits[0].hash}"]`)?.scrollIntoView({ block: 'nearest' });
				break;
			}
			// Background reload (e.g. after a fetch/pull) -- sticky selection: stay on the same commit
			// if the new log still contains it (a shared ancestor, most likely), otherwise fall back to
			// the top.
			const stillPresent = selectedSha && message.commits.some(c => c.hash === selectedSha);
			selectCommit(stillPresent ? selectedSha! : message.commits[0].hash);
			if (stillPresent) {
				commitsEl.querySelector<HTMLElement>(`.row[data-sha="${selectedSha}"]`)?.scrollIntoView({ block: 'nearest' });
			}
			break;
		}
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
	const initial = Number(layoutEl.dataset.initialSplit);
	applySplit(Number.isFinite(initial) ? initial : 60);
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
	vscodeApi.postMessage({ type: 'setSplit', commitsPercent });
}

splitterEl.addEventListener('pointerup', endDrag);
splitterEl.addEventListener('pointercancel', endDrag);

restoreSplit();

vscodeApi.postMessage({ type: 'ready' });
