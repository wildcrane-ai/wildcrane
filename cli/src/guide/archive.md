# Finish a task

## Record the outcome

Record the delivered outcome and verification on the task. Do not write independent memory.

## Archive the card

Use `akb raw delivery complete <id>` to finish the approved task and archive the card.
Follow the returned result.
Outside an active delivery, use `akb raw archive <id>` or `akb raw reject <id>`.

Finish cards through these commands, never by deleting their files.

Before completion, verify the complete approved requirements and outputs.
Record results on the card, leave unmet work unchecked, and handle user-action blockers through
`akb guide implement`.

Once those checks pass, run `akb raw delivery complete <id>`. Software
tasks in a git project supply `--commit <full-sha> --branch <target>`.
If completion was interrupted, inspect the recorded result and retry the same completion.
