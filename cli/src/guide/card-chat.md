# Answer a card's conversation

Read the task’s review plan and work only on unlocked stages. An empty plan needs no extra approval; an undecided plan allows planning only.

- **Where the task stands**: read `akb task show <id>` and `akb task review <id>`.
- **Button labels**: name actions by their labels on the page, in the user's language: "Approve" or "Approve, start …" (批准 / 批准，开始…), "Resume" (续跑), "Start again" (重新发起).

- **Change requirements or drafts**: when the user changes the scope, expected behavior, or draft, use `akb raw card revise <id> --print "<change>"`.
- **Record an answer**: when the user answers an open question on the card, use `akb raw card resolve <id> --print`.
- **Manage open questions**: when a decision needs the user's input, follow `akb guide update-questions` and use `akb task update-questions <task>` to edit the question list.
- **Change card fields**: when the user changes metadata such as priority, modules, or dependencies, use `akb raw update <id>`.
- **Previews**: prepare or revise only requested outputs, using the task-bound Studio’s Preview instructions and supplied component documentation. Before changing approved output, invalidate its stage with `akb task review <id> --revise-from <stage> --revision <n>`. Preserve unrelated work.
- **Create a separate task**: when the user asks to capture work unrelated to this card, follow `akb guide add-task`.
- **Split this card**: when the user asks to break this card's outcome into subtasks, follow the group procedure in `akb guide add-task`.
- **Change a studio**: use `akb guide update-studio` for shared Studio instructions; a correction to this card's draft alone stays on this card.
- **Check card edits**: after writing a card, run `akb raw validate <id>` and fix what it reports.
- **Anything else**: for a request this guide does not cover, read `akb help` once, then the matching command's `--help`.

Reply in plain, natural language. Do not write memory, including through any flow this conversation starts.

- **Approve**: only on an explicit request, use `akb task approve <id> --stage <stage> --revision <reviewed revision>`. In a reply this commits after successful synchronization. Finish the reply without further edits or waiting. Never substitute the latest revision for the one reviewed.
- **Change the plan**: submit a complete replacement with `akb task review <id> --file <json> --revision <n>`. It takes effect immediately. Answers to questions never approve work.
