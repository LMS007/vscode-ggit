import type { RebaseDialogState, RebaseHostMessage, RebasePreview, RebaseWebviewMessage } from '../rebaseProtocol';

declare function acquireVsCodeApi(): { postMessage(message: RebaseWebviewMessage): void };

const vscodeApi = acquireVsCodeApi();

const branchEl = document.getElementById('branch')!;
const ontoSelect = document.getElementById('onto') as HTMLSelectElement;
const modeAll = document.getElementById('modeAll') as HTMLInputElement;
const modeAfter = document.getElementById('modeAfter') as HTMLInputElement;
const upstreamInput = document.getElementById('upstream') as HTMLInputElement;
const cutPointsList = document.getElementById('cutPoints')!;
const suggestionEl = document.getElementById('suggestion')!;
const suggestionTextEl = document.getElementById('suggestionText')!;
const previewTitleEl = document.getElementById('previewTitle')!;
const previewStatusEl = document.getElementById('previewStatus')!;
const previewListEl = document.getElementById('previewList')!;
const leftOutFieldEl = document.getElementById('leftOutField')!;
const leftOutTitleEl = document.getElementById('leftOutTitle')!;
const leftOutHintEl = document.getElementById('leftOutHint')!;
const leftOutListEl = document.getElementById('leftOutList')!;
const updateRefsField = document.getElementById('updateRefsField')!;
const updateRefsCheckbox = document.getElementById('updateRefs') as HTMLInputElement;
const updateRefsDescEl = document.getElementById('updateRefsDesc')!;
const stashNoteEl = document.getElementById('stashNote')!;
const errorEl = document.getElementById('error')!;
const rebaseButton = document.getElementById('rebaseButton') as HTMLButtonElement;
const cancelButton = document.getElementById('cancelButton') as HTMLButtonElement;

let state: RebaseDialogState | undefined;
let preview: RebasePreview | undefined;
/** Only the newest request's answer counts -- typing a ref sends one per pause. */
let requestId = 0;
let busy = false;
/** Whether the user wants stacked branches moved -- kept apart from the checkbox, which a preview with
 * nothing stacked hides. */
let wantsUpdateRefs = true;

