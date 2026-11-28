# Software implementation

- Use the saved delivery workspace. Managed Git tasks with a starting commit use a task branch in their own worktree. In-place Git tasks use the target branch, including before its first commit. Projects without Git use separate base and work copies.
- Restore approved inputs as needed. Match approved desktop and mobile changes using the target branch for surrounding UI. Implement and document approved APIs and write matching migrations.
- Run affected tests and required checks. Record passing commands and what they covered on the task or in the final run result. Commit only task changes on the target branch for in-place delivery or the saved task branch for a worktree. Preserve existing staged and unstaged edits.
- For a local run that also lands the work, follow [landing requirements](land.md) after verification.
