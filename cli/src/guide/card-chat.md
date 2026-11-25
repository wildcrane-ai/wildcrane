# Answer a card's conversation

Work only on unlocked stages. An empty plan needs no extra approval; an undecided plan allows planning only.

- **Task and review**: read the current card or use `akb task show <id>` when needed. Use `akb task review <id>` for the full review state and snapshots, and before reporting a stage with its revision. Finish the reply to let the Runner sync and submit Preview changes.
- **Studio and Previews**: when working on a draft, read `akb studio file <studio> STUDIO.md`, any `shared/RULES.md`, and current preferences with `akb studio rule <studio>`. Use the relevant `akb studio previews --studio <studio> --json` entries and component docs as needed. Read only applicable board memory.
- **Button labels**: Quote current labels from the conversation verbatim. Otherwise, consult the task-page guide for the user's language (`akb guide task-ui-en` or `akb guide task-ui-zh`) and describe the action if its label is uncertain.

- **Change requirements or drafts**: when the user changes the scope, expected behavior, or draft, use `akb task revise <id> "<change>" --print`.
- **Record an answer**: when the user answers an open question on the card, use `akb task resolve <id> --print`.
- **Manage open questions**: when a decision needs the user's input, follow `akb guide update-questions` and use `akb task update-questions <task>` to edit the question list.
- **Change card fields**: when the user changes metadata such as priority, modules, or dependencies, use `akb task update <id>`.
- **Previews**: prepare or revise only requested outputs, following `akb guide writing` and the task-bound Studio’s Preview instructions. Before changing approved output, invalidate its stage with `akb task review <id> --revise-from <stage> --revision <n>`. Preserve unrelated work.
- **Create a separate task**: when the user asks to capture work unrelated to this card, follow `akb guide add-task`.
- **Split this card**: when the user asks to break this card's outcome into subtasks, follow the group procedure in `akb guide add-task`.
- **Change a studio**: use `akb guide update-studio` for shared Studio instructions; a correction to this card's draft alone stays on this card.
- **Check card edits**: after writing a card, run `akb task validate <id>` and fix what it reports.
- **Anything else**: for a request this guide does not cover, read `akb help` once, then the matching command's `--help`.

Reply in plain, natural language. Do not write memory, including through any flow this conversation starts.

- **Approve**: only on an explicit request, use `akb task approve <id> --stage <stage> --revision <reviewed revision>`. In a reply this commits after successful synchronization. Finish the reply without further edits or waiting. Never substitute the latest revision for the one reviewed.
- **Change the plan**: submit a complete replacement with `akb task review <id> --file <json> --revision <n>`. It takes effect immediately. Answers to questions never approve work.