function plural(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

function joinNames(names: string[]): string {
	const quoted = names.map(n => `"${n}"`);
	return quoted.length <= 1 ? quoted.join('') : `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`;
}

/** The ref typed after "Only the commits after", when that's the mode; undefined otherwise. */
function cutPoint(): string | undefined {
	return modeAfter.checked ? upstreamInput.value.trim() || undefined : undefined;
}

function renderInit(next: RebaseDialogState): void {
	state = next;
	branchEl.textContent = next.branch;
	const group = (label: string, names: string[]) =>
		names.length === 0
			? ''
			: `<optgroup label="${label}">${names.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('')}</optgroup>`;
	ontoSelect.innerHTML = group('Local branches', next.localBranches) + group('Remote branches', next.remoteBranches);
	ontoSelect.value = next.onto;
	stashNoteEl.textContent = next.hasLocalChanges
		? 'Your uncommitted changes are stashed first and put back once the rebase is done -- or aborted.'
		: '';
	errorEl.textContent = '';
	busy = false;
	rebaseButton.textContent = 'Rebase';
	if (!next.onto) {
		previewStatusEl.textContent = 'There are no other branches to rebase onto.';
		rebaseButton.disabled = true;
		return;
	}
	requestPreview();
}

let debounce: ReturnType<typeof setTimeout> | undefined;

/** Asks for a new preview -- right away for a click, after a pause for typing. */
function requestPreview(delay = 0): void {
	clearTimeout(debounce);
	document.querySelectorAll('.ontoName').forEach(el => (el.textContent = ontoSelect.value));
	rebaseButton.disabled = true;
	if (modeAfter.checked && !cutPoint()) {
		requestId++;
		preview = undefined;
		renderPreview();
		previewStatusEl.textContent = 'Pick the branch or commit to start after.';
		return;
	}
	debounce = setTimeout(() => {
		vscodeApi.postMessage({ type: 'preview', requestId: ++requestId, onto: ontoSelect.value, upstream: cutPoint() });
	}, delay);
}

function commitItems(commits: RebasePreview['commits'], count: number): string {
	const items = commits.map(
		c =>
			`<li title="${c.sha}">` +
			`<span class="sha">${c.shortSha}</span>` +
			c.branches.map(b => `<span class="branch-badge">${escapeHtml(b)}</span>`).join('') +
			`<span class="subject">${escapeHtml(c.subject)}</span></li>`
	);
	if (count > commits.length) {
		items.push(`<li class="more">…and ${count - commits.length} more</li>`);
	}
	return items.join('');
}

function renderPreview(): void {
	const onto = ontoSelect.value;
	const branch = state?.branch ?? '';
	suggestionEl.hidden = true;
	if (!preview) {
		previewTitleEl.textContent = 'Commits to replay';
		previewListEl.innerHTML = '';
		leftOutFieldEl.hidden = true;
		updateRefsField.hidden = true;
		return;
	}
	const { commits, count, behind, leftOut, stacked, cutPoints } = preview;
	previewTitleEl.textContent = `Commits to replay (${count})`;
	previewListEl.innerHTML = commitItems(commits, count);
	let canRebase = true;
	// With every commit replayed, a rebase onto something the branch already has is a no-op ("Current
	// branch is up to date"). With a cut point it isn't: it still leaves out the commits before it.
	if (behind === 0 && !cutPoint()) {
		previewStatusEl.textContent = `Nothing to do: "${branch}" already sits on top of "${onto}".`;
		canRebase = false;
	} else if (count === 0) {
		previewStatusEl.textContent = `None: "${branch}" just moves to where "${onto}" is.`;
	} else {
		previewStatusEl.textContent = '';
	}

	leftOutFieldEl.hidden = !leftOut || leftOut.count === 0;
	if (leftOut && leftOut.count > 0) {
		leftOutTitleEl.textContent = `Left out (${leftOut.count})`;
		leftOutHintEl.textContent = `These won't be on "${branch}" any more. Only leave them out if "${onto}" already has their changes, e.g. because they were squash-merged.`;
		leftOutListEl.innerHTML = commitItems(leftOut.commits, leftOut.count);
	}

	cutPointsList.innerHTML = cutPoints
		.map(c => `<option value="${escapeHtml(c.name)}">${c.upstreamGone ? 'remote branch gone: likely merged' : ''}</option>`)
		.join('');
	// A branch under this one whose remote branch is gone was most likely merged -- and if that was a
	// squash merge, a plain rebase replays its commits again. Worth pointing out before Rebase.
	// cutPoints run nearest to `onto` first, so the last merged one is the cut that leaves out all of them.
	const merged = cutPoints.filter(c => c.upstreamGone);
	if (!cutPoint() && merged.length > 0) {
		const highest = merged[merged.length - 1].name;
		const names = merged.map(c => c.name);
		suggestionTextEl.innerHTML =
			`${escapeHtml(joinNames(names))} ${names.length === 1 ? 'has' : 'have'} no remote branch any more, so ${names.length === 1 ? 'it was' : 'they were'} likely merged. ` +
			`If by squash merge, <a id="useSuggestion">replay only the commits after "${escapeHtml(highest)}"</a>.`;
		suggestionEl.hidden = false;
		document.getElementById('useSuggestion')!.addEventListener('click', () => setCutPoint(highest));
	}

	updateRefsField.hidden = stacked.length === 0;
	if (stacked.length > 0) {
		const supported = state?.supportsUpdateRefs ?? false;
		updateRefsCheckbox.disabled = !supported;
		updateRefsCheckbox.checked = supported && wantsUpdateRefs;
		updateRefsField.classList.toggle('disabled', !supported);
		updateRefsDescEl.textContent = supported
			? `${joinNames(stacked)} ${stacked.length === 1 ? 'points' : 'point'} at commits being replayed. With this, ${stacked.length === 1 ? 'it moves' : 'they move'} along (--update-refs); without, ${stacked.length === 1 ? 'it stays' : 'they stay'} on the old commits.`
			: 'Needs git 2.38 or later (--update-refs).';
	}
	rebaseButton.disabled = !canRebase || busy;
}

function setCutPoint(ref: string): void {
	modeAfter.checked = true;
	upstreamInput.value = ref;
	requestPreview();
}

function submit(): void {
	if (!state || rebaseButton.disabled) {
		return;
	}
	errorEl.textContent = '';
	busy = true;
	rebaseButton.disabled = true;
	rebaseButton.textContent = 'Rebasing…';
	vscodeApi.postMessage({
		type: 'rebase',
		onto: ontoSelect.value,
		upstream: cutPoint(),
		updateRefs: !updateRefsField.hidden && updateRefsCheckbox.checked,
	});
}

ontoSelect.addEventListener('change', () => requestPreview());
modeAll.addEventListener('change', () => requestPreview());
modeAfter.addEventListener('change', () => {
	upstreamInput.focus();
	requestPreview();
});
// Typing a cut point is choosing that mode.
upstreamInput.addEventListener('focus', () => {
	if (!modeAfter.checked) {
		modeAfter.checked = true;
		requestPreview();
	}
});
upstreamInput.addEventListener('input', () => requestPreview(300));
updateRefsCheckbox.addEventListener('change', () => (wantsUpdateRefs = updateRefsCheckbox.checked));
rebaseButton.addEventListener('click', submit);
cancelButton.addEventListener('click', () => vscodeApi.postMessage({ type: 'cancel' }));

window.addEventListener('keydown', event => {
	if (event.key === 'Escape') {
		vscodeApi.postMessage({ type: 'cancel' });
	} else if (event.key === 'Enter' && document.activeElement === upstreamInput) {
		requestPreview();
	}
});

window.addEventListener('message', event => {
	const message = event.data as RebaseHostMessage;
	switch (message.type) {
		case 'init':
			renderInit(message.state);
			break;
		case 'preview':
			if (message.requestId !== requestId) {
				return;
			}
			preview = message.preview;
			renderPreview();
			if (message.error) {
				previewStatusEl.textContent = message.error;
				rebaseButton.disabled = true;
			}
			break;
		case 'error':
			errorEl.textContent = message.message;
			busy = false;
			rebaseButton.textContent = 'Rebase';
			rebaseButton.disabled = !preview;
			break;
	}
});

vscodeApi.postMessage({ type: 'ready' });
