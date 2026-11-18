# Agent-owned checks

Agents verify requirements and outputs, then explicitly record delivery. Process exit alone does not complete a task.

## Inspect and report

`akb raw inspect <id> --json` reads saved facts without starting work; `akb raw validate <id>` explicitly checks card format and assets. Findings do not silently repair or approve work.

Use `akb task review <task>` for the effective plan, node states, immutable evidence and revisions. Work only on the stages assigned to this execution. Sync body and assets before reporting a node `done`; this freezes its evidence. Nonterminal nodes wait for explicit user approval; terminal outputs complete without another approval button.

```sh
akb task review W-818
akb task review W-818 --stage script --status done --revision 7
akb task approve W-818 --stage script --revision 8
```

Only an authorized user decision approves a version. Questions, process exit, synchronization and resume never substitute for it. Revise an approved node before changing its output; affected descendants lose authorization while independent approvals remain.

## Delivery and recovery

- **Ownership**: task access, execution leases, stop/cancel and assignment checks revoke stale writers; asset paths remain constrained to the task.
- **Evidence**: stale decisions cannot advance work; duplicate decisions and equal delivery receipts are idempotent.
- **Checks**: run relevant repository checks and verify the approved outputs before `akb raw delivery complete`; stage completion does not replace merge or delivery records.
- **Cutover**: [task review deployment and rollback](task-review.md#deployment-and-rollback) replaces the former per-agent stage commands and recovery procedure. Historical evidence stays readable.
