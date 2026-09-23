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
const fileContextMenuEl = document.getElementById('fileContextMenu')!;
const pushButtonEl = toolbarEl.querySelector<HTMLElement>('.toolbar-btn[data-command="ggit.push"]');
const pushButtonLabelEl = pushButtonEl?.querySelector<HTMLElement>('.toolbar-btn-label');

/** Four states, driven by the same facts the "commits" message already carries:
 *  - no "origin" configured at all -> grey "Publish" (nowhere to publish to yet)
 *  - origin exists, branch never pushed (no upstream) -> purple "Publish"
 *  - origin exists, upstream exists, commits ahead -> green "Push"
 *  - origin exists, upstream exists, nothing ahead -> grey "Push"
 * Label text (not just color) changes because "Push" and "Publish" really are different actions --
 * publishing also sets up the new branch's tracking (see gitActions.pushCurrentBranch) -- even though
 * both are wired to the same 'runAction'/ggit.push command underneath. */
function updatePushButton(hasRemote: boolean, hasUpstream: boolean, aheadCount: number): void {
	if (!pushButtonEl) {
		return;
	}
	const label = hasRemote && hasUpstream ? 'Push' : 'Publish';
	pushButtonEl.classList.toggle('toolbar-btn-success', hasRemote && hasUpstream && aheadCount > 0);
	pushButtonEl.classList.toggle('toolbar-btn-publish', hasRemote && !hasUpstream);
	if (pushButtonLabelEl) {
		pushButtonLabelEl.textContent = label;
	}
	pushButtonEl.title = label;
	pushButtonEl.setAttribute('aria-label', label);
}
const searchInput = document.getElementById('searchInput') as HTMLInputElement;
const searchStatusEl = document.getElementById('searchStatus')!;
const searchClearButton = document.getElementById('searchClearButton') as HTMLButtonElement;

/** See plans/commit-search-plan.md -- verified against a real large repo that this is cheap
 * (git log scales near-linearly, ~35-50ms for 500-2000 commits), so there's little reason to
 * lowball it. Going deeper than this is the "Search older commits" affordance's job, not a bigger
 * default. */
const SEARCH_MIN_COMMITS = 1000;

/** Hard ceiling on how deep "Search older commits" can go, no matter how many times it's clicked --
 * a runaway-loading incident (see the scroll-listener fix above) made it clear this needs an actual
 * backstop, not just "trust the button is only clicked a reasonable number of times." Once hit, the
 * button stops appearing and a message explains why instead. */
const SEARCH_MAX_COMMITS = 5000;

toolbarEl.addEventListener('click', event => {
	const btn = (event.target as HTMLElement).closest<HTMLElement>('.toolbar-btn[data-command]');
	if (btn) {
		vscodeApi.postMessage({ type: 'runAction', command: btn.dataset.command! });
	}
});

let currentFiles: ChangedFile[] = [];
let currentCommits: CommitInfo[] = [];
let selectedSha: string | undefined;
let selectedRowEl: HTMLElement | undefined;
let selectedFileIndex = -1;
let activePane: 'commits' | 'files' = 'commits';
let hasMoreCommits = false;
let loadingMoreCommits = false;
// True specifically while an ensureCommitsForSearch bulk-load loop is in flight -- kept separate
// from loadingMoreCommits' own meaning (which the 'moreCommits' handler below would otherwise clear
// after just the *first* page of a multi-page bulk load, since that handler doesn't know it's part
// of a loop rather than a single scroll-triggered fetch).
let bulkLoadingForSearch = false;
let searchQuery = '';

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

function commitRowHtml(c: CommitInfo): string {
	return `<div class="commit-row-wrapper${c.onBranch ? '' : ' not-on-branch'}">
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
		</div>`;
}

