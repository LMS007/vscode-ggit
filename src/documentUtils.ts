import * as vscode from 'vscode';

/** Resolving a conflict by hand in an open editor doesn't put the fix on disk until it's saved, and
 * `git add` (what marking a conflict resolved actually does) only ever sees disk content -- an
 * unsaved editor would silently stage the still-conflicted version. Saves it first if it's open and
 * dirty, so marking a file resolved always stages what's actually on screen. */
export async function saveOpenDocumentIfDirty(absPath: string): Promise<void> {
	const doc = vscode.workspace.textDocuments.find(d => d.uri.scheme === 'file' && d.uri.fsPath === absPath);
	if (doc?.isDirty) {
		await doc.save();
	}
}
