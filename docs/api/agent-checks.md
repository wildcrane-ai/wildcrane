# Agent-owned checks

Requires akb 0.11.58 (contract 16) and Runner 0.6.71. Agents check requirements and outputs,
then explicitly record completion. A successful process exit alone does not complete a delivery.

## Inspect a task

```sh
akb raw inspect 735 --json
akb raw validate 735
```

`inspect` reads saved facts without claiming execution, reaping processes, validating files,
running tests or starting repairs. Findings do not change its exit code. An unknown task is
an ordinary command error. `validate` remains the explicit format and asset diagnostic.

The standard JSON envelope adds `id`, `card`, `previews`, `delivery`, `runs`, `recovery`,
`findings` and `unavailable`. Card facts contain its path, questions and `{text,done}` Todos;
preview facts contain agent, current stage, `{id,status,version}` stages and the displayed
artifact's version, section and relative file references. Delivery facts contain ID, status,
directory and completed step numbers. The ten latest run references include status and
`sessionRecorded`; this means a saved identifier, not a live provider session. Recovery facts
contain recorded pending operation IDs and `submitted`. Unknown facts are null; unreadable
sources are named in `findings` and `unavailable`. No overall pass/fail grade is inferred.

## Continue saved work

- **Previews**: the authorized session on a task may print, select, revise and submit its
  listed previews. Starting ready or waiting work retains artifacts, history and confirmations.
  A repeated submission returns its existing version; `--revise-from <id>` prepares a new one.
- **Stages**: agents choose known unique IDs in the order the task needs. Changing a saved
  selection archives it and fences stale writers; no required-stage or definition-order gate remains.
- **Runs**: `raw run resume [id] [--require-session]` uses the original session where possible.
  The legacy flag remains accepted. Missing sessions receive the original task in the same
  directory and delivery, with a fresh session identifier. Existing logs remain on disk.
- **Deliveries**: `raw delivery resume <id>` preserves directories and completion receipts.
  Completed deliveries return their existing result. Live agents, user cancellations and newer
  ownership still fence writes.
- **Completion**: `raw delivery complete <id> [--commit <sha> --branch <name>]` accepts the
  owning agent's conclusion without inspecting Todo ticks, questions, Output records or files.
  Full commit and branch remain paired; merged software results retain their receipt requirement.
- **HTTP**: `POST /v1/tasks/{id}/resume` retains optional `machine` and `runtime` and the Task
  response. Normal review waits return the task without a job or approval; other continuations
  reuse saved context. Actual authorization, directory access and live execution errors remain.

## Checks removed or retained

| Check | Handling and concrete reason |
| --- | --- |
| Ready preview re-entry; clean exit without resubmission | Removed. Neither changes the saved work; WT-83 kept its ready version 2 while this gate failed the task. |
| Submission content, format and missing asset checks | Explicit `raw validate`. A failed diagnostic does not cancel ownership or manufacture task failure. |
| Todo, question, Output and file existence completion gates | Removed from completion and explicit archive. Agent conclusion and receipts govern advancement. |
| Whole-studio later-role preflight | Removed. The selected command reports actual unavailable tools; later agents do not prevent current work. |
| Post-run board scan and forced repair | Removed, including repair prompt injection and preview resubmission failure inference. |
| Ended run, absent session or incomplete recovery metadata | Context for the agent; none alone refuses takeover. Actual command errors still reach the agent. |
| Task/file access | Retained: a task-A session cannot submit task B; out-of-tree asset symlinks must never reach copying or uploading. See `cli/test/agent-checks.test.ts` and Runner asset tests. |
| Live execution and lease ownership | Retained: stopping, logout and transfer revoke the old writer. `execution-resume.test.ts` keeps the new owner intact; Runner handoff tests stop the old process before another writes. |
| Version comparisons | Retained: an old baseline cannot replace a new artifact; stale card writes cannot replace newer contents. `preview-stages.test.ts` and Cloud SQL preview tests compare the saved artifact after stale writes. |
| User confirmation | Retained: repeated confirmation returns the same action and queues exactly one continuation. Old versions and explicitly reset scope cannot confirm new work. Cloud SQL preview tests inspect job counts and retained snapshots. |
| Completion receipts | Retained: repeated equal completion returns the same handoff; different results cannot overwrite it. Archive interruption tests recover once without a second archive. |
| Explicit blocker/cancel and changed requirements | Retained: these are recorded agent/user decisions, independent of Todo counts or process success. No automatic repair or recovery reverses them. |
| Actual command, parameter and I/O errors | Reported at the failing operation, without a wider business preflight. |

## Deployment and recovery

Apply `0218_agent_owned_checks.sql` and deploy Cloud before the compatible CLI/Runner. Keep
the protocol floor. Deploy Web's empty-progress fallback, then run
`node cloud/scripts/recover-preview-waits.mjs` and repeat with `--apply`. The script restores
only legacy gate failures with a currently submitted artifact and no active job. It backs up
the full task, jobs and decisions outside Git, compares the entire task row atomically, clears
only questions proven absent from the current card metadata, and never approves or starts work.
Rerunning after recovery makes no changes. Preview versions, confirmations, costs and history
remain unchanged.

Rollback application and release pointers together to their recorded previous versions.
Keep the compatible function migration and recovery backups; never delete preview progress or
restore obsolete questions to roll back application code. No new service or recurring cost is added.
