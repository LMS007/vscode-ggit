# Worktree support — full plan

## Goal

Turn today's read-only worktree *awareness* (Branches view colors a branch blue if it's checked
out elsewhere, and blocks checking it out here) into a first-class feature: a dedicated Worktrees
view, create/remove/prune, and the ability to switch what Working Copy/Branches/Stashes/Conflicts
are all pointed at.

## Already built (context, not part of this plan)

- `GitService.listWorktrees()` — parses `git worktree list --porcelain` into `{ path, branch,
  isCurrent }[]`. Currently an inline object type in `gitService.ts`, not exported from
  `types.ts`.
- `GitService.getBranchWorktreeOwners()` (private) — maps branch name -> owning worktree path,
  excluding whichever worktree is current.
- `BranchInfo.worktreePath` — set on `listLocalBranches()`'s output when a branch is checked out
  in another worktree.
- Branches view: blue (`charts.blue`) + worktree folder name in `description` for those branches
  (`branchesTreeProvider.ts`); `contextValue: 'branch-other-worktree'` greys out Delete
  (`package.json`'s `enablement`) — verified git actually refuses that delete, and separately
  verified it does *not* refuse a Rename, so Rename is left enabled.
- `GitService.checkoutBranch()` guards itself: live-checks worktree ownership right before
  calling `git checkout`, throws a friendly error instead of letting git's raw "already used by
  worktree at ..." message surface. Verified (in a throwaway repo) that letting this through
  anyway, via `--ignore-other-worktrees`, can *silently drop a commit* the moment the other
  worktree next commits — so this stays a hard block, not something with a quiet bypass.
- `.git`-dir `FileSystemWatcher` glob extended with `worktrees/**` so another worktree
  adding/removing itself, or switching its own branch, triggers `refreshAll()`.

Researched Tower's own worktree UI for a design precedent (see chat, 2026-09-20): sidebar
"Worktrees" section, double-click a worktree or a branch backed by one to switch, "+" badge on
branch rows. Its "Add Worktree" dialog validates the picked revision live and disables the
primary button with an inline warning the moment it's already checked out elsewhere, only
allowing it via a collapsed, unchecked-by-default "Force" option with honest warning copy. That's
the pattern to copy for Phase 2 below, rather than a silent allow or a dead-end block.

## Scope decision: GGit-internal switch first, not a full VS Code workspace switch

Switching "the active worktree" can mean two different things:

1. **GGit-internal** — repoint `GitService` at the new path and `refreshAll()`. Working Copy,
   Branches' "active" highlighting, Stashes, Conflicts all start reflecting the new worktree.
   Diffs still open real files by absolute path, so that part works regardless. VS Code's own
   Explorer/editor/terminal keep showing whatever folder was originally opened.
2. **Full switch** — also call `vscode.workspace.updateWorkspaceFolders()` so Explorer/terminal
   follow too. Matches what people intuitively expect "switch worktree" to feel like, at the cost
   of a reload-ish disruption and a bunch of edge cases (unsaved editors open on the old folder's
   files, multi-root workspace semantics, etc).

**Plan: build (1) as the real feature, leave (2) out of scope for now** and just call it out
explicitly wherever it'd be relevant (e.g. a note in the switch confirmation, or a separate
"Reveal in Explorer" / "Open in New Window" affordance instead of trying to move the existing
window's root). Revisit (2) only if using GGit without Explorer/terminal following turns out to
be too disorienting in practice.

## Phase 1 — Data model + a read-only Worktrees view

**GitService / types**
- Promote the inline `{ path, branch, isCurrent }` return type into an exported `WorktreeInfo` in
  `src/git/types.ts`:
  ```ts
  export interface WorktreeInfo {
  	path: string;
  	branch?: string; // undefined = detached HEAD
  	isCurrent: boolean;
  	locked?: boolean;
  	prunable?: boolean;
  }
  ```
- `listWorktrees()` also needs to parse the porcelain output's `locked` / `prunable` lines (not
  currently handled — today's parser only reads `worktree` / `branch`). Verify the exact line
  format (`locked [<reason>]`, `prunable [<reason>]`) against real `git worktree list --porcelain`
  output before trusting it, same as the `worktree`/`branch`/blank-line format was verified this
  session.

**New view**
- `src/tree/worktreesTreeProvider.ts` — flat list (no folders needed; worktree paths aren't
  slash-namespaced like branches), one row per `WorktreeInfo`:
  - Label: last path segment (`path.basename`).
  - Description: branch name, or `(detached @ <short-sha>)`.
  - Icon: distinct from the branch-folder icon — e.g. `$(folder-library)` or similar, colored via
    the same `charts.green`/`charts.blue`-style trick for `isCurrent`.
  - `contextValue`: `worktree-current` vs `worktree-other`, `+locked` suffix if locked — mirrors
    the `branch-head` / `branch-other-worktree` convention already used in Branches.
  - Tooltip: full path, plus locked/prunable reason if present.
- `package.json`: new view `ggitWorktrees` under the `ggit` container. Placement: right after
  `ggitBranches` — worktrees are a peer concept to branches, not a Working-Copy-adjacent thing.
- Wire into `extension.ts` exactly like the other tree views (provider, `createTreeView`, push to
  subscriptions, add to `refreshAll()`, add to the `.git`-dir watcher's existing `worktrees/**`
  coverage — no watcher changes needed here, already done).

This phase alone (list + visibility) is useful on its own and low-risk — good place to stop and
sanity-check before building the riskier mutation commands.

## Phase 2 — Create Worktree

**GitService**
```ts
async addWorktree(
	destPath: string,
	options: { branch?: string; newBranch?: string; startPoint?: string; detach?: boolean; force?: boolean }
): Promise<void>
```
Maps onto `git worktree add [--force] [--detach] <path> [<branch-or-commit>]` /
`git worktree add [-b <newBranch>] <path> <startPoint>`. Exact flag combinations to nail down
against real `git worktree add --help` before implementing — don't guess the mutually-exclusive
option combinations (e.g. `-b` and `--detach` don't make sense together).

**UI — mirrors Tower's dialog, not a plain input box**

A small custom form (same pattern as `CreateBranchPanel`/`CommitPanel` — a `WebviewPanel`, not an
`InputBox` chain), since this needs live validation, not just sequential prompts:
- Revision/branch picker (reuse the same QuickPick-style branch list Create Branch already has,
  or a text field with autocomplete — decide based on how much of `createBranchPanel.ts` can be
  reused directly).
- Destination folder (default to a sibling-of-repoRoot `../../wt/<branch-name>`-style suggestion,
  or remember the last-used parent folder — decide with the user; no strong precedent in GGit
  today since nothing else picks a filesystem destination).
- New-branch-vs-existing-branch-vs-detached mode (radio-style, matching Tower's Revision +
  Detach checkbox).
- **Live validation**: on every revision change, call `getBranchWorktreeOwners()` (already
  exists) and show an inline warning + disable the primary button exactly like Tower's dialog,
  the moment the picked branch resolves to one already checked out elsewhere.
- **Force**: collapsed/secondary, unchecked by default, only enabled/relevant once the warning is
  showing — same gating Tower uses. Label it with the same kind of explicit, honest copy ("even
  though it's already checked out in another worktree") rather than a bare "Force" checkbox with
  no context.

## Phase 3 — Remove / Prune

**GitService**
- `removeWorktree(path: string, force = false): Promise<void>` — `git worktree remove [--force]
  <path>`. Git itself refuses removal if the worktree has uncommitted changes unless forced —
  verify the exact refusal message so the error surfaces cleanly (same treatment as the
  not-fully-merged branch-delete escalation in `gitActions.ts`'s `deleteLocalBranch`), rather than
  a raw git error.
- `pruneWorktrees(): Promise<void>` — `git worktree prune`. Cleans up administrative entries for
  worktree directories that were deleted by hand outside of git (rare, but the porcelain output's
  `prunable` flag from Phase 1 is exactly what surfaces this state, so the two land together
  naturally).

**UI**
- Right-click a worktree row → "Remove Worktree…" (confirm; escalate to a force confirmation the
  same two-step way `deleteLocalBranch` does), "Reveal in Finder"/"Open in Terminal" (nice-to-have,
  matches what you'd expect once there's a location to point at).
- A "prunable" worktree row gets a distinct (dimmed / warning-icon) treatment, with a "Prune"
  toolbar button on the Worktrees view (same convention as Refresh elsewhere).
- Can't remove the current worktree (the one GGit itself is pointed at) — grey out, same
  `enablement` pattern as `branch-head`.

## Phase 4 — Switch Active Worktree (the actual "GGit-internal" pivot)

**GitService**
- Drop `readonly` from the `repoRoot` constructor param.
- Add:
  ```ts
  async setActiveWorktree(newRoot: string): Promise<void> {
  	await this.git.cwd(newRoot);
  	this.repoRoot = newRoot;
  	this.gitDirPath = undefined; // cached in getGitDir() — must be re-derived for the new worktree
  }
  ```
  Verified `simple-git` supports `.cwd(directory)` to repoint an existing instance at runtime
  (`node_modules/simple-git/dist/typings/simple-git.d.ts`) — this keeps the single long-lived
  `GitService` instance (and the `unsafe.allowUnsafeEditor` config already threaded through it)
  intact, so every tree provider / panel that captured a reference to it in `extension.ts` keeps
  working with zero changes on their end. Reconstructing a brand-new `GitService`/`SimpleGit`
  instead would mean re-wiring every provider's constructor — avoid that.

**extension.ts**
- New command `ggit.switchWorktree` → QuickPick over `listWorktrees()` (excluding current) →
  `gitService.setActiveWorktree(picked.path)` → `refreshAll()`.
- Double-clicking a Worktrees-view row calls this too (same double-click-guard convention already
  used for branches, `createDoubleClickGuard()`).
- **The `.git`-dir watcher's base path needs to move with the active worktree.** Today it's
  hardcoded to `vscode.Uri.joinPath(workspaceFolder.uri, '.git')`, which assumes `.git` is a
  directory at the workspace root — true for the main checkout, **false** for a linked worktree
  (its `.git` is a plain pointer *file*: `gitdir: /main/.git/worktrees/<name>`). On switch, dispose
  the old watcher and recreate it against `await gitService.getGitDir()` (needs `getGitDir()` made
  `public`, it's currently `private`) rather than the workspace-folder join. This is the concrete
  gotcha flagged in the earlier design discussion — don't skip it, a stale watcher pointed at the
  wrong worktree's `.git` would silently stop reacting to anything.
- `updateActiveBranchLabel()` / `branchesView.description` (workspace folder name) should switch
  to reflecting the *active worktree's* folder name instead of the static `workspaceFolder.name`
  it uses today, once this exists — otherwise the Branches header would keep showing the original
  folder forever regardless of which worktree is actually active.
- Cross-link with the existing guard: the blocked-checkout error message ("already checked out in
  another worktree at ...") is a natural place to add a follow-up action — e.g. the error
  notification's button set could include "Switch to that Worktree", calling straight into
  `ggit.switchWorktree` pre-seeded with that path, instead of just naming it.

## Phase 5 (stretch, only if Phase 4 in practice feels wrong without it)

Actually move VS Code's own workspace folder via `vscode.workspace.updateWorkspaceFolders()` so
Explorer/terminal follow. Treat as a separate, later decision — see "Scope decision" above.

## Open questions to resolve before/while building (not answered by this plan)

- Exact destination-folder convention for Create Worktree — sibling `../wt/<name>` (what we used
  for manual testing), a fixed configurable root, or always prompt. No existing GGit convention to
  copy since nothing else picks a filesystem path today.
- Whether `ggit.rebase`'s "current branch" framing needs any adjustment once "current branch"
  can mean "current branch of the active worktree" rather than always the one VS Code opened on —
  likely fine as-is since it already goes through `getCurrentBranch()`, just worth a sanity check
  once Phase 4 lands.
- Lock/unlock worktrees (`git worktree lock`/`unlock`) — not scoped above; add only if it comes up
  in practice (e.g. protecting a worktree on removable/network media from `prune`).
