# Finish a task

Record the delivered outcome and verification on the task. Leave unmet work unchecked and report blockers through `akb guide implement`.

After delivery, run `akb task archive <task>`. The current Runner task archives locally, then the Runner synchronizes its card and attachments. Cloud confirms completion. For another Cloud task, the command returns after Cloud confirms the archive.

If interrupted after a local archive, resume synchronization from the saved archive. Use `akb task remove <task> [reason...]` to remove a task.
