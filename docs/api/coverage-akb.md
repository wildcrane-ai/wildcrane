# AKB command coverage inventory

[Coverage and open gaps](coverage.md) · [HTTP inventory](coverage-http.md)

Checked **2026-11-17**, CLI **0.11.71**, contract **18**, source baseline
`d730c1dae7e3938805303328e9aa451a4f364aa0`. This is the source command tree,
not whichever version happens to be on PATH. `wildcrane` is the same executable alias.

## Arguments and shared options

`<arg>` is required; `[arg]` is optional; `...` is variadic. Commands use the project's
linked board unless given `--board <dir>` (or `AI4KANBAN_BOARD`), which takes precedence
over `--dir <path>`. Shared `--json` changes output, not feature coverage; `-h, --help`
and `help [command]` print help. Root `-v, --version` prints the version. All nonshared
options, including hidden ones, are listed below. A required option is marked `*`.

Local commands operate on the linked board or run. Runner synchronization can later write its
files through board commits; this is not equivalent to a direct Cloud API command.
Rows marked **Local** have no API for their business operation. Shared startup may still
refresh Studio definitions or renew an execution lease. Neither startup traffic nor
Runner synchronization implies that a local command exposes the Cloud operation's parameters.

## Cloud commands and local tools

| Command and arguments | Operation | Nonshared options | API relationship / UI coverage | Implementation |
| --- | --- | --- | --- | --- |
| `akb` | set up a board, and put an agent to work on it. | `-v, --version` | Command help; no API | [akb.ts](../../cli/src/lib/cli/akb.ts) |
| `akb update` | Repair an existing board and check for a CLI update | — | Local board repair plus npm version lookup; no project API | [update.ts](../../cli/src/commands/update.ts) |
| `akb __rules` | Hidden: Internal command | — | Hidden internal module-path read; no API | [setup.ts](../../cli/src/lib/cli/setup.ts) |
| `akb task` | Command group / help | — | Help/command group only; no operation | [agent.ts](../../cli/src/lib/cli/agent.ts) |
| `akb task list` | list tasks | `--project <id>`; `--workspace <id>`; `--status <status>` | GET /v1/tasks; project/workspace/status; partial G06 | [task.ts](../../cli/src/commands/task.ts) |
| `akb task show <task>` | a task and its card | — | GET /v1/tasks/{id} + /card; task page read | [task.ts](../../cli/src/commands/task.ts) |
| `akb task create <request...>` | create a task and prepare its card asynchronously | `--project <id>`; `--studio <id>` | POST /v1/tasks; --studio required by handler; partial G06 | [task.ts](../../cli/src/commands/task.ts) |
| `akb task approve <task>` | approve the reviewed snapshot | `--stage <id>`, `--comment <text>`, `--revision <n>` required for standalone approval | Pinned reply target or explicit human approval | [task.ts](../../cli/src/commands/task.ts) |
| `akb task review <task>` | read the review, set the plan or report/revise a stage | `--review <rule>` or `--file <path>`, `--stage <id> --status running/done`, `--revise-from <id>` | GET task or conditional POST review, with automatic revision selection | [task.ts](../../cli/src/commands/task.ts) |
| `akb task update-questions <task>` | append, rewrite, or remove open questions | `--append <text>`; `--update <n> <text...>`; `--drop <positions>`; `--clear`; `--option <text>`; `--recommended-option <text>`; `--mode <mode>`; `--agent <name>` | Current Runner task: local save for synchronization. Other tasks: GET /card + PATCH /questions with the version read | [task.ts](../../cli/src/commands/task.ts) |
| `akb task chat <task> [message...]` | read task chat history, follow or stop its reply, or send a message | `--limit <n>`; `--all`; `--follow`; `--stop` | GET/POST /chat; --stop → POST /chat/stop; --follow → job read/log; partial G08 | [task-chat.ts](../../cli/src/commands/task-chat.ts) |
| `akb task archive <task>` | archive an eligible task | `--json` | Linked: POST /v1/tasks/{id}/archive; Runner mirrors files | [task.ts](../../cli/src/commands/task.ts) |
| `akb task remove <task> [reason...] [--discard]` | remove a task; bring it back with task restore | `--discard` | Current local task via Runner sync, otherwise POST /v1/tasks/{id}/cancel | [task.ts](../../cli/src/commands/task.ts) |
| `akb task restore <task>` | restore a removed or completed task without starting it | — | POST /v1/tasks/{id}/restore; removed or completed task, no execution replay | [task.ts](../../cli/src/commands/task.ts) |
| `akb task resume <task>` | resume the current Cloud task step | `--runtime <name-or-id>`; `--json` | POST /v1/tasks/{id}/resume, shared with the web Resume action. Accepts a key, Cloud task ID or linked-project number. Returns queued or running, or a nonzero exit on refusal. G06 | [task.ts](../../cli/src/commands/task.ts) |
| `akb task stop <task>` | stop its current run | — | POST /v1/tasks/{id}/stop; execution only | [task.ts](../../cli/src/commands/task.ts) |
| `akb task comment <task> <text...>` | comment on a task | — | POST /v1/tasks/{id}/comments; text, session required | [task.ts](../../cli/src/commands/task.ts) |
| `akb goal <move>` | save, drop and start goals of this conversation | `--id <goal>`; `--title <title>`; `--body-file <path>`; `--studio <id>`; `--review <flow>` or `--review-file <path>` | new/save/drop/start; current conversation only; local goals file in Runner, Cloud external/draft/start otherwise; G10/G11 | [goal-cloud.ts](../../cli/src/commands/goal-cloud.ts) |
| `akb workspace` | Command group / help | — | Help/command group only; no operation | [agent.ts](../../cli/src/lib/cli/agent.ts) |
| `akb workspace list` | list workspaces | — | GET /v1/workspaces; listing only; G01 | [task.ts](../../cli/src/commands/task.ts) |
| `akb project` | Command group / help | — | Help/command group only; no operation | [agent.ts](../../cli/src/lib/cli/agent.ts) |
| `akb project list` | list projects | `--workspace <id>` | GET /v1/projects; listing only; G02 | [task.ts](../../cli/src/commands/task.ts) |
| `akb runner` | Command group / help | — | Help/command group only; no operation | [agent.ts](../../cli/src/lib/cli/agent.ts) |
| `akb runner list` | list Runners | `--workspace <id>` | GET /v1/workspaces/{id}/runners; listing only; G03 | [task.ts](../../cli/src/commands/task.ts) |
| `akb account` | the account this MACHINE acts as | — | GET /v1/session; account identity only; no billing view | [cloud.ts](../../cli/src/commands/cloud.ts) |
| `akb account sign-out` | forget it: this machine stops reaching Cloud, and nothing on any board changes | — | Local: remove saved session; does not release Runner/revoke executors; G17 | [account.ts](../../cli/src/lib/cloud/account.ts) |
| `akb image [prompt...]` | generate an image through Cloud, using WildCrane API balance | `--aspect <ratio>`; `--tier <tier>`; `--ref <file>`; `--out <file>` | POST /v1/image; prompt, --aspect and --out required by handler; references repeatable | [cloud.ts](../../cli/src/commands/cloud.ts) |
| `akb tts [text...]` | generate narration in a hosted voice, using WildCrane API balance | `--voice <name>`; `--tier <tier>`; `--out <file>` | POST /v1/speech; --voice and --out required by handler | [cloud.ts](../../cli/src/commands/cloud.ts) |
| `akb music [prompt...]` | generate an instrumental track through Cloud, using WildCrane API balance | `--seconds <n>`; `--out <file>` | POST /v1/music; --out required by handler | [cloud.ts](../../cli/src/commands/cloud.ts) |
| `akb transcribe <media>` | transcribe the first audio stream in a Runner task | `--language <auto\|code>`; `--out <file>`; `--vtt <file>`; `--json` | Upload the first audio stream, poll /v1/transcriptions, and write JSON with `source: { media }` and WebVTT | [transcribe.ts](../../cli/src/commands/transcribe.ts) |
| `akb template` | Command group / help | — | Help/command group only; no operation | [agent.ts](../../cli/src/lib/cli/agent.ts) |
| `akb template list-tags` | a category's tags, with how many templates carry each | `--category <category>` | GET /v1/templates/tags?category=; --category required by handler | [cloud-template.ts](../../cli/src/commands/cloud-template.ts) |
| `akb template search [words...]` | templates carrying a tag: metadata only, 5 by default, at most 10 | `--category <category>`; `--tags <tags>`; `--limit <n>` | GET /v1/templates; --category and --tags required by handler; limit 1–10 | [cloud-template.ts](../../cli/src/commands/cloud-template.ts) |
| `akb template preview <name>` | Download template catalog previews | `--to <dir>` | GET /v1/templates/{name}/previews + each preview file; --to required by handler | [cloud-template.ts](../../cli/src/commands/cloud-template.ts) |
| `akb template get <name>` | download every file of a template, checked against the catalog | `--to <dir>` | GET /v1/templates/{name} + files; --to required by handler; refuses overwrites | [cloud-template.ts](../../cli/src/commands/cloud-template.ts) |
| `akb template source <name>` | where a template came from, and the evidence captured at the time | `--to <dir>` | GET /v1/templates/{name}/source; --to also downloads evidence | [cloud-template.ts](../../cli/src/commands/cloud-template.ts) |
| `akb template publish <dir>` | publish a template (maintainers only) | `--preview <file>`; `--evidence <file>`; `--replace` | POST /v1/templates; publisher-only multipart files | [cloud-template.ts](../../cli/src/commands/cloud-template.ts) |
| `akb template showcase <name> <dir>` | set what wildcrane.ai/templates shows for a template (maintainers only) | — | PUT /v1/templates/{name}/showcase; publisher only | [cloud-template.ts](../../cli/src/commands/cloud-template.ts) |
| `akb template delete <name>` | take a template out of the catalog (maintainers only) | — | DELETE /v1/templates/{name}; publisher only | [cloud-template.ts](../../cli/src/commands/cloud-template.ts) |
| `akb agent` | Command group / help | — | Help/command group only; no operation | [agent.ts](../../cli/src/lib/cli/agent.ts) |
| `akb agent check <agent>` | whether WildCrane can run an agent here, and what is missing; exits 1 until it can | — | Local installation/version/login probe where supported; no /v1/runtimes/{id}/test; G03 | [agent-check.ts](../../cli/src/commands/agent-check.ts) |
| `akb telemetry` | whether this MACHINE reports anonymous usage | — | Local: reporting state, same as telemetry status; no API | [telemetry.ts](../../cli/src/commands/telemetry.ts) |
| `akb telemetry status` | what this machine reports, and the install id its reports carry | — | Local: reporting state; no API | [telemetry.ts](../../cli/src/commands/telemetry.ts) |
| `akb telemetry on` | turn reporting on | — | Local: enable reporting preference; no API mutation | [telemetry.ts](../../cli/src/commands/telemetry.ts) |
| `akb telemetry off` | turn reporting off | — | Local: disable reporting, drop queue/install ID; no API mutation | [telemetry.ts](../../cli/src/commands/telemetry.ts) |
| `akb studio` | List installed Studios and Preview outputs | — | Same as studio list | [studio.ts](../../cli/src/commands/studio.ts) |
| `akb studio list` | every Studio this workspace can run and its Preview outputs. Offline, the ones downloaded before, marked (offline). | — | GET /v1/studios + definitions/cache; not marketplace discovery; G05 | [studio.ts](../../cli/src/commands/studio.ts) |
| `akb studio pull <id> [folder]` | write the studio's current version into a folder to edit | — | GET /v1/studios/{id}; write current files/version.json locally | [studio.ts](../../cli/src/commands/studio.ts) |
| `akb studio clone <id> <folder>` | create an independent local Studio draft | `--name <name>`, `--json` | GET /v1/studios/{id}; write reusable files locally | [studio.ts](../../cli/src/commands/studio.ts) |
| `akb studio create <folder>` | create a workspace studio from a local folder | `--request-id <id>`*; `--workspace <id>` | POST /v1/studios; --request-id required; complete folder | [studio.ts](../../cli/src/commands/studio.ts) |
| `akb studio push <folder>` | save the edited folder as the studio's next version, which new tasks take | `--request-id <id>`; `--dry-run` | GET/PATCH /v1/studios/{id}; version.json + request ID; --dry-run checks without saving | [studio.ts](../../cli/src/commands/studio.ts) |
| `akb studio rule <studio>` | set a studio's rules — what every card on it follows — in the user's own words | `--text <text>`; `--file <path>` | GET studio-rules; PUT /v1/workspaces/{id}/studios/{studio}/rule with text/file | [studio.ts](../../cli/src/commands/studio.ts) |
| `akb studio instructions <agent>` | read or set a project background task's instructions | `--text <text>`; `--file <path>` | GET project agents; PUT project board-agent rule; no workspace Agent branch or schedule changes; G04 | [studio.ts](../../cli/src/commands/studio.ts) |
| `akb guide [topic]` | the flows the board works by, shipped with this command | — | Local bundled/board guides; no API | [guide.ts](../../cli/src/commands/guide.ts) |
| `akb __watch <sessionId>` | Hidden: Internal command | — | Hidden local run watcher, no user API | [run.ts](../../cli/src/commands/run.ts) |

