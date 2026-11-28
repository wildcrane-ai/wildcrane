# Software landing

- For a project copy, compare work with base. Apply only changed paths. Back up originals to `.akb/backups/<id>/<relative-path>` before overwriting or deleting them and preserve existing backups on retry. Merge concurrent edits and ask about unresolved conflicts.
- For a Git worktree, verify the Implement commit on the saved task branch. Compare both branches from the saved base against the approved intent before merging. Resolve conflicts using the target branch rule in `akb guide implement`. Review both diffs and the merged result for lost changes, regressions, duplication and restored removals.
- For in-place Git delivery, verify the saved commit on the target branch. Record the full commit and branch for every Git delivery. Keep any saved task branch until the archive synchronizes.
- Read the saved Implement checks and reuse passing results that still apply. If target changes, file application or conflict fixes invalidate a result, run the smallest checks covering the affected behavior.
- Record the outcome and follow `akb guide archive`.