function renderCommits(commits: CommitInfo[]): void {
	currentCommits = commits;
	selectedRowEl = undefined;
	if (commits.length === 0) {
		commitsEl.innerHTML = '<div class="empty">No commits on this branch.</div>';
		return;
	}
	commitsEl.innerHTML = commits.map(commitRowHtml).join('');
}

/** Appends a page onto what's already rendered, rather than rebuilding the whole (potentially large,
 * after several scroll-triggered pages) list -- keeps each "load more" cheap regardless of how much
 * has accumulated so far. While a search is active, a plain append would be wrong (the new commits
 * might not match, or might, but either way need to go through the filter) -- that case defers to a
 * full filtered re-render instead, which is cheap enough at this scale (verified: even a few
 * thousand commits filters and re-renders in well under 100ms). */
function appendCommits(commits: CommitInfo[]): void {
	currentCommits = currentCommits.concat(commits);
	if (searchQuery.trim()) {
		applyFilterAndRender();
	} else {
		commitsEl.insertAdjacentHTML('beforeend', commits.map(commitRowHtml).join(''));
	}
}

function matchesSearch(c: CommitInfo, query: string): boolean {
	return (
		c.authorName.toLowerCase().includes(query) ||
		c.authorEmail.toLowerCase().includes(query) ||
		c.message.toLowerCase().includes(query)
	);
}

const LOAD_OLDER_ROW_ID = 'loadOlderCommitsRow';

/** Shown below the (filtered) list while a search is active and there's more history not yet
 * loaded -- the deliberate, on-demand way to search past SEARCH_MIN_COMMITS, rather than ever
 * guessing a single "big enough" default. Hidden while a bulk load is already in flight (the
 * loading indicator covers that instead) so there's never a redundant, clickable-looking button
 * sitting there mid-fetch. */
function updateLoadOlderRow(): void {
	document.getElementById(LOAD_OLDER_ROW_ID)?.remove();
	if (!searchQuery.trim() || !hasMoreCommits || bulkLoadingForSearch) {
		return;
	}
	if (currentCommits.length >= SEARCH_MAX_COMMITS) {
		commitsEl.insertAdjacentHTML(
			'beforeend',
			`<div id="${LOAD_OLDER_ROW_ID}" class="load-older-row"><span class="empty">Reached the ${SEARCH_MAX_COMMITS}-commit search limit. Try narrowing your search.</span></div>`
		);
		return;
	}
	commitsEl.insertAdjacentHTML(
		'beforeend',
		`<div id="${LOAD_OLDER_ROW_ID}" class="load-older-row"><button id="loadOlderButton" type="button">Search older commits</button></div>`
	);
}

/** Re-derives what's visible from currentCommits + searchQuery -- called on every keystroke and
 * whenever currentCommits grows while a search is active. A full re-render rather than incremental
 * append/toggle: simpler to keep correct, and cheap enough at the sizes this ever deals with
 * (bounded by SEARCH_MIN_COMMITS plus however many "Search older" clicks were made). */
function applyFilterAndRender(): void {
	const query = searchQuery.trim().toLowerCase();
	searchClearButton.hidden = !query;
	if (!query) {
		// Back to the plain, unfiltered view -- covers backspacing a search back to empty, not just
		// the explicit clear button (which just delegates here after resetting the query).
		searchStatusEl.textContent = '';
		renderCommits(currentCommits);
		if (selectedSha) {
			highlightSelectedCommit(selectedSha);
		}
		updateLoadOlderRow();
		return;
	}
	const matches = currentCommits.filter(c => matchesSearch(c, query));
	selectedRowEl = undefined;
	commitsEl.innerHTML =
		matches.length === 0 ? '<div class="empty">No matches in loaded commits.</div>' : matches.map(commitRowHtml).join('');
	if (selectedSha) {
		highlightSelectedCommit(selectedSha);
	}
	searchStatusEl.textContent = `${matches.length} match${matches.length === 1 ? '' : 'es'} of ${currentCommits.length} loaded`;
	updateLoadOlderRow();
}

