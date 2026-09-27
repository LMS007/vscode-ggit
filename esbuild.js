const esbuild = require("esbuild");

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
	name: 'esbuild-problem-matcher',

	setup(build) {
		build.onStart(() => {
			console.log('[watch] build started');
		});
		build.onEnd((result) => {
			result.errors.forEach(({ text, location }) => {
				console.error(`✘ [ERROR] ${text}`);
				console.error(`    ${location.file}:${location.line}:${location.column}:`);
			});
			console.log('[watch] build finished');
		});
	},
};

async function main() {
	const extensionCtx = await esbuild.context({
		entryPoints: [
			'src/extension.ts'
		],
		bundle: true,
		format: 'cjs',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'node',
		outfile: 'dist/extension.js',
		external: ['vscode'],
		logLevel: 'silent',
		plugins: [
			/* add to the end of plugins array */
			esbuildProblemMatcherPlugin,
		],
	});

	// The branch-history webview runs in a browser context (no Node/vscode APIs),
	// so it needs its own bundle separate from the extension-host entry point above.
	const webviewCtx = await esbuild.context({
		entryPoints: [
			'src/history/webview/main.ts'
		],
		bundle: true,
		format: 'iife',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'browser',
		outfile: 'dist/webview.js',
		logLevel: 'silent',
		plugins: [
			esbuildProblemMatcherPlugin,
		],
	});

	// The commit-files companion panel is a second, independent webview (files list only,
	// no commit browser), so it gets its own bundle rather than sharing the history one.
	const commitFilesWebviewCtx = await esbuild.context({
		entryPoints: [
			'src/history/commitFilesWebview/main.ts'
		],
		bundle: true,
		format: 'iife',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'browser',
		outfile: 'dist/commitFilesWebview.js',
		logLevel: 'silent',
		plugins: [
			esbuildProblemMatcherPlugin,
		],
	});

	// The create-branch form is a third, independent webview (a simple form, no commit browser),
	// so it gets its own bundle rather than sharing the history one.
	const createBranchWebviewCtx = await esbuild.context({
		entryPoints: [
			'src/branch/createBranchWebview/main.ts'
		],
		bundle: true,
		format: 'iife',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'browser',
		outfile: 'dist/createBranchWebview.js',
		logLevel: 'silent',
		plugins: [
			esbuildProblemMatcherPlugin,
		],
	});

	// The commit form is a fourth, independent webview (subject/body/amend + a staged-files preview),
	// so it gets its own bundle rather than sharing another panel's.
	const commitWebviewCtx = await esbuild.context({
		entryPoints: [
			'src/commit/commitWebview/main.ts'
		],
		bundle: true,
		format: 'iife',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'browser',
		outfile: 'dist/commitWebview.js',
		logLevel: 'silent',
		plugins: [
			esbuildProblemMatcherPlugin,
		],
	});

	// The add-remote form is a fifth, independent webview (a simple form, no commit browser), so it
	// gets its own bundle rather than sharing another panel's.
	const addRemoteWebviewCtx = await esbuild.context({
		entryPoints: [
			'src/remote/addRemoteWebview/main.ts'
		],
		bundle: true,
		format: 'iife',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'browser',
		outfile: 'dist/addRemoteWebview.js',
		logLevel: 'silent',
		plugins: [
			esbuildProblemMatcherPlugin,
		],
	});

	// The rebase-conflicts tab is a sixth, independent webview (a paused-commit file checklist, no
	// commit browser), so it gets its own bundle rather than sharing another panel's.
	const rebaseWebviewCtx = await esbuild.context({
		entryPoints: [
			'src/rebase/rebaseWebview/main.ts'
		],
		bundle: true,
		format: 'iife',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'browser',
		outfile: 'dist/rebaseWebview.js',
		logLevel: 'silent',
		plugins: [
			esbuildProblemMatcherPlugin,
		],
	});

	const contexts = [
		extensionCtx,
		webviewCtx,
		commitFilesWebviewCtx,
		createBranchWebviewCtx,
		commitWebviewCtx,
		addRemoteWebviewCtx,
		rebaseWebviewCtx,
	];

	if (watch) {
		await Promise.all(contexts.map(ctx => ctx.watch()));
	} else {
		await Promise.all(contexts.map(ctx => ctx.rebuild()));
		await Promise.all(contexts.map(ctx => ctx.dispose()));
	}
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
