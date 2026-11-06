/** Turns git's raw failure output into something short enough to show. No `vscode` import, so it can
 * be exercised outside VS Code like GitService. */

/** CSI sequences (colors, cursor moves) and OSC ones (terminal titles, hyperlinks). Hooks run by tools
 * like husky print colored output even though git captured it rather than a terminal. */
const ANSI_SEQUENCE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

export function stripAnsi(text: string): string {
	return text.replace(ANSI_SEQUENCE, '');
}

/** One line per line, whether git wrote "\n", "\r\n", or a progress-style bare "\r". */
export function splitLines(text: string): string[] {
	return stripAnsi(text).split(/\r\n|\r|\n/);
}

/** The line of a failed push's output that says what went wrong -- skipping git's leading "To <url>". */
export function firstErrorLine(message: string): string {
	return (
		splitLines(message)
			.map(line => line.trim())
			.find(line => line && !line.startsWith('To ')) ?? message.trim()
	);
}

/** Git's own message for a push rejected because the remote has commits the local branch doesn't --
 * distinct from other push failures (auth, network, ...), which should still just surface as a
 * normal error rather than offering to force. */
export function isNonFastForwardRejection(message: string): boolean {
	return /\[rejected\]/.test(message) && /non-fast-forward|fetch first/i.test(message);
}

/** A lease (`--force-with-lease=<ref>:<sha>`) that no longer matched: the remote branch moved after
 * GGit read it, so git refused to overwrite it. */
export function isStaleLeaseRejection(message: string): boolean {
	return /\[rejected\]/.test(message) && /stale info/.test(message);
}

/** Whether a failed push was stopped by the local pre-push hook. Git ends every push it didn't
 * finish with "failed to push some refs", but when the remote or git itself turned a ref down, it
 * also says which one and why ("[rejected]", "[remote rejected]" for a server-side hook, "src refspec
 * ... does not match any" for a missing branch). With none of those, the push never left this
 * machine. Husky also says so outright. Only meaningful when the repo has a pre-push hook (see
 * GitService.getHookPath) -- otherwise there's no hook to blame. */
export function isPushBlockedByHook(message: string): boolean {
	const text = stripAnsi(message);
	if (/husky - pre-push script failed/.test(text)) {
		return true;
	}
	return (
		/failed to push some refs/.test(text) &&
		!/\[(remote )?rejected\]|\[remote failure\]/.test(text) &&
		!/src refspec .* does not match any/.test(text)
	);
}

/** git's own reasons a commit doesn't happen, as opposed to a pre-commit or commit-msg hook's. */
const GIT_COMMIT_ERRORS = [
	/nothing (added )?to commit/,
	/no changes added to commit/,
	/Please tell me who you are/,
	/unable to auto-detect email/,
	/Committing is not possible because you have unmerged files/,
	/^fatal: /m,
];

/** Whether a failed commit was stopped by a commit hook. Git prints nothing of its own when one
 * fails, so this is everything that isn't one of git's own refusals. Only meaningful when the repo
 * has a pre-commit or commit-msg hook. */
export function isCommitBlockedByHook(message: string): boolean {
	const text = stripAnsi(message);
	if (/husky - (pre-commit|commit-msg|prepare-commit-msg) script failed/.test(text)) {
		return true;
	}
	return !GIT_COMMIT_ERRORS.some(pattern => pattern.test(text));
}

export interface HookFailure {
	/** The hook as it should be named to the user, e.g. "pre-push". */
	hook: string;
	/** Steps the hook reported as failed, when it names them -- see parseHookFailure. */
	failedSteps: string[];
	/** Log files the hook pointed at, most specific first. Not checked for existence. */
	logPaths: string[];
	/** The hook's exit code, when husky reported it. */
	exitCode?: number;
}

/** What can be read out of a failed hook's output without knowing which tool printed it:
 *  - Check runners that keep each step's full output in a log file and print a line like
 *    "── tailwind failed (full log: /tmp/checks/tailwind.log) ──" give both the step and its log.
 *  - Otherwise any absolute path to a .log file is offered as the log.
 *  - Husky's own "husky - pre-push script failed (code 1)" gives the exit code.
 * Git's stdout and stderr both end up in the message (simple-git joins them), and a pre-push hook's
 * stdout goes to git's stdout, so the hook's own output is all there. */
export function parseHookFailure(message: string, hook: string): HookFailure {
	const text = splitLines(message).join('\n');
	const failedSteps: string[] = [];
	const logPaths: string[] = [];
	for (const match of text.matchAll(/^[\s\-─━=*#>|:]*(\S.*?) failed \(full log: ([^)\n]+)\)/gm)) {
		failedSteps.push(match[1].trim());
		logPaths.push(match[2].trim());
	}
	if (logPaths.length === 0) {
		for (const match of text.matchAll(/(?:^|[\s('"`=])((?:\/|[A-Za-z]:\\)[^\s'"`()]*\.log)(?=$|[\s)'"`:,])/gm)) {
			logPaths.push(match[1]);
		}
	}
	const named = text.match(/husky - (\S+) script failed \(code (\d+)\)/);
	return {
		hook: named?.[1] ?? hook,
		failedSteps: [...new Set(failedSteps)],
		logPaths: [...new Set(logPaths)],
		exitCode: named ? Number(named[2]) : undefined,
	};
}

/** e.g. "Push blocked by the pre-push hook: tailwind failed." */
export function describeHookFailure(failure: HookFailure, action: string): string {
	const steps = failure.failedSteps;
	const reason =
		steps.length > 0
			? `: ${joinWithAnd(steps)} failed`
			: failure.exitCode !== undefined
				? ` (exit code ${failure.exitCode})`
				: '';
	return `${action} blocked by the ${failure.hook} hook${reason}.`;
}

export function joinWithAnd(parts: string[]): string {
	if (parts.length <= 1) {
		return parts.join('');
	}
	return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** A porcelain push's verdict on one ref (see GitService.pushBranches). */
export interface PushedRef {
	/** The local branch name, e.g. "alice/feature-x". */
	branch: string;
	ok: boolean;
	/** git's summary, e.g. "[rejected] (non-fast-forward)" or "7de2ee3...4737989 (forced update)". */
	summary: string;
}

/** Reads `git push --porcelain`'s per-ref lines -- "<flag>\t<from>:<to>\t<summary>", where the flag
 * "!" means rejected -- out of its output, or out of the error a failed one threw. */
export function parsePorcelainPush(output: string): PushedRef[] {
	const refs: PushedRef[] = [];
	for (const line of splitLines(output)) {
		const match = line.match(/^([ +\-*=!])\trefs\/heads\/([^:\t]+):[^\t]*\t(.*)$/);
		if (match) {
			refs.push({ branch: match[2], ok: match[1] !== '!', summary: match[3].trim() });
		}
	}
	return refs;
}
