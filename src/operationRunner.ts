import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { describeHookFailure, HookFailure, isPushBlockedByHook, parseHookFailure, splitLines, stripAnsi } from './git/gitErrors';
import { formatDuration, GitService } from './git/gitService';

/** What an operation gets from OperationRunner.run. Shaped like PushOptions, so a push can pass it
 * straight through. */
export interface OperationContext {
	/** Set when the user asked to run it again without hooks (see showHookFailure). */
	readonly noVerify: boolean;
	/** Live output from git and the hooks it runs: logged, and shown in the progress notification. */
	readonly onOutput: (text: string) => void;
}

export interface OperationOptions {
	/** The hook this operation runs, e.g. "pre-push" for anything that pushes. While it runs, its
	 * output shows in the progress notification, so a minute of checks doesn't look stuck; when it
	 * stops the operation, the error says so in one line and offers Retry, a run without hooks, and
	 * the hook's log. */
	hook?: 'pre-push';
	/** The verb for the hook-failure message and its skip button, e.g. "Push". */
	action?: string;
}

/** Runs a git operation behind a progress notification. Everything goes to the "GGit" output channel
 * -- what ran, how long it took, any live output, and the full error with color codes stripped --
 * so the error notification itself can stay short. */
export class OperationRunner {
	constructor(
		private readonly gitService: GitService,
		private readonly output: vscode.OutputChannel,
		/** After every successful operation, on top of its own onSuccess. */
		private readonly afterSuccess: () => void
	) {}

	/** Never rejects: a failure is shown, not thrown. Resolves once the operation is over -- without
	 * waiting for the error notification, which can sit unanswered in the notification center. */
	async run(
		title: string,
		op: (ctx: OperationContext) => Promise<void>,
		onSuccess: () => void,
		options: OperationOptions = {},
		noVerify = false
	): Promise<void> {
		const hookPath =
			options.hook && !noVerify ? await this.gitService.getHookPath(options.hook).catch(() => undefined) : undefined;
		const started = Date.now();
		this.output.appendLine(
			`▶ ${title}${hookPath ? ` (runs the ${options.hook} hook: ${hookPath})` : ''}${noVerify ? ' (hooks skipped)' : ''}`
		);
		try {
			// With a hook to wait on, the title drops its "…" since the message after it says what's
			// happening: "Pushing alice/x: running pre-push checks…", then the hook's latest line.
			await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: hookPath ? title.replace(/…$/, '') : title },
				async progress => {
					if (hookPath) {
						progress.report({ message: `running ${options.hook} checks…` });
					}
					const lines = new LineBuffer(line => {
						this.output.appendLine(`  ${line}`);
						if (hookPath) {
							progress.report({ message: line.length > 100 ? `${line.slice(0, 97)}...` : line });
						}
					});
					try {
						await op({ noVerify, onOutput: text => lines.push(text) });
					} finally {
						lines.flush();
					}
				}
			);
			this.output.appendLine(`✓ ${title} done in ${formatDuration(Date.now() - started)}`);
			onSuccess();
			this.afterSuccess();
		} catch (err) {
			const message = (err as Error).message;
			this.output.appendLine(`✗ ${title} failed after ${formatDuration(Date.now() - started)}:`);
			this.output.appendLine(indent(stripAnsi(message)));
			if (hookPath && options.hook && isPushBlockedByHook(message)) {
				const action = options.action ?? 'Push';
				showHookFailure(parseHookFailure(message, options.hook), action, {
					retry: () => this.run(title, op, onSuccess, options),
					skipHooks: () => this.run(title, op, onSuccess, options, true),
				});
				return;
			}
			void vscode.window.showErrorMessage(`GGit: ${stripAnsi(message).trim()}`, SHOW_OUTPUT).then(choice => {
				if (choice === SHOW_OUTPUT) {
					void vscode.commands.executeCommand('ggit.showOutput');
				}
			});
		}
	}
}

const SHOW_OUTPUT = 'Show Output';

/** The short form of a failure a hook caused: "Push blocked by the pre-push hook: tailwind failed."
 * with what to do next. The hook's whole output is already in the GGit output channel. Shared with
 * the Commit panel, which shows the same for pre-commit. */
export function showHookFailure(
	failure: HookFailure,
	action: string,
	handlers: { retry: () => unknown; skipHooks: () => unknown }
): void {
	const logPaths = failure.logPaths.filter(p => fs.existsSync(p));
	const RETRY = 'Retry';
	const SKIP = 'Skip Hooks…';
	const OPEN_LOG = logPaths.length > 1 ? 'Open Logs…' : 'Open Log';
	const buttons = [RETRY, SKIP, ...(logPaths.length > 0 ? [OPEN_LOG] : []), SHOW_OUTPUT];
	void vscode.window.showErrorMessage(`GGit: ${describeHookFailure(failure, action)}`, ...buttons).then(async choice => {
		switch (choice) {
			case RETRY:
				return handlers.retry();
			case SKIP:
				if (await confirmSkipHooks(failure, action)) {
					return handlers.skipHooks();
				}
				return;
			case OPEN_LOG:
				return openLog(logPaths);
			case SHOW_OUTPUT:
				return vscode.commands.executeCommand('ggit.showOutput');
		}
	});
}

/** Skipping hooks is for a check that failed on a fluke, or for a reason unrelated to the change --
 * worth a deliberate second click, not a button that runs straight away. */
async function confirmSkipHooks(failure: HookFailure, action: string): Promise<boolean> {
	const label = `${action} Without Hooks`;
	const checks = failure.failedSteps.length > 0 ? ` -- ${failure.failedSteps.join(', ')} included --` : '';
	const choice = await vscode.window.showWarningMessage(
		`${action} without running the ${failure.hook} hook?`,
		{
			modal: true,
			detail:
				`None of the hook's checks${checks} run for this ${action.toLowerCase()} (git's --no-verify). ` +
				"Use it when a check failed for a reason that has nothing to do with your change. If the project's CI runs the same checks, they still run there.",
		},
		label
	);
	return choice === label;
}

async function openLog(logPaths: string[]): Promise<void> {
	const logPath =
		logPaths.length === 1
			? logPaths[0]
			: await vscode.window.showQuickPick(logPaths, { placeHolder: 'Which log?', ignoreFocusOut: true });
	if (!logPath) {
		return;
	}
	try {
		await vscode.window.showTextDocument(vscode.Uri.file(logPath), { preview: false });
	} catch (err) {
		void vscode.window.showErrorMessage(`GGit: Couldn't open ${path.basename(logPath)}: ${(err as Error).message}`);
	}
}

function indent(text: string): string {
	return text
		.trimEnd()
		.split('\n')
		.map(line => `    ${line}`)
		.join('\n');
}

/** Turns output chunks, which split lines anywhere, into whole non-blank lines. */
class LineBuffer {
	private partial = '';

	constructor(private readonly onLine: (line: string) => void) {}

	push(text: string): void {
		const lines = splitLines(this.partial + text);
		this.partial = lines.pop() ?? '';
		lines.forEach(line => this.emit(line));
	}

	flush(): void {
		this.emit(this.partial);
		this.partial = '';
	}

	private emit(line: string): void {
		if (line.trim()) {
			this.onLine(line.trimEnd());
		}
	}
}