## Task archive

`akb task archive <task>` takes a task key, a task ID, or a number in a linked
project. On a linked board it uploads changed local attachments and sends the
card and their versions to Cloud. Cloud confirms completion and Runner mirrors
the archive to disk. A successful `--json` response includes `task` and
`archive_status: "archived"`. An unlinked board archives the card locally.

Land verifies the saved deliverable before archiving, then closes its session
and releases the lease. Cloud refuses an archive with open questions, unfinished
review, changed versions, or an active Land lease held by another job. The
command exits nonzero with the reason and retains the local card for retry.

Example: `akb task archive W-42 --json`

## Raw commands

| Command and arguments | Operation | Nonshared options | API relationship / UI coverage | Implementation |
| --- | --- | --- | --- | --- |
| `akb board` | Local cards and conflicts | — | Command group | [agent.ts](../../cli/src/lib/cli/agent.ts) |
| `akb board conflict` | Command group / help | — | Local conflict operations; [contract](board-conflicts.md) | [board.ts](../../cli/src/lib/cli/board.ts) |
| `akb board conflict list` | list pending conflicts | — | Offline local records; no API | [board-conflicts.ts](../../cli/src/lib/shared/board-conflicts.ts) |
| `akb board conflict show <id>` | read saved three-way versions and a read credential | — | Offline local records and current files; no API | [board-conflicts.ts](../../cli/src/lib/shared/board-conflicts.ts) |
| `akb board conflict resolve <id>` | explicitly resolve the original atomic batch | `--expect <revision>`*; `--file <path>`* | Current execution required; GET board versions and POST /board/commits; no new HTTP route | [board-conflicts.ts](../../cli/src/lib/cloud/board-conflicts.ts) |
| `akb task create --title <title>` | Write one local card, body scaffold and index entry | `--studio <id>`; `--blocked-by <ids>`; `--related <ids>`; `--modules <names>`; `--slug <slug>`; `--triage <source-id>`; `--source <ref>` | Cloud assigns the number. The receipt gives the card ID and local path. A retry reuses an allocation when there is a matching receipt. | [board.ts](../../cli/src/lib/cli/board.ts) |
| `akb task update <id>` | rewrite a card's fields | `--title <title>`; `--status <status>`; `--blocked-by <ids>`; `--related <ids>`; `--add-blocked-by <ids>`; `--add-related <ids>`; `--modules <names>`; `--source <ref>`; `--add-source <ref>`; `--slug <slug>`; `--studio <id>` | Local card fields; no direct PATCH /v1/tasks | [board.ts](../../cli/src/lib/cli/board.ts) |
| `akb raw update-questions <id>` | Hidden migration compatibility for numeric local cards | `--append <text>`; `--update <n> <text...>`; `--drop <positions>`; `--clear`; `--option <text>`; `--recommended-option <text>`; `--mode <mode>`; `--agent <name>` | Local question list; no direct PATCH /v1/tasks/{id}/questions | [board.ts](../../cli/src/lib/cli/board.ts) |
| `akb task inspect <id>` | read task facts, saved work and execution references | — | Local saved facts only; no Cloud task query | [board.ts](../../cli/src/lib/cli/board.ts) |
| `akb task validate [id]` | validate card format and report file, line, and repair instructions | — | Local explicit card/asset format diagnostic; no API | [board.ts](../../cli/src/lib/cli/board.ts) |
| `akb studio file <studio> <path>` | print one file of a studio | — | Local cached/pinned Studio file; definition download uses GET /v1/tasks/{id}/studio or /v1/studios/{id} | [cloud-studios.ts](../../cli/src/lib/agent/cloud-studios.ts) |
| `akb raw agent-file <agent> <path>` | Hidden: Internal command | — | Hidden compatibility local project-agent file read; no direct API | [board.ts](../../cli/src/lib/cli/board.ts) |
| `akb memory file <name>` | print one global memory's rules, its MEMORY.md | — | Local bundled memory rules; no API | [board.ts](../../cli/src/lib/cli/board.ts) |
| `akb board list` | the open cards: id, title, meta, summary, path — or, with --archived, the cards that landed | `-m, --module <name>`; `--stale`; `--archived`; `--since <time>`; `--studio <id>` | Local card/landing list; not Cloud task listing | [board.ts](../../cli/src/lib/cli/board.ts) |
| `akb raw reject <id>` | legacy local removal | `--discard`; `--reason <text>` | Local board only | [board.ts](../../cli/src/lib/cli/board.ts) |
| `akb raw init` | scaffold docs/kanban/; on an existing board add only what is missing | — | Local board scaffold/repair; no API | [board.ts](../../cli/src/lib/cli/board.ts) |
| `akb raw version` | print the installed version | — | Local installed version; no API | [board.ts](../../cli/src/lib/cli/board.ts) |
| `akb task implement <id> [note...]` | build the card | `--runtime <id>`; `-p, --print` | Local delivery/run start; not Cloud resume | [flows.ts](../../cli/src/lib/agent/flows.ts) |
| `akb task refine <id>` | plan the card | `-p, --print` | Local planning run; no direct API counterpart | [flows.ts](../../cli/src/lib/agent/flows.ts) |
| `akb task resolve <id> [note...]` | apply the user's answers to its open questions | `-p, --print` | Local answers run; no direct API counterpart | [flows.ts](../../cli/src/lib/agent/flows.ts) |
| `akb raw card approve <id>` | Approve a local card | `-p, --print`, `-f, --follow`, `--events` | Cloud review uses `akb task approve` | [run.ts](../../cli/src/commands/run.ts) |
| `akb task revise <id> <what...>` | change the card to say something else | `-p, --print` | Local revision run; no direct API counterpart | [flows.ts](../../cli/src/lib/agent/flows.ts) |
| `akb delivery` | Command group / help | — | Help/command group only; no operation | [agent.ts](../../cli/src/lib/cli/agent.ts) |
| `akb delivery answered <delivery>` | say what a round of applied answers did to its requirements | `--unchanged <why>`; `--changed <why>` | Local requirements conclusion; exactly one of --changed/--unchanged | [run.ts](../../cli/src/commands/run.ts) |
| `akb delivery cancel <delivery>` | end it and hand the card back | — | Local delivery cancel, files retained; not Cloud discard | [run.ts](../../cli/src/commands/run.ts) |
| `akb run` | Command group / help | — | Help/command group only; no operation | [agent.ts](../../cli/src/lib/cli/agent.ts) |
| `akb run list` | what is running, and what ran lately | `-c, --card <id>`; `-a, --all` | Local run/session records; no general Cloud job listing | [run.ts](../../cli/src/commands/run.ts) |
| `akb run start [prompt...]` | start a sub-run of the run you are inside, and return its id | `--runtime <id>`; `--file <path>` | Local child run; requires parent run; no direct API | [run.ts](../../cli/src/commands/run.ts) |
| `akb run wait [id...]` | wait up to 90 seconds for this run's sub-runs to end | — | Local child-run wait; no API | [run.ts](../../cli/src/commands/run.ts) |
| `akb run log [id]` | one run's log | `-f, --follow`; `--events`; `--full` | Local run log; no general Cloud job log | [run.ts](../../cli/src/commands/run.ts) |
| `akb run stop [id]` | end a run | — | Local process stop; not Cloud task or chat stop | [run.ts](../../cli/src/commands/run.ts) |
| `akb run resume [id]` | continue a run from its saved work | `-f, --follow`; `--events`; `--fresh` | Local saved session; --fresh takes over | [run.ts](../../cli/src/commands/run.ts) |
| `akb raw memory` | Command group / help | — | Help/command group only; no operation | [agent.ts](../../cli/src/lib/cli/agent.ts) |
| `akb raw memory prune` | squeeze the memory back down to what helps planning | `-p, --print`; `-f, --follow`; `--events` | Local memory agent run; no API for pruning | [flows.ts](../../cli/src/lib/agent/flows.ts) |
| `akb memory review` | read archived tasks' cards and chats, and write down what they settled | `--task <task:card...>` | Local review run, --task required by workflow; reads archived Cloud task chats/decisions | [flows.ts](../../cli/src/lib/agent/flows.ts) |
| `akb triage` | Command group / help | — | Help/command group only; no operation | [agent.ts](../../cli/src/lib/cli/agent.ts) |
| `akb triage add` | write one item into triage | `--title <text>`*; `--text <text>`; `--file <path>`; `--source <text>`; `--studio <id>`*; `--slug <slug>` | Local triage item, title/studio required and text or file; no direct POST /v1/triage | [triage.ts](../../cli/src/commands/triage.ts) |
| `akb triage check <source-id>` | where triage already holds one source id | — | Local source-id lookup; not Cloud triage list | [triage.ts](../../cli/src/commands/triage.ts) |
| `akb raw review-dismissals` | learn what the user does not want from their rejection and dismissal reasons | `-p, --print`; `-f, --follow`; `--events` | Agent workflow: GET /v1/rejections + POST /v1/rejections/reviewed; no dismissal UI operation | [flows.ts](../../cli/src/lib/agent/flows.ts) |
| `akb memory describe-project` | rewrite the project description the planning flows read | — | Local project-memory rewrite run; no API | [flows.ts](../../cli/src/lib/agent/flows.ts) |
| `akb raw reflect` | propose the work that should follow some finished cards | `--cards <id...>`; `-p, --print`; `-f, --follow`; `--events` | Local reflection run, can add local triage proposals; no direct API counterpart | [flows.ts](../../cli/src/lib/agent/flows.ts) |
| `akb studio previews` | list Preview IDs and instructions | `--studio <id>` | Local Studio Preview instructions | [previews.ts](../../cli/src/commands/previews.ts) |
| `akb raw agent` | what runs the board, and how it is set up | — | Local runtime settings read; no GET /v1/runtimes | [agent.ts](../../cli/src/commands/agent.ts) |
| `akb raw agent use <name>` | the harness Global default runs | — | Local default harness; no Cloud runtime update | [agent.ts](../../cli/src/commands/agent.ts) |
| `akb raw agent set <key> [value...]` | one runtime setting, or its key | `--runtime <id>`; `--agent <name>` | Local runtime setting/secret; no Cloud runtime update | [agent.ts](../../cli/src/commands/agent.ts) |
| `akb raw agent picks <json>` | Hidden: Internal command | — | Hidden local replacement of per-agent runtime picks; no Cloud assignment | [agent.ts](../../cli/src/commands/agent.ts) |
| `akb raw components` | list an agent or studio’s Preview Components and their usage | `--studio <id>`; `--docs` | Local Studio component docs; --studio required by handler; not /v1/components publisher registry | [components.ts](../../cli/src/commands/components.ts) |
| `akb studio validate <folder>` | validate the complete Studio definition and its references | — | Local Studio folder validation; no API | [studio.ts](../../cli/src/commands/studio.ts) |
| `akb studio preview <card>` | freeze Studio files and print Studio and attachment previews | `--folder <draft>`*; `--base <baseline>`* | Local frozen Studio review files; no publication API | [studio-preview.ts](../../cli/src/commands/studio-preview.ts) |
| `akb raw studio diagram <id-or-card> [card]` | Retired Studio graph command | `--folder <folder>` | Retired: always refuses; retained for compatibility | [studio.ts](../../cli/src/commands/studio.ts) |

