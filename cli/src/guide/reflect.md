# Reflect on completed cards

## Read

Read each given `<card>` in full and check its own `shipped` content; keep cards separate.

## Filter

- **Evidence**: verify each candidate against the current project and skip resolved issues or unsupported guesses.
- **Impact**: skip minor or low-impact work and propose only issues with concrete impact that warrant a separate task.
- **Duplicates**: check open tasks (`akb board list`), pending items in `docs/kanban/triage/`, and the rest of this batch; skip work already covered. If shipped work invalidates an open task's plan, run `akb task revise <id> "<the change and why>"`.
- **Prior decisions**: skip work rejected in `docs/kanban/memory/agents/planner/rejected.md` or its module folders, and calls the user reversed, in any `redesign.md` under `docs/kanban/memory/agents/` or under a card's `Overruled by the user`.

## Write

Write each item's title and body in the **Goal format** of `akb guide discuss-goal`; write the body to a temporary Markdown file and end it with the source card's archive path.
Write one triage item per proposal, with its evidence and impact. Submit nothing if no candidate qualifies.
Use the source card's `studio:`, or the id from `akb studio list` that fits the work when it has none.

```text
akb triage add --title "<one line>" --slug <short-english-slug> --source "#<id>" --studio <studio> --file <body.md>
```

Briefly report what you proposed and what you skipped, with reasons.
