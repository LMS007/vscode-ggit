# GGit

A minimal, Tower-style git UI for VS Code — a custom sidebar (Working Copy, Branches, Remotes,
Stashes) plus a dedicated branch-history panel, built as a personal alternative to the built-in
Source Control view.

This is a personal project, not published to the Marketplace. It's installed locally from a
`.vsix` file — see **Installing** below.

## Features

**Working Copy**
- Flat staged/unstaged file list; the checkbox stages/unstages a file directly
- A pinned "Create Commit" row above the file list — a check-all/uncheck-all staging toggle on the
  left, the staged-file count on the right, click to open the Commit panel
- Apply Stash / Save Stash / Refresh, from the section's toolbar
- Discard Local Changes — deletes new files, restores deleted ones, reverts modified ones, with
  confirmation wording tailored to what's actually about to happen
- Multi-select right-click to stash or discard several files at once
- Click a file to open a left/right diff; hover for a one-click "Open File" action
- Auto-refreshes on file save/delete, not just on git operations

**Commit panel**
- A full panel (not a popup) for composing a commit: summary, an optional longer description, and
  an Amend checkbox that pre-fills the last commit's message
- Shows the branch you're committing to
- The file list here also has checkboxes — stage or unstage without leaving the panel — plus a
  check-all/uncheck-all shortcut and a live "+N -N" line summarizing what's staged
- The Commit button is disabled until there's a summary and something staged (Amend excepted)

**Branches**
- Branches with `/` in their name are grouped into folders (e.g. `alice/feature-x`); the
  folder holding your current branch is highlighted and expands automatically
- Ahead/behind counts shown as `↑N`/`↓N`
- Green = checked out here. Blue = checked out in another `git worktree` on disk, with that
  worktree's folder name shown alongside it — GGit refuses to check these out (same as git itself)
  since a branch can only live in one worktree at a time
- Right-click: Create New Branch from Here, Rename, Copy Branch Name, Delete (greyed out for the
  checked-out branch and for one checked out in another worktree; escalates to a force-delete
  confirmation only if git refuses a safe delete)

**Remotes** — browse and check out remote branches (also grouped into folders). The search icon in
its toolbar filters the list live as you type (case-insensitive, matches anywhere in the name).

**Stashes** — list, apply, and delete (multi-select bulk delete, oldest-first to avoid reflog
index shifts); correctly shows files from `--include-untracked` stashes.

**Conflicts** — appears automatically above Working Copy while a rebase is in progress. Lists
conflicted files; click one to open it (VS Code's built-in inline merge-conflict resolution just
works on a plain file open); check it off once resolved to mark it staged. Continue / Skip / Abort
buttons live in this section's toolbar.

**Rebase** — pick a branch to rebase the current one onto (local branches only); `--autostash` is
always on, so a dirty working tree never blocks starting a rebase.

**History panel** — per-branch commit log (commits only reachable via the branch's upstream are
shown dimmed, not hidden), a resizable file-list pane, and a custom toolbar (Create Branch, Fetch,
Pull, Push, Sync, Refresh, Rebase, Apply/Save Stash, Commit). Right-click a commit for Reset
Branch to Here (Mixed/Hard), Cherry-Pick, or Save Patch. Selection stays on the same commit across
a branch switch when possible.

**Activity bar badge** — shows the number of changed files in Working Copy, kept live via
`onStartupFinished` activation (not just when you first open the sidebar).

## Requirements

- `git` installed and available on your `PATH`.
- A single-root VS Code workspace whose root is (or is inside) a git repository. Multi-root
  workspaces aren't supported — GGit only looks at the first workspace folder.

## Known limitations / not implemented yet

- **No git worktree switching** — Branches is aware of other worktrees (blue branches, blocked
  checkout — see above) but there's still no UI for creating one, listing them as a first-class
  view, or switching Working Copy to a different one.
- **Only one History tab** — opening a different branch's history reuses the same tab rather than
  letting you keep several branches' histories open side by side.
- **No interactive rebase** — rebasing is always the plain, non-interactive kind; no
  reorder/squash/reword/drop UI.
- **No plain merge** — only rebase is wired up; there's no "Merge branch into current" action, and
  the Conflicts section only appears for a rebase in progress (not a merge).
- **No tags** — no view or actions for creating, listing, or pushing tags.
- **No credential/SSH management** — fetch/pull/push rely entirely on whatever git credential
  setup already works from your terminal.
- The Commit-launcher sidebar section (a big button above Working Copy) is implemented but
  currently disabled pending a better design — see `src/commit/commitLauncherView.ts` and the
  `ggitCommitLauncher` view's `"when": "false"` in `package.json` if picking it back up.

## Installing

GGit isn't published — build and install it from source as a `.vsix`:

```sh
npm install
npx vsce package
```

This produces `vscode-ggit-<version>.vsix` in the project root. Install it either from the
command line:

```sh
code --install-extension vscode-ggit-<version>.vsix
```

or from within VS Code: open the Extensions view, click the `...` menu in its top-right corner,
choose **Install from VSIX...**, and pick the file.

Reinstalling after a change just means repeating both steps — VS Code replaces the previous
version in place.

## Development

- `npm run watch` — runs the type checker and esbuild in watch mode.
- Press `F5` in VS Code to launch an Extension Development Host with GGit loaded from source
  (no packaging needed for day-to-day iteration).
- `npm run check-types` / `npm run lint` — the same checks CI-equivalent steps run before packaging.
