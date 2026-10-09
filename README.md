# GGit

A git UI for VS Code: Working Copy, Branches, Remotes, Tags, and Stashes in the sidebar, plus a
branch-history panel with search.

<img width="1288" height="763" alt="image" src="https://github.com/user-attachments/assets/f549b393-6697-40cf-9e44-3b67844eba92" />

## Install

GGit isn't on the Marketplace. Install it from a `.vsix` on the
[Releases page](https://github.com/LMS007/vscode-ggit/releases).

1. Open the [latest release](https://github.com/LMS007/vscode-ggit/releases/latest) and, under
   **Assets**, download `vscode-ggit-<version>.vsix`.
   (Or: `gh release download -R LMS007/vscode-ggit -p '*.vsix'`.)
2. Install it, either way:
   - **In VS Code:** Extensions view → `...` menu → **Install from VSIX...** → pick the file.
   - **From a terminal:** `code --install-extension vscode-ggit-<version>.vsix`
3. Command Palette → **Developer: Reload Window**.

To update, install the newer `.vsix` the same way. It replaces the old version.

**Remote hosts (SSH, WSL, Codespaces):** from a terminal on your *local* machine, run
`code --remote ssh-remote+<host> --install-extension /local/path/to/vscode-ggit-<version>.vsix`.
If the file is already on the remote, run `code --install-extension <path>` from the remote
window's integrated terminal instead.

**`code` not found?** Command Palette → **Shell Command: Install 'code' command in PATH**.

**Build it yourself:** `npm install && npx vsce package` writes the `.vsix` to the project root.

## Features

**Working Copy**
- Checkbox stages/unstages. A partly staged file shows as two rows, `(staged)` and `(unstaged)`.
- Pinned **Create Commit** row: check/uncheck all, staged count, click to open the Commit panel.
- Click a file for a diff. Right-click: Discard, Stash Selected Files, Show File History, Ignore
  (item / name / extension), Copy Path, Reveal.
- Auto-refreshes on file and repo changes.

**Diffs**: **Stage Hunk** / **Unstage Hunk** from the diff's toolbar or context menu, for the
selection or the hunk under the cursor.

**Commit panel**: summary, description, Amend, staged-file checkboxes. The draft survives closing
the panel and reloading the window.

**Branches**
- `/`-named branches group into folders. Ahead/behind shows as `↑N`/`↓N`.
- Recently checked-out branches are pinned at the top (set how many with the thumbtack button).
- Green = checked out here. Blue = checked out in another `git worktree`.
- **Merge:** drag a branch onto the current one. Fast-forward, merge commit, `--no-ff`, squash, or
  `--no-commit`.
- Right-click: Create Branch / Create Tag from Here, Rename, Copy Name, Delete.
- Toolbar: Create Branch, Fetch, Pull, Push, Sync, Rebase (`--autostash`).

**Remotes**: browse and check out remote branches, live search, Add Remote, Remove Remote
(right-click a remote), Delete Remote Branch.
**Sync** fetches every remote: downloads new branches and removes ones deleted on the remote.

**Tags**: green = on a remote, purple = local only, orange = differs from the remote, cloud icon =
not downloaded yet. Labels only call out what's off (`≠ upstream`, `not on upstream`, `local only`,
`not downloaded`); hover for each remote's status. Publish, Push, Delete (optionally on one remote
or all of them), Copy Name. Click a tag to open its history. **Download New Tags** fetches tags
from every remote; it never deletes or overwrites a local tag. Pull and Sync download new tags too.

**Stashes**: apply or delete (multi-select). Stashes with untracked files show correctly.

**Conflicts**: appears during a rebase, merge, cherry-pick, or revert. Click a file to resolve it
inline, check it off, then Continue/Commit, Skip, or Abort.

**History panel**
- Per-branch commit log, loaded a page at a time. Unpushed commits are green. Double-click a commit
  for its full message.
- Search by author or message. **Show File History** (Working Copy right-click) narrows the log to
  one file and follows renames.
- Toolbar: Create Branch, Fetch, Pull, Push (offers a force push if rejected), Sync, Refresh,
  Rebase, Apply/Save Stash, Commit. A remote picker appears when there's more than one remote.
- Right-click a commit: Reset Branch to Here (Mixed/Hard), Cherry-Pick, Revert, Save Patch, Copy
  Commit Hash.
- Arrow keys and Page Up/Down to navigate.

**Activity bar badge**: live count of changed files.

## Requirements

- `git` on your `PATH`.
- A single-root workspace inside a git repo. Multi-root workspaces aren't supported.

## Not implemented yet

- Creating or switching to a `git worktree`. Branches shows worktrees but can't manage them.
- Interactive rebase (reorder, squash, reword, drop).
- Discard Hunk.
- Credential/SSH management. GGit uses whatever already works from your terminal.

## Development

- `npm run watch`: type checker + esbuild in watch mode. `F5` launches an Extension Development
  Host.
- `npm run check-types` / `npm run lint`: the same checks packaging runs.
- **Releasing:** bump `version` in `package.json` and push to `main`. The
  [Release workflow](.github/workflows/release.yml) builds the `.vsix`, tags `v<version>`, and
  publishes a GitHub Release. A `VSCE_PAT` repository secret also publishes to the Marketplace.
- The Commit-launcher sidebar section (`src/commit/commitLauncherView.ts`) is built but hidden
  (`"when": "false"` in `package.json`) pending a better design.
