# Sort incoming suggestions

Read the assigned items and apply `akb guide triage-decision` to each. Keep user wording intact and check coverage across this batch. For older follow-ups, use their source Studio and check its published rules. Leave manually held or restored items untouched.

- **Results**: record one result per item using its supplied source ID; name covering work for duplicates and the unresolved question for review.
- **Changes**: if an item changed since this batch was claimed, leave it for a later run.
- **Boundary**: record decisions only; task creation and dismissal follow the accepted result.

```text
akb triage decide <source-id> --decision <plan|review|skip> --reason "<evidence or unresolved question>" [--studio <studio>]
```
