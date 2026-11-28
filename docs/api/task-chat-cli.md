# Task chat from the CLI

Use the signed-in account and an existing task key, task ID, or number in a linked folder:

```sh
akb task chat WC-12                     # last 20 messages and reply state
akb task chat 12 --limit 5 --json        # one standard JSON object
akb task chat 12 --all                  # all retained messages, oldest first
akb task chat 12 --follow --json        # JSON Lines until this reply ends
akb task chat 12 --stop                 # stop only this chat reply
akb task chat 12 "Revise the draft"     # existing send behavior
akb task resume 12 --runtime Carbon     # choose a runtime for this continuation
```

Reading never sends a message, resumes execution or approves work. `--limit` takes a positive
integer and excludes `--all`. Messages exclude all read/follow/stop options. `--stop` excludes
history options and `--follow`. `task stop` still stops task execution.

## Read and stop

A read returns `ok`, `task: {key, status}`, `reply: {id, state, failure, execution}`,
`messages`, `total` and `truncated`. Message fields are preserved, including role, time,
stopped markers and image names; attachments are not downloaded. History is chronological.
Task execution and chat reply states are separate, including failures after a task ends.
Prose labels follow the machine language; message text and failure reasons are unchanged.

Reply states are `idle`, `queued`, `starting`, `replying`, `stopping`, `done`, `stopped`,
`failed`, `offline` and `conflict`. Phase timestamps remain server evidence; acceptance alone
is not execution. A retained failed reply is a successful read (exit 0).

Stop reads the target first, then calls `POST /v1/tasks/{id}/chat/stop` with `{job: target}`.
It returns `ok`, `task`, `reply` and `stop: {id, state}`. Stop states are `requested` (still
stopping), `stopped` (confirmed), `not_running` (no request sent) and `superseded` (target ended
or changed). All four exit 0. A newer reply is never stopped by the earlier request.

## Follow

Follow binds the reply present in the initial snapshot; no active reply means immediate exit.
It uses the existing authorized job log WebSocket and temporary status reads only while the
command runs. Reconnection resumes after the last event sequence, with bounded retries and
no duplicate events. A log ending alone does not prove success: the original job supplies its
final outcome and body even if another reply starts. Logs retain their existing lifetime;
no persistent log copy is created.

`--follow --json` emits one JSON object per line, without an additional summary:

| `type` | Fields |
| --- | --- |
| `snapshot` | `ok: true` and the read fields above |
| `event` | `ok: true`, `replyId`, `event` with `seq`, `text`, optional `kind`, `data`, `at` |
| `status` | `ok: true`, `replyId`, `reply`; only when state or progress changes |
| `result` | `ok`, final `reply`, `body`; standard `error` on failure |

Success, no active reply and confirmed stop exit 0. Failed, conflicting or offline replies exit
1 with `error.kind: reply_failed`; unrecoverable log loss uses `follow_disconnected`. Existing
login, permission and network errors retain their codes. Ctrl+C exits 130 and closes local
connections without stopping the server reply. Credentials are never included in output.
Node 18 remains supported; the WebSocket client is bundled.
