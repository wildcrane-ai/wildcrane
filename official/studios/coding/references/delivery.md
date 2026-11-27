# Software delivery

- **Autonomy**: Follow `akb guide implement`.
- **Approved UI previews**: Check desktop and mobile against the approved mockups for an exact match on the task's intended UI changes. Use the current target branch for the surrounding UI.
- **Approved API previews**: Implement every approved endpoint and document it.
- **Approved database previews**: Write migrations that match the approved structure.
- **Worktree**: Use the supplied delivery branch and worktree. For local runs, create a separate branch and worktree.
  - **No git** (not a repository, or no commit yet): copy the project to `.akb/worktrees/<id>/work` and keep an untouched copy at `.akb/worktrees/<id>/base`, skipping `.akb`, `.git`, dependencies and build output; install or link dependencies as needed.
- **Merge**: Commit this task's changes. Before merging them into the target branch, compare target changes since the task branch base with the task diff and approved intent. Resolve Git conflicts and check the combined changes for overwritten, broken, or duplicated behavior, or restored removals, including in files changed on only one side. Apply the target branch rule in `akb guide implement`.
  - **No git**: for each file that differs between work and base, write or delete it in the project if the project's copy still matches base, otherwise merge both sides' edits; ask the user when they cannot merge. First back up each original you overwrite or delete to `.akb/backups/<id>/` under its relative path. Touch no other file.
- **Completion**: Verify the task's commit is on the target branch and record the full commit and branch on the task. Preserve the task branch until the archive synchronizes so the Runner can verify the Git result. Follow `akb guide archive`.
  - **No Git**: Run checks on the project and archive the task after applying its files.
- **Checks**: Run affected tests and repository-required checks on the combined changes. Rerun affected checks when conflict fixes or newer target changes alter the code.
