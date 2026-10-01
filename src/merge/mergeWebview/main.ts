import type { MergeDialogState, MergeHostMessage, MergeWebviewMessage } from '../mergeProtocol';

declare function acquireVsCodeApi(): { postMessage(message: MergeWebviewMessage): void };

const vscodeApi = acquireVsCodeApi();

const intoBranchEl = document.getElementById('intoBranch')!;
const sourceBranchEl = document.getElementById('sourceBranch')!;
const summaryEl = document.getElementById('summary')!;
const conflictWarningEl = document.getElementById('conflictWarning')!;
const conflictTextEl = document.getElementById('conflictText')!;
const squashCheckbox = document.getElementById('squash') as HTMLInputElement;
const noFastForwardCheckbox = document.getElementById('noFastForward') as HTMLInputElement;
const commitCheckbox = document.getElementById('commit') as HTMLInputElement;
const stashNoteEl = document.getElementById('stashNote')!;
const errorEl = document.getElementById('error')!;
const mergeButton = document.getElementById('mergeButton') as HTMLButtonElement;
const cancelButton = document.getElementById('cancelButton') as HTMLButtonElement;

let state: MergeDialogState | undefined;
// What the user last chose for each option, kept apart from the checkboxes themselves -- an option
// that stops applying (e.g. Always Generate Merge Commit once Squash is ticked) is forced to show its
// fixed value, and this is what it goes back to once it applies again.
const choices = { squash: false, noFastForward: false, commit: true };
// What Merge will actually send -- the choices above, after render() has overridden whichever ones
// don't apply to this merge.
let effective = { ...choices };

const DEFAULT_DESCRIPTIONS = {
	squash: 'The changes are applied as a single commit.',
	noFastForward: 'Generate a merge commit even if the merge resolved as a fast-forward.',
	commit: 'Without this option, changes are only applied to the working copy but not automatically committed.',
};

function plural(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** Sets one option's checkbox and description -- `fixed` (a value) means it doesn't apply to this
 * merge as configured, so it's shown greyed out at that value; undefined means it's the user's call. */
function setOption(name: keyof typeof choices, checkbox: HTMLInputElement, fixed: boolean | undefined, description: string): void {
	checkbox.disabled = fixed !== undefined;
	checkbox.checked = fixed ?? choices[name];
	document.getElementById(`${name}Field`)!.classList.toggle('disabled', fixed !== undefined);
	document.getElementById(`${name}Desc`)!.textContent = description;
}

/** Re-derives every option from the merge analysis plus the other options' current values -- which
 * ones apply depends on each other (a squash never makes a merge commit; a pure fast-forward makes no
 * commit at all), so this runs again on every change rather than each checkbox managing itself. */
function render(): void {
	if (!state) {
		return;
	}
	const { sourceBranch, intoBranch, analysis } = state;
	const fastForward = analysis.outgoing === 0;
	const hasConflicts = analysis.conflicts.length > 0;

	// A squash has no MERGE_HEAD, so a conflicted one would have no merge for the Conflicts tab to
	// finish or abort (see GitService.mergeBranch) -- merge normally instead.
	const squash = !hasConflicts && choices.squash;
	setOption(
		'squash',
		squashCheckbox,
		hasConflicts ? false : undefined,
		hasConflicts ? 'Not available when the merge has conflicts -- merge normally to resolve them.' : DEFAULT_DESCRIPTIONS.squash
	);

	let noFastForward: boolean;
	if (squash) {
		noFastForward = false;
		setOption('noFastForward', noFastForwardCheckbox, false, 'A squash is applied as one ordinary commit, never a merge commit.');
	} else if (!fastForward) {
		noFastForward = true;
		setOption('noFastForward', noFastForwardCheckbox, true, `Required -- ${intoBranch} and ${sourceBranch} have diverged.`);
	} else {
		noFastForward = choices.noFastForward;
		setOption('noFastForward', noFastForwardCheckbox, undefined, DEFAULT_DESCRIPTIONS.noFastForward);
	}

	let commit: boolean;
	if (hasConflicts && !squash) {
		commit = true;
		setOption('commit', commitCheckbox, true, "The merge stops for you to resolve the conflicts first -- you'll commit it from the Merge tab.");
	} else if (fastForward && !squash && !noFastForward) {
		commit = true;
		setOption('commit', commitCheckbox, true, `Nothing to commit -- a fast-forward just moves ${intoBranch} up to ${sourceBranch}.`);
	} else {
		commit = choices.commit;
		setOption('commit', commitCheckbox, undefined, DEFAULT_DESCRIPTIONS.commit);
	}

	stashNoteEl.textContent = !state.hasLocalChanges
		? ''
		: squash
			? 'Your uncommitted changes stay where they are and are left out of the squash. git stops instead if any of them would be overwritten.'
			: 'Your uncommitted changes are stashed first and put back once the merge is done -- or aborted.';

	effective = { squash, noFastForward, commit };
}

function renderInit(next: MergeDialogState): void {
	state = next;
	const { sourceBranch, intoBranch, analysis } = next;
	intoBranchEl.textContent = intoBranch;
	sourceBranchEl.textContent = sourceBranch;
	sourceBranchEl.title = sourceBranch;

	const incoming = `${plural(analysis.incoming, 'commit')} to bring in from ${sourceBranch}.`;
	summaryEl.textContent =
		analysis.outgoing === 0
			? `${incoming} ${intoBranch} can fast-forward, so no merge commit is needed unless you ask for one.`
			: `${incoming} ${intoBranch} also has ${plural(analysis.outgoing, 'commit')} of its own, so the two have diverged and a merge commit is needed.`;

	conflictWarningEl.hidden = analysis.conflicts.length === 0;
	if (analysis.conflicts.length > 0) {
		const shown = analysis.conflicts.slice(0, 5).join(', ');
		const more = analysis.conflicts.length > 5 ? ` and ${analysis.conflicts.length - 5} more` : '';
		conflictTextEl.textContent =
			`Expect conflicts in ${plural(analysis.conflicts.length, 'file')}: ${shown}${more}. ` +
			'The merge will stop so you can resolve them in the Merge tab.';
	}

	errorEl.textContent = '';
	mergeButton.disabled = false;
	mergeButton.textContent = 'Merge';
	render();
	mergeButton.focus();
}

function submit(): void {
	if (!state || mergeButton.disabled) {
		return;
	}
	errorEl.textContent = '';
	mergeButton.disabled = true;
	mergeButton.textContent = 'Merging…';
	vscodeApi.postMessage({ type: 'merge', ...effective });
}

for (const [name, checkbox] of [
	['squash', squashCheckbox],
	['noFastForward', noFastForwardCheckbox],
	['commit', commitCheckbox],
] as const) {
	checkbox.addEventListener('change', () => {
		choices[name] = checkbox.checked;
		render();
	});
}

mergeButton.addEventListener('click', submit);
cancelButton.addEventListener('click', () => vscodeApi.postMessage({ type: 'cancel' }));

window.addEventListener('keydown', event => {
	if (event.key === 'Escape') {
		vscodeApi.postMessage({ type: 'cancel' });
	}
});

window.addEventListener('message', event => {
	const message = event.data as MergeHostMessage;
	switch (message.type) {
		case 'init':
			renderInit(message.state);
			break;
		case 'error':
			errorEl.textContent = message.message;
			mergeButton.disabled = false;
			mergeButton.textContent = 'Merge';
			break;
	}
});

vscodeApi.postMessage({ type: 'ready' });
