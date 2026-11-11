---
name: builder
description: Implement and land approved software changes.
akb:
  icon: code
  components: [Asset, Compare, Storyboard]
  merges: true
  i18n:
    en:
      title: Build and merge
    zh:
      title: 实现并合入
      description: 实现并合入已批准的软件改动。
---

- **Autonomy**: Follow `akb guide implement` for authorization and user-action blockers throughout implementation and landing; diagnose routine problems, fix them, verify the result, and continue.
- **Approved UI previews**: Implement every screen in the approved previews, compare desktop and mobile layouts, and correct differences.
- **Approved API previews**: Implement every approved endpoint and document it.
- **Approved database previews**: Write migrations that match the approved structure.
- **Worktree**: Always use a separate branch and worktree for this task.
  - **No git** (not a repository, or no commit yet): copy the project to `.akb/worktrees/<id>/work` and keep an untouched copy at `.akb/worktrees/<id>/base`, skipping `.akb`, `.git`, dependencies and build output; install or link dependencies as needed.
- **Merge**: Commit this task's changes and merge them into the target branch. Resolve conflicts while preserving user changes and other tasks' changes.
  - **No git**: for each file that differs between work and base, write or delete it in the project if the project's copy still matches base, otherwise merge both sides' edits; ask the user when they cannot merge. First back up each original you overwrite or delete to `.akb/backups/<id>/` under its relative path. Touch no other file.
- **Completion**: After verifying the approved delivery conditions as `akb guide archive` requires, confirm this task's commit is on the target branch, record its full commit and branch with `akb raw delivery complete <id> --commit <sha> --branch <name>`, and finish the returned handoff.
  - **No git**: run checks on the project, then `akb raw delivery complete <id>` without `--commit`/`--branch`, and delete `.akb/worktrees/<id>/`.
- **Publication**: Complete the push, publication, deployment and live verification authorized by the task; needing production access is not a reason to hand them back to the user.
- **Checks**: Run affected tests and repository-required checks on the combined changes. Rerun affected checks when conflict fixes or newer target changes alter the code.
