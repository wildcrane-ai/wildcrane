# Reflect on completed cards

## Read

Read each given `<card>` in full and check its own `shipped` content; keep cards separate.

## Filter

- **Evidence**: verify each candidate against current project state or deliverables, citing specific evidence and skipping resolved or unsupported items.
- **Impact**: propose a separate task only for material impact on users, workflows, deliverables, or stated project goals—never minor polish or speculation.
- **Duplicates**: compare requested outcomes with open tasks (`akb board list`), pending triage, and the rest of this batch; skip work they already cover. If shipped work invalidates an open task's plan, run `akb task revise <id> "<the change and why>"`.
- **Prior decisions**: skip work rejected in `docs/kanban/memory/agents/planner/rejected.md` or its module folders, and calls the user reversed, in any `redesign.md` under `docs/kanban/memory/agents/` or under a card's `Overruled by the user`. Revisit a low-value dismissal only when new evidence establishes material impact.

## Write

Write each item's title and body in the **Goal format** of `akb guide discuss-goal`; write the body to a temporary Markdown file and end it with the source card's archive path.
Write one triage item per qualifying proposal. Submit nothing if none qualify.
Use the source card's `studio:`, or the id from `akb studio list` that fits the work when it has none.

```text
akb triage add --title "<one line>" --slug <short-english-slug> --source "#<id>" --studio <studio> --file <body.md>
```

Briefly report what you proposed and what you skipped, with reasons.
