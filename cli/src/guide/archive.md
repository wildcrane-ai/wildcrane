# Finish a task

Record the delivered outcome and verification on the task. Leave unmet work unchecked and report blockers through `akb guide implement`.

After delivery, run `akb task archive <task>`. On a linked board, the command sends the local card and changed assets to Cloud and returns after Cloud confirms completion. Runner then mirrors the archive to disk. On an unlinked local board, the command moves the card on disk.

If Cloud refuses the archive, follow the reported recovery steps and retry the same command. This also works for cards already moved into a local archive. Use `akb task remove <task> [reason...]` to remove a task.
