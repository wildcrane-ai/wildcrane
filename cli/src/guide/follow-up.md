# Handle follow-up work

Use when planning or implementation discovers additional work.

- **Current task**: finish required work on this card; queue independent follow-ups in triage, then resume the original task.
- **Drop what was turned down**: queue nothing that
  `docs/kanban/memory/agents/planner/rejected.md` or
  `docs/kanban/memory/agents/planner/*/rejected.md` turns down.
- **Existing card**: when only another open card needs changing, run `akb raw card revise <id> "<the change and why>"`.
- **Queue it**: use the command below; skip an item the command reports as already there.
- **Workflow**: use the source card's `workflow:`, or the id from `akb workflow list` that fits the work when it has none.

```text
akb raw triage add --title "<one line>" --slug <short-english-slug> --source "#<id>" --workflow <workflow> --text "<body>"
```

## Write the item

Write each item's title and body in the **Goal format** of `akb guide discuss-goal`.
