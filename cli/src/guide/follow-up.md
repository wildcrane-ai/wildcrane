# Handle follow-up work

Apply `akb guide triage-decision` using this card as the source. Complete the judgment in this run; submit nothing for `skip`.

- **Current task**: finish work required by this card; propose independent work separately, then resume this task.
- **Existing card**: when another open card only needs updating, run `akb task revise <id> "<the change and why>"` instead.
- **Queue**: write the title and body in the **Goal format** of `akb guide discuss-goal`, using the source card's `studio:` and stating the evidence or unresolved question.

```text
akb triage add --title "<one line>" --slug <short-english-slug> --source "#<id>" --studio <studio> --decision <plan|review> --text "<body>"
```
