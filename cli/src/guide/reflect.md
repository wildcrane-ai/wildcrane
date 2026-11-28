# Reflect on completed cards

Read each `<card>` and its `shipped` content; apply `akb guide triage-decision` separately to each source card and check coverage across this batch. Complete the judgment in this run; submit nothing for `skip`.

- **Existing card**: if shipped work invalidates an open task's plan, run `akb task revise <id> "<the change and why>"` instead.
- **Queue**: write each item in the **Goal format** of `akb guide discuss-goal` to a temporary file ending with the archived card path, using the source card's `studio:` and stating the evidence or unresolved question.

```text
akb triage add --title "<one line>" --slug <short-english-slug> --source "#<id>" --studio <studio> --decision <plan|review> --file <body.md>
```