## Goal moves and option semantics

`goal <move>` is one Commander command with four operations, not four omitted subcommands.
[Goal implementation](../../cli/src/commands/goal.ts) and
[Cloud adapter](../../cli/src/commands/goal-cloud.ts) define the behavior:

| Move | Necessary arguments/options | API or local effect |
| --- | --- | --- |
| `goal new` | `--title <text> --body-file <path>`; optional `--studio <id>` (defaults to first installed) and one of `--review <flow>` or `--review-file <path>` | Creates a goal in the current draft; Cloud uses external discussion + PUT draft. The body contains `## Done when`. |
| `goal save` | `--id <goal>` plus changed title/body-file/studio/review | Updates current draft; PUT draft with expectedVersion. `--review ''` explicitly selects no extra review; omitted review edits preserve the plan. |
| `goal drop` | `--id <goal>` | Drops current goal; Cloud adapter saves remaining goals through PUT draft, not DELETE one goal. |
| `goal start` | `--id <goal>` | Marks start in Runner goal file; external adapter saves draft then POSTs `/goals/{goal}/start`. No explicit project/machine/skip_plan flags. |

- **Current session**: there is no `--discussion` selector. In a Runner discussion, goal changes go to the local goals file for Runner to report; external host sessions use Cloud. `goal save --studio` and `goal drop` achieve UI outcomes through whole-draft writes, not the individual PATCH/DELETE endpoint.
- **Chat modes**: without message, `task chat` reads the latest 20 retained messages; `--all` and `--limit` are alternatives. `--follow` follows only the reply selected at entry; `--stop` stops that reply, not task execution. Send/read/follow/stop combinations are validated by [task-chat](../../cli/src/commands/task-chat.ts). There is no image, runtime, clear or continue option.
- **Ordered questions**: append/update/drop/clear run in typed order. Choice/mode/agent flags belong to the preceding append/update; positions are 1-based. Each batch takes 1–50 edits. New or rewritten questions take 2–20 distinct options and up to one recommendation. Question text is limited to 4,000 UTF-8 bytes and each option to 200. `--json` returns `changes` and `open` plus the local card's `id` and `file`, or the Cloud task fields. On `version_conflict`, read the card again and check positions before resubmitting.
- **Local list**: `board list --archived --since <time> [--studio <id>]` reads landing receipts. `--stale` and `--module` filter local cards, not Cloud tasks.
- **Flow options**: `--print` prints instructions without starting; it conflicts with `--follow`. `--events` is structured log output with follow. `task implement` accepts `--session/--fork/--transcript` for compatibility but ignores them; other applicable flows carry session context. `--new-session` selects a fresh session (the generic implementation help still calls carry options ignored).
- **Studio publication**: `studio create` requires a request ID; push uses local `version.json` and expectedVersion, optionally a request ID; dry-run writes nothing. `studio rule/instructions` reads without text/file and clears with empty text. Instructions set project board-agent rules; Workspace Studio Agent routes are removed (HTTP 404); Studio/Preview names are rejected by `studio instructions`. They do not set schedules.
- **Local secrets**: `raw agent set` stores local runtime secrets/settings. It cannot manage Cloud runtimes or their immutable computer binding. `agent check` probes installation and login where supported; it does not perform a Cloud runtime's prompt-based connection test.