const LOADING_MORE_ROW_ID = 'loadingMoreCommitsRow';

/** Shown at the bottom of the commits pane while a lazy-loaded page is in flight -- a slow/busy git
 * host (e.g. a loaded-down remote) can make that wait noticeable, and with nothing else changing on
 * screen it previously just looked like scrolling had silently stopped working. */
function showLoadingMoreIndicator(): void {
	if (document.getElementById(LOADING_MORE_ROW_ID)) {
		return;
	}
	commitsEl.insertAdjacentHTML(
		'beforeend',
		`<div id="${LOADING_MORE_ROW_ID}" class="loading-more-row"><span class="codicon codicon-loading codicon-modifier-spin"></span>Loading more commits…</div>`
	);
}

function hideLoadingMoreIndicator(): void {
	document.getElementById(LOADING_MORE_ROW_ID)?.remove();
}

/** Tracks the previously-selected row directly instead of scanning every row on each selection --
 * on a branch with a lot of history loaded (several scrolled-in pages), a full querySelectorAll
 * every time you click a different commit is real, avoidable work. */
function highlightSelectedCommit(sha: string): void {
	selectedRowEl?.classList.remove('selected');
	const row = commitsEl.querySelector<HTMLElement>(`.row[data-sha="${sha}"]`);
	row?.classList.add('selected');
	selectedRowEl = row ?? undefined;
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
					<span class="file-open-icon codicon codicon-go-to-file" data-path="${escapeHtml(f.path)}" title="Open file for editing"></span>
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

function requestMoreForSearch(minCount: number): void {
	bulkLoadingForSearch = true;
	loadingMoreCommits = true;
	showLoadingMoreIndicator();
	updateLoadOlderRow();
	vscodeApi.postMessage({ type: 'ensureCommitsForSearch', minCount });
}

commitsEl.addEventListener('click', event => {
	const loadOlderBtn = (event.target as HTMLElement).closest<HTMLElement>('#loadOlderButton');
	if (loadOlderBtn) {
		requestMoreForSearch(Math.min(currentCommits.length + SEARCH_MIN_COMMITS, SEARCH_MAX_COMMITS));
		return;
	}
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
		case 'copyHash':
			vscodeApi.postMessage({ type: 'copyCommitHash', sha });
			break;
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

let contextMenuFilePath: string | undefined;

function hideFileContextMenu(): void {
	fileContextMenuEl.hidden = true;
	contextMenuFilePath = undefined;
}

/** Same positioning/clamping as showContextMenu (commits) -- kept as a separate copy rather than a
 * shared helper since the two menus are independent DOM elements with independent open/close state. */
function showFileContextMenu(x: number, y: number, filePath: string): void {
	contextMenuFilePath = filePath;
	fileContextMenuEl.hidden = false;
	fileContextMenuEl.style.left = `${x}px`;
	fileContextMenuEl.style.top = `${y}px`;
	requestAnimationFrame(() => {
		const rect = fileContextMenuEl.getBoundingClientRect();
		if (rect.right > window.innerWidth) {
			fileContextMenuEl.style.left = `${Math.max(0, window.innerWidth - rect.width - 4)}px`;
		}
		if (rect.bottom > window.innerHeight) {
			fileContextMenuEl.style.top = `${Math.max(0, window.innerHeight - rect.height - 4)}px`;
		}
	});
}

// Right-clicking a file row previously fell through to the webview's default browser context menu
// (Cut/Copy/Paste, from the row's selectable text) -- preventDefault here is what replaces that with
// GGit's own menu instead. Deliberately doesn't call selectFile() (unlike the commits pane, which does
// select on right-click): selectFile() posts 'openDiff' and opens a diff editor tab, which would be a
// surprising side effect of just right-clicking a row.
filesEl.addEventListener('contextmenu', event => {
	const row = (event.target as HTMLElement).closest<HTMLElement>('.row[data-index]');
	if (!row) {
		return;
	}
	event.preventDefault();
	const file = currentFiles[Number(row.dataset.index)];
	if (!file) {
		return;
	}
	showFileContextMenu(event.clientX, event.clientY, file.path);
});

fileContextMenuEl.addEventListener('click', event => {
	const item = (event.target as HTMLElement).closest<HTMLElement>('.context-menu-item[data-action]');
	const filePath = contextMenuFilePath;
	hideFileContextMenu();
	if (!item || !filePath) {
		return;
	}
	switch (item.dataset.action) {
		case 'copyRelativePath':
			vscodeApi.postMessage({ type: 'copyFilePath', path: filePath, mode: 'relative' });
			break;
		case 'copyFullPath':
			vscodeApi.postMessage({ type: 'copyFilePath', path: filePath, mode: 'full' });
			break;
		case 'revealInExplorer':
			vscodeApi.postMessage({ type: 'revealFileInExplorer', path: filePath });
			break;
		case 'revealInOS':
			vscodeApi.postMessage({ type: 'revealFileInOS', path: filePath });
			break;
	}
});

window.addEventListener('click', event => {
	if (!commitContextMenuEl.hidden && !commitContextMenuEl.contains(event.target as Node)) {
		hideContextMenu();
	}
	if (!fileContextMenuEl.hidden && !fileContextMenuEl.contains(event.target as Node)) {
		hideFileContextMenu();
	}
});
window.addEventListener('blur', () => {
	hideContextMenu();
	hideFileContextMenu();
});

/** Walks whatever's actually rendered in the commits pane, in DOM order, rather than indexing into
 * currentCommits directly -- currentCommits is the full accumulated list, but a search may be
 * filtering it down to a much smaller visible subset, and arrow/page navigation should move through
 * what's on screen, not silently jump through hidden non-matches. */
function selectCommitByOffset(offset: number): void {
	const rows = Array.from(commitsEl.querySelectorAll<HTMLElement>('.row[data-sha]'));
	if (rows.length === 0) {
		return;
	}
	const currentIndex = rows.findIndex(r => r.dataset.sha === selectedSha);
	const nextIndex = Math.min(rows.length - 1, Math.max(0, (currentIndex === -1 ? 0 : currentIndex) + offset));
	const nextSha = rows[nextIndex].dataset.sha!;
	if (nextSha === selectedSha) {
		return;
	}
	selectCommit(nextSha);
	rows[nextIndex].scrollIntoView({ block: 'nearest' });
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

/** How many rows actually fit in the pane's visible area, so Page Up/Down jumps a real screenful
 * instead of an arbitrary guessed count -- measured off one already-rendered row rather than
 * hardcoded, since commit rows and file rows aren't the same height. */
function getPageRowCount(container: HTMLElement, rowSelector: string): number {
	const row = container.querySelector<HTMLElement>(rowSelector);
	const rowHeight = row?.getBoundingClientRect().height;
	if (!rowHeight) {
		return 10;
	}
	return Math.max(1, Math.floor(container.clientHeight / rowHeight));
}

window.addEventListener('keydown', event => {
	if (event.key === 'Escape') {
		hideContextMenu();
		hideFileContextMenu();
		return;
	}
	const isArrow = event.key === 'ArrowDown' || event.key === 'ArrowUp';
	const isPage = event.key === 'PageDown' || event.key === 'PageUp';
	if (!isArrow && !isPage) {
		return;
	}
	event.preventDefault();
	const direction = event.key === 'ArrowDown' || event.key === 'PageDown' ? 1 : -1;
	if (activePane === 'commits') {
		const step = isPage ? getPageRowCount(commitsEl, '.commit-row-wrapper') : 1;
		selectCommitByOffset(direction * step);
	} else {
		const step = isPage ? getPageRowCount(filesEl, '.file-row') : 1;
		selectFileByOffset(direction * step);
	}
});

filesEl.addEventListener('click', event => {
	const openIcon = (event.target as HTMLElement).closest<HTMLElement>('.file-open-icon');
	if (openIcon) {
		// Stop this from also selecting the row (which would open a diff instead) -- opening for
		// editing and viewing the diff are two different actions on the same row.
		event.stopPropagation();
		vscodeApi.postMessage({ type: 'openFileForEditing', path: openIcon.dataset.path! });
		return;
	}
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
			hasMoreCommits = message.hasMore;
			loadingMoreCommits = false;
			bulkLoadingForSearch = false;
			// A fresh load (branch switch/open/reveal) starts over -- carrying a search across to an
			// unrelated branch's commit list wouldn't mean anything.
			searchQuery = '';
			searchInput.value = '';
			searchStatusEl.textContent = '';
			searchClearButton.hidden = true;
			updatePushButton(message.hasRemote, message.hasUpstream, message.aheadCount);
			commitsEl.scrollTop = 0;
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
		case 'moreCommits':
			hasMoreCommits = message.hasMore;
			// Only clear the single-page loading state here, not while a bulk search-load loop is still
			// in progress -- that loop's own 'searchLoadFinished' (below) is what actually finishes,
			// since a bulk load is many 'moreCommits' messages in a row, not just one.
			if (!bulkLoadingForSearch) {
				loadingMoreCommits = false;
				hideLoadingMoreIndicator();
			}
			appendCommits(message.commits);
			break;
		case 'moreCommitsFailed':
			loadingMoreCommits = false;
			bulkLoadingForSearch = false;
			hideLoadingMoreIndicator();
			updateLoadOlderRow();
			break;
		case 'searchLoadFinished':
			bulkLoadingForSearch = false;
			loadingMoreCommits = false;
			hideLoadingMoreIndicator();
			applyFilterAndRender();
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

const LOAD_MORE_THRESHOLD_PX = 300;

commitsEl.addEventListener(
	'scroll',
	() => {
		// Passive infinite-scroll must stay off entirely while a search is active. A filtered result
		// list is usually short, which means it's already "near the bottom" by definition regardless
		// of how much history is actually loaded -- without this check, that falsely satisfied the
		// threshold below on essentially every scroll tick, firing loadMoreCommits over and over (each
		// one appending to currentCommits and triggering a full filtered re-render) in a tight loop
		// that made the whole window unresponsive. While searching, only the explicit "Search older
		// commits" button (which has its own hard cap) is allowed to fetch more.
		if (searchQuery.trim() || !hasMoreCommits || loadingMoreCommits) {
			return;
		}
		const distanceFromBottom = commitsEl.scrollHeight - commitsEl.scrollTop - commitsEl.clientHeight;
		if (distanceFromBottom <= LOAD_MORE_THRESHOLD_PX) {
			loadingMoreCommits = true;
			showLoadingMoreIndicator();
			vscodeApi.postMessage({ type: 'loadMoreCommits' });
		}
	},
	{ passive: true }
);

// First interaction with the search box kicks off the bulk pre-load, before the user's even typed
// anything -- by the time they finish typing a first character, most/all of it has often already
// landed. { once: true } since ensureCommitsForSearch is a cheap no-op host-side once satisfied, so
// there's no need to keep re-triggering it on every subsequent focus.
searchInput.addEventListener(
	'focus',
	() => {
		requestMoreForSearch(SEARCH_MIN_COMMITS);
	},
	{ once: true }
);

let searchDebounceTimer: ReturnType<typeof setTimeout> | undefined;
searchInput.addEventListener('input', () => {
	clearTimeout(searchDebounceTimer);
	searchDebounceTimer = setTimeout(() => {
		searchQuery = searchInput.value;
		applyFilterAndRender();
	}, 150);
});

searchClearButton.addEventListener('click', () => {
	searchInput.value = '';
	searchQuery = '';
	applyFilterAndRender();
	searchInput.focus();
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
