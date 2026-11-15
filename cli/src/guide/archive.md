# Finish a task

## Write the shipped line

Record each user-facing outcome on one line in `docs/kanban/memory/readme.md`, under the
`## <module>` heading the card's `modules:` names. Do not record internal-only changes. Use
formats like these:

- ✅ Exporting a report to PDF: [Export reports](https://docs.example.com/export). Link to
  a published doc when available; do not restate it.
- ✅ Customers can pay an invoice by bank transfer from the billing page. When no doc
  exists, state plainly what the user can now do.
- ❌ The orders table moved to a new database cluster. This describes infrastructure, not
  user-facing behavior.

## Archive the card

Use `akb raw delivery complete <id>` to finish your current studio step. The last step archives
the card and prints its handoff. Earlier steps leave it for the remaining studio agents.
Outside an active delivery, use `akb raw archive <id>` or `akb raw reject <id>`.

Finish cards through these commands, never by deleting their files.

Before completing a step, verify its approved requirements and outputs; before the last step,
verify the complete approved outcome.
Record results on the card, leave unmet work unchecked, and handle user-action blockers through
`akb guide implement`.

Once those checks pass, run `akb raw delivery complete <id>` and follow its handoff. Software
steps in a git project supply `--commit <full-sha> --branch <target>`.
If completion was interrupted, inspect the recorded result and retry the same completion.
