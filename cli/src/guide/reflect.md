# Reflect on completed cards

## Read

Read each given `<card>` in full and check its own `shipped` content; keep cards separate.
Find needs the work left behind or revealed, and verify them in the project. Proposing nothing is fine.

## Filter

- **Duplicates**: check `akb raw list` and `akb raw triage check <source-id>`; propose shared work only once.
- **Exclude**: skip unsupported guesses, work covered by `<scheduled-agents>`, work rejected in `docs/kanban/memory/agents/planner/rejected.md` or its module folders, and calls the user reversed, in any `redesign.md` under `docs/kanban/memory/agents/` or under a card's `Overruled by the user`.
- **Existing cards**: when shipped work invalidates an open card's plan, run `akb raw card revise <id> "<the change and why>"` instead of proposing an item.

## Write

Write each item's title and body in the **Goal format** of `akb guide discuss-goal`; write the body to a temporary Markdown file and end it with the source card's archive path.
Write one triage item per proposal. Exploratory ideas are welcome; identify small chores as such.
Use the source card's `studio:`, or the id from `akb studio list` that fits the work when it has none.

```text
akb raw triage add --title "<one line>" --slug <short-english-slug> --source "#<id>" --studio <studio> --file <body.md>
```

Briefly report what you proposed and what you skipped, with reasons.
