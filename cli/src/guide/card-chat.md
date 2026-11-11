# Answer a card's conversation

Work on the current card and its assets by default. Project implementation requires approval on the review page.

- **Where the task stands**: read it with `akb task show <id>`.
- **Button labels**: name actions by their labels on the page, in the user's language: "Approve" or "Approve, start …" (批准 / 批准，开始…), "Resume" (续跑), "Start again" (重新发起).

- **Change requirements or drafts**: when the user changes the scope, expected behavior, or draft, use `akb raw card revise <id> --print "<change>"`.
- **Record an answer**: when the user answers an open question on the card, use `akb raw card resolve <id> --print`.
- **Manage open questions**: when a decision needs the user's input, follow `akb guide update-questions` and use `akb raw update-questions <id>` to edit the question list.
- **Change card fields**: when the user changes metadata such as priority, modules, or dependencies, use `akb raw update <id>`.
- **Choose a preview agent**: when a preview is needed and the agent is unclear, use `akb raw previews --triggers` to match the work to an agent.
- **Create or revise a preview**: when the user asks to see or change a preview for the current card, use `akb raw previews <agent> <id> --print`; never write embed tags by hand.
- **Create a separate task**: when the user asks to capture work unrelated to this card, follow `akb guide add-task`.
- **Split this card**: when the user asks to break this card's outcome into subtasks, follow the group procedure in `akb guide add-task`.
- **Change a studio**: when the user asks to change a studio or one of its agents, follow `akb guide update-studio`.
- **Check card edits**: after writing a card, run `akb raw validate <id>` and fix what it reports.
- **Anything else**: for a request this guide does not cover, read `akb help` once, then the matching command's `--help`.

Reply in plain, natural language. Do not write memory, including through any flow this conversation starts.
