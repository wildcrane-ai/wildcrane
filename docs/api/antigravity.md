# Antigravity CLI

Install and sign in to the official [Antigravity CLI](https://antigravity.google/docs/cli/getting-started/)
on the computer running WildCrane. `agy --version` and `agy models` should work there.
Select **Antigravity CLI** in runtime settings, choose a model or leave it empty for the CLI
default, then test the connection. Use that runtime in discussions, previews and tasks.
It uses the CLI's local login and credits; WildCrane billing is unchanged.

## Existing API

| Request | Antigravity support |
| --- | --- |
| `akb agent check antigravity --json` | Existing readiness, binary/version fields, error kinds and exit codes |
| `GET /v1/runtimes` | Connector `antigravity`, availability, connector version, settings and models from the connected computer |
| `POST /v1/runtimes` | `{ "name": "Antigravity", "runner": "<machine UUID>", "connector": "antigravity", "model": "<agy model id>" }`; omit model for default |
| `PATCH /v1/runtimes/{id}` | Existing `connector` and `model` fields; `null` clears the model |
| `POST /v1/runtimes/{id}/test` | Existing asynchronous connection test on the bound computer |

Existing ownership, computer and task authorization apply. No new endpoints or MCP tools.
This integration does not install a WildCrane plugin in Antigravity or use remote agents.

## Chat pictures

Paste or attach images alongside text in discussions and task chats, including resumed
conversations. Antigravity uses the shared file attachment flow and its native image reader;
no image flags or permission exceptions are added. Image tool errors stay in the log; the
turn succeeds once every required attachment has been read successfully by its full path.
Unrecovered required images and permission denials fail even with a final `SUCCESS`.
Without explicit image targets, unresolved image read errors remain failures. Verified with agy 1.5.9; see
[image input verification](../qa/runner/antigravity-images/case.md).

## Model and effort

Model lists collapse effort suffixes into one base ID (for example `gemini-4-carbon`).
Save the independent effort in `settings.reasoning`: `low`, `medium`, `high`, `xhigh` or
`max`; an empty value uses the CLI default. Execution passes `--model` and `--effort` separately.

## Execution

- **Protocol**: tested with agy 1.5.6 and 1.5.7; [headless NDJSON](https://antigravity.google/docs/cli/headless/) is parsed independently of Gemini CLI.
- **Permissions**: unattended runs use `--dangerously-skip-permissions`, subject to the CLI's deny rules. Denied actions fail even when agy exits zero with `SUCCESS`.
- **Context**: resume uses only `--conversation <id>`. The local `.gemini/antigravity-cli/conversations/<id>.db` must exist; a mismatched returned ID fails without replacing the known ID. No latest-session fallback.
- **Early-crash resume**: agy 1.5.9 persists its conversation before `init`. WildCrane saves that ID immediately and resumes it even before the first response completes. The original request accompanies recovery because `init` can precede saving the first user message; recovery verifies existing results before acting. An interruption without a recorded ID fails explicitly; a missing local conversation never opens a replacement. See [verification](../qa/runner/antigravity-early-recovery/case.md).
- **Usage**: result counters cover the conversation. The first resumed prompt uses its own completed-step counts; subsequent results subtract previous cumulative counts.
- **Cost**: shared `costUsd()` sums unique completed response and checkpoint steps from this process, including failed attempts. `costIncomplete()` marks missing usage or prices. Conversation result totals are never priced. Known Gemini IDs (including effort suffixes) use [global standard API rates](https://cloud.google.com/model-garden/pricing), with published promotional expiry dates fixed at run start. Output already includes thinking; cache reads are separate from fresh input. This is an API-equivalent estimate, not subscription quota, AI credits or an actual bill. Unknown/default-unreported models and runs without priced steps have no amount; no alias prices are inferred. Discussions and tasks use the existing report and display.
- **Context window**: the shared `context()` reading uses the latest completed `agent_response` prompt (fresh input plus cache reads, excluding output and cumulative result counters; checkpoint usage does not replace it) and reads that generation’s effective window limit from the local `.gemini/antigravity-cli/conversations/<id>.db` `gen_metadata` record (verified on agy 1.5.12 for default and explicit models). Model aliases never borrow another provider’s window; missing, unreadable or incomplete local session metadata degrades silently with no context ring.
- **Customization**: existing `.agents/skills` and project instructions remain available. Language rules use a generated rules directory added with `--add-dir`; no business prompt is replaced.
- **Recovery**: temporary connection and provider failures, including `API error (attempt 1): request failed: Post … EOF`, use shared execution retries for tasks too (three attempts within 15 minutes, capped jittered backoff, honoring `retry-after`). Retries resume the recorded conversation and verify existing results before continuing. Chat recovery keeps its existing three-attempt/two-minute budget. Login, permissions, model configuration, rate limits, quota and cancellation do not trigger AGy retries; exhausted attempts keep partial replies and the actual failure for manual retry. Unconfirmed task operations or an unavailable original session stop automatic recovery.
- **Rate-limit exit**: explicit provider 429, rate-limit, exhausted-quota or exhausted-credit diagnostics end the process tree through the shared failure path, releasing the task without automatic retry. Partial replies, files and the recorded conversation remain available for resume after limits reset. Agent prose and tool errors do not trigger this exit.
- **Stopping**: terminates the process tree, records `stopped`, and does not retry or report success.
- **Failures**: missing final results, non-success states, denied actions and process failures remain failures. Authentication, model, network and quota errors include retry guidance. Model discovery failure leaves saved selections intact and does not imply signed out.
- **Brand**: the unmodified SVG comes from [official press assets](https://antigravity.google/press).

## Release and rollback

Apply `0208_antigravity.sql`, deploy Cloud, publish CLI contract 14 and Runner protocol 20,
then deploy Web. Keep the global protocol floor: list and claim checks prevent older Runners
from receiving Antigravity jobs, including direct claims. Use the normal Alpha/candidate/stable
gates in [Deploy](../deploy.md).

To roll back, stop new Antigravity dispatch and stop or finish its running jobs, then roll back
applications and withdraw the Runner/CLI release through their existing channels. Keep expanded
constraints, runtime records and history. Never substitute another connector.

## Model discovery

All runtime model sources use `{ id, name }` entries and the same background policy:
one read per agent at a time, a 15-second timeout and a refresh every 30 seconds.
Missing, failed or empty reads keep the last successful list and retry automatically.
Source changes retain display names; saved models, CLI defaults and manual IDs remain usable.
The visible runtime settings panel reloads every 10 seconds. File readers, read-only CLI
commands and ACP discovery (`initialize`, `session/new`) never submit a generation prompt.
Antigravity 1.5.9 was verified with its signed-in `agy models` list and saved selections;
see [regression evidence](../qa/runner/agent-model-recovery/case.md).
