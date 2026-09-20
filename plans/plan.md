# Feature gaps

High-level list of the biggest missing features in GGit today (excludes worktrees — see
[worktree-plan.md](worktree-plan.md) — and excludes test coverage).

1. **Interactive rebase.** Rebase today is a flat, non-interactive replay onto another branch
   only — no squash, reword, fixup, reorder, or drop. This is the one that actively collides with
   real day-to-day usage (cleaning up commits before opening/updating a PR).

2. **Hunk/line-level staging.** Staging is whole-file only. Splitting one file's changes across
   multiple commits currently means dropping back to the terminal or VS Code's built-in Source
   Control view — a real regression against the tool GGit is meant to replace.

3. **Merge support.** No "merge branch into current" action exists at all — only rebase is
   wired up. Tower's drag-and-drop (drag one branch onto another to merge) is a good interaction
   model to copy; VS Code's TreeView API supports drag-and-drop natively, so this is a UI/GitService
   gap, not a platform limitation.

4. **Commit graph / unified history view.** History is a flat, one-branch-at-a-time log — no
   visual branch/merge topology. Lower priority than it first seems: a look at Tower's own
   "all branches" graph view shows it gets hard to read fast in a busy, multi-branch repo, so a
   narrower default (current branch + maybe its target) would matter more than a full,
   always-on graph.
