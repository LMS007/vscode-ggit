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

**New repository**: in a folder that isn't a git repo yet, Working Copy offers **Initialize
Repository Here** or **Create in New Subfolder…** (then offers to open that folder, since GGit
works on the open folder). The first branch is `main` unless `init.defaultBranch` says otherwise.

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
- Right-click: Create Branch / Create Tag from Here, Rebase Current Branch onto This, Rename, Copy
  Name, Set Upstream Branch, Delete. A branch checked out in another worktree can't be deleted, so
  it offers **Remove Worktree…** instead: it deletes that worktree's folder (warning first if it has
  uncommitted changes), optionally deletes the branch too, and handles locked worktrees and ones
  whose folder is already gone.
- Toolbar: Create Branch, Fetch, Pull, Push, Sync, Rebase. The `...` menu has
  **Push Branches…**: pick several published branches and push them in one `git push` per remote,
  so the pre-push hook runs once.
- Pull and Sync check the upstream first. A feature branch tracking `origin/main` (what
  `git checkout -b alice/feature-x origin/main` sets up) gets asked before pulling it, and offered
  its own remote branch instead.
- **Force push:** when a branch and its remote branch have diverged (after a rebase, say), Push asks
  to force push straight away, without first trying a push that's bound to fail. The confirmation
  lists the remote commits that would be overwritten. The push only goes through if the remote is
  still at that commit (`--force-with-lease=<ref>:<sha>`), so a fetch in the background can't turn
  the lease into a blind overwrite.
- **Rebase tab:** pick what to rebase onto (a local or remote branch), and which commits to replay:
  every commit not on it, or **only the commits after** a branch or commit (`--onto`), for a branch
  whose parent was squash-merged. Type the cut point or pick one of the branches underneath. A live
  preview lists the commits that will be replayed and, with a cut point, the ones left out. When a
  branch underneath has no remote branch any more (likely merged), it suggests cutting after it. Branches stacked under the current one can move along
  (`--update-refs`, git 2.38+), and afterwards it offers to push them all together. Uncommitted
  changes are autostashed.

**Remotes**: browse and check out remote branches, live search, Add Remote, Edit Remote and
Remove Remote (right-click a remote; Edit shows and changes its name, URL, and push URL), Delete
Remote Branch, Rebase Current Branch onto This.
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
- Toolbar: Create Branch, Fetch, Pull, Push, Sync, Refresh, Rebase, Apply/Save Stash, Commit.
  Push turns orange and reads **Force Push…** once the branch has diverged from its remote branch.
  A remote picker appears when there's more than one remote.
- Right-click a commit: Reset Branch to Here (Mixed/Hard), Cherry-Pick, Revert, Save Patch, Copy
  Commit Hash.
- Arrow keys and Page Up/Down to navigate.

**Git hooks**: push and commit run the repo's hooks, husky's included. While a pre-push hook runs,
its latest output line shows in the progress notification. When a hook stops a push or commit, the
error is one line, e.g. "Push blocked by the pre-push hook: tailwind failed.", with **Retry**,
**Skip Hooks…** (`--no-verify`, after a confirmation), **Open Log** (when the hook printed a
`(full log: <path>)` line or any absolute `.log` path), and **Show Output**.

**Output**: View > Output > **GGit** (or **GGit: Show Output**) logs every push, fetch, pull,
commit, rebase, merge and checkout with how long it took, any hook output, and full errors.

**Dependencies**: when the checked-out commit changes (a checkout, pull, rebase or merge, from GGit
or the terminal) and brings a different `pnpm-lock.yaml`, `package-lock.json`, `yarn.lock` or
`bun.lock` at the repo root, GGit offers to run the install in a terminal. It stays quiet when
`node_modules` is already newer than the lockfile. Turn it off with
`ggit.suggestInstallOnLockfileChange`.

**Activity bar badge**: live count of changed files.

## Requirements

- `git` on your `PATH`.
- A single-root workspace inside a git repo. Multi-root workspaces aren't supported.

## Not implemented yet

- Creating or switching to a `git worktree`. Branches shows worktrees and can remove one, nothing more.
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
