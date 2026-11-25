# Finish a task

## Record the outcome

Record the delivered outcome and verification on the task. Do not write independent memory.

## Archive the card

Verify the approved requirements and outputs. Leave unmet work unchecked and handle blockers
through `akb guide implement`.

For an active delivery, run `akb delivery complete <id>` and follow the handoff. For Git
projects, supply `--commit <full-sha> --branch <target>`. If interrupted, inspect the recorded
result and retry the same completion.

Outside an active delivery, use `akb task archive <task>`. The current Runner task archives
locally and synchronizes afterward. Other tasks archive in Cloud before the command returns.
Use `akb task remove <task> [reason...]` to remove a task.
