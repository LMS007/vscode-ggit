# GGit

A git UI for VS Code — Working Copy, Branches, Remotes, and Stashes in the sidebar,
plus a dedicated branch-history panel with search. Personal project, not on the Marketplace —
install from a locally-built `.vsix` (see **Installing** below).

## Installing

**Prerequisites:** Node.js + npm, and the `code` CLI on your `PATH` (see below if `code
--version` fails).

1. `npm install`
2. `npx vsce package` — produces `vscode-ggit-<version>.vsix` in the project root.
3. Install it:
   - **Locally:** `code --install-extension vscode-ggit-<version>.vsix`, or in VS Code:
     Extensions view → `...` menu → **Install from VSIX...**.
   - **On a remote host** (SSH, Codespaces, WSL): from a terminal on your *local* machine (not
     inside the remote window) —
     `code --remote ssh-remote+<host> --install-extension /local/path/to/vscode-ggit-<version>.vsix`.
     This uploads and installs in one step. If you'd rather copy the file over yourself first
     (`scp`), run the plain `code --install-extension <path-on-remote>` from the integrated
     terminal *inside* the already-open remote VS Code window instead.
4. Reload the window (Command Palette → **Developer: Reload Window**).

Reinstalling after a change is the same three steps — VS Code replaces the previous version in
place.

### Getting the `code` CLI on your PATH

Needed to run the install commands above.

- **Easiest:** in VS Code, Command Palette → **Shell Command: Install 'code' command in PATH**.
- **Manual (macOS):** `ln -s "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" ~/.local/bin/code`
  (or any other directory already on your `PATH`).

Verify with `which code` / `code --version` afterward.

## Features

**Working Copy**
- Staged/unstaged file list; checkbox stages/unstages directly. A file with *both* staged and
  unstaged changes (e.g. after staging one hunk) shows as two rows, tagged `(staged)`/`(unstaged)`.
- Pinned "Create Commit" row: check-all/uncheck-all toggle, staged-file count, click to open the
  Commit panel.
- Toolbar: Apply Stash, Save Stash, Refresh.
- Discard Local Changes, with confirmation wording tailored to what's actually happening
  (delete/restore/revert). Multi-select for stash or discard.
- Click a file for a diff; hover for "Open File". Right-click for **Ignore** (This Item / By
  Name / By Extension — adds to `.gitignore`), Reveal in Explorer View, Reveal in Finder.
- Auto-refreshes on file save/delete and on external changes to tracked files (not just git
  operations).

**Diffs** — right-click (or use the toolbar icon) inside a diff to **Stage Hunk** / **Unstage
Hunk** — works on the selected range, or the hunk under the cursor.

**Commit panel** — summary, optional description, Amend (pre-fills the last commit's message),
live staged-file list with its own checkboxes and check-all/uncheck-all. Shows the branch you're
committing to. Draft text persists across closing/reopening the panel or reloading the window.

**Branches**
- `/`-named branches group into folders; the folder holding your current branch expands
  automatically.
- Ahead/behind shown as `↑N`/`↓N`.
- Green = checked out here. Blue = checked out in another `git worktree`, with that worktree's
  folder name shown — GGit blocks checking these out, same as git itself.
- Right-click: Create Branch From Here, Rename, Copy Name, Delete.

**Remotes** — browse and check out remote branches (folder-grouped). Search icon filters the list
live, case-insensitive.

**Stashes** — list, apply, delete (multi-select, oldest-first); shows files from
`--include-untracked` stashes correctly.

**Conflicts** — appears above Working Copy during a rebase. Click a file to resolve inline; check
it off once done. Continue/Skip/Abort in the toolbar.

**Rebase** — pick a branch to rebase the current one onto; `--autostash` always on.

**History panel**
- Per-branch commit log, loaded a page at a time (not the whole history up front) — scroll to load
  more.
- Search bar: filters loaded commits by author name/email or message, case-insensitive. Loads at
  least 1000 commits on first use; "Search older commits" goes deeper on demand, capped at 5000.
- Toolbar: Create Branch, Fetch, Pull, Push (turns green when there's something to push), Sync,
  Refresh, Rebase, Apply/Save Stash, Commit.
- File list: click for a diff, or the open-file icon to edit the current working-tree copy
  directly.
- Arrow keys / Page Up/Down to navigate; selection follows the newest commit when the panel opens
  or is brought to front, stays put on background refreshes.
- Right-click a commit: Reset Branch to Here (Mixed/Hard), Cherry-Pick, Save Patch.

**Activity bar badge** — live count of changed files, kept current from startup.

## Requirements

- `git` on your `PATH`.
- A single-root workspace rooted at (or inside) a git repo. Multi-root workspaces aren't
  supported.

## Known limitations / not implemented yet

- **No git worktree switching** — Branches is worktree-*aware* (see above) but there's no UI to
  create one or switch Working Copy to a different one.
- **Only one History tab** at a time.
- **No interactive rebase** — always plain/non-interactive; no reorder/squash/reword/drop.
- **No plain merge** — only rebase; Conflicts only appears for a rebase in progress.
- **No Discard Hunk** — Stage/Unstage Hunk exist, but not a destructive per-hunk revert.
- **No tags.**
- **No credential/SSH management** — relies on whatever already works from your terminal.
- Search doesn't cover file paths or diff content, only author/message.
- The Commit-launcher sidebar section (a big button above Working Copy) is implemented but
  disabled pending a better design — see `src/commit/commitLauncherView.ts` and
  `ggitCommitLauncher`'s `"when": "false"` in `package.json`.

## Development

- `npm run watch` — type checker + esbuild in watch mode.
- `F5` launches an Extension Development Host with GGit loaded from source.
- `npm run check-types` / `npm run lint` — same checks packaging runs.