## Declarations that do not imply support

| Declaration or old spelling | Current behavior / source |
| --- | --- |
| Former Studio role commands | `raw previews <agent> <id>` and `raw agent run <studio> <agent>` refuse without starting a run. |
| `raw studio diagram` | Refused by [studio](../../cli/src/commands/studio.ts#L53); no current Studio agent graph. |
| `raw create --recurring/--cadence`, `raw update --cadence` | Hidden compatibility flags are refused by [board CLI](../../cli/src/lib/cli/board.ts); not recurring-task support. |
| Old top-level `create`, `runs`, `log`, `stop`, `resume`, `cancel`, `discard`, `version`, flow names, `cloud`; `studio diagram` | [moved](../../cli/src/lib/cli/moved.ts) and the Studio dispatcher print replacement/refusal. These are not working aliases. Use the commands listed above. |
| Hidden `__rules`, `__watch`, `raw agent-file`, `raw agent picks` | Still declared internal paths, explicitly included above; not advertised UI coverage. |

The current source tree is authoritative when help prose or older API notes disagree.

## Notes commands

- `akb studio rule <studio> [--text <text>|--file <path>]`: reads without text/file,
  replaces with text or UTF-8 file content, clears with empty text. Returns `studio`
  and `rule`; unknown names fail with `no-such-studio` and valid choices.
- `akb studio instructions <agent> [--text <text>|--file <path>]`: the same read,
  replace and clear behavior for this project's background tasks listed in
  `GET /v1/projects/{id}/agents`'s `board`. Returns `agent`, `rule`, `scope: project`.
  Never reads workspace Studio Agent rows. Unsupported names, including retired
  Studio/Preview names, fail with `no-such-agent`, list valid project choices and
  write nothing. It does not set schedules or runtime.
- Both require a Cloud-linked board and sign-in (`needs-cloud` otherwise);
  `--text` and `--file` are mutually exclusive. Cloud refusals use `cloud-refused`.

```sh
akb studio rule coding
akb studio rule coding --file notes.md
akb studio rule coding --text ''
akb studio instructions memory-pruner
akb studio instructions memory-pruner --file instructions.md
akb studio instructions memory-pruner --text ''
# Fails with no-such-agent; no writes.
akb studio instructions builder --text 'Old note'
```
