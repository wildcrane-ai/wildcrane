# HTTP coverage inventory

[Coverage and open gaps](coverage.md) · [AKB inventory](coverage-akb.md)

Checked **2026-11-17**, source baseline `8c60b6fb4299cdbe49b2a912b27727f699276fdc`.
Every method/path row is separate, including aliases and retired handlers still registered.
Commands below omit the `akb` prefix. `—` means no matching command or UI entry.
“Covered” describes the named operation, not every field accepted by its API.
Gap IDs refer to [the tracked UI gaps](coverage.md#ui-gaps).

## Cloud public and shared API

Service: Cloud Worker. Ordinary routes authenticate a session or API key subject to each
handler's access checks; `/shared/` routes use a share token and optional reviewer identity.
Source of route existence: `ROUTES` and `SHARED_ROUTES` in `cloud/src/v1/index.ts`.
The OpenAPI descriptions are supplementary; retired behavior and handler restrictions win.
The UI links name the entry; [Web calls](../../web/src/api.ts) and
[shared review calls](../../web/src/review/api.ts) supply the method, parameters and payload.
CLI handler sources are linked in [the command inventory](coverage-akb.md).

| Method and path | Purpose | AKB command / required parameters | UI entry | Coverage / gap | Route source |
| --- | --- | --- | --- | --- | --- |
| `GET /v1/shared/{token}` | Open a shared review | — | [Shared review](../../web/src/review/components/CardPage.tsx) | No AKB; G09 | [route](../../cloud/src/v1/index.ts#L967) |
| `GET /v1/shared/{token}/artifacts/{id}/versions/{version}/file` | Read a file of the shared task's artifacts | — | [Shared review: download](../../web/src/review/components/CardPage.tsx) | No AKB; G09 | [route](../../cloud/src/v1/index.ts#L968) |
| `POST /v1/shared/{token}/comments` | Comment through a share link | — | [Shared review: comment](../../web/src/review/components/CardPage.tsx) | No AKB; G09 | [route](../../cloud/src/v1/index.ts#L969) |
| `GET /v1/shared/{token}/components/{name}/{version}` | Read a component the shared task uses | — | [Shared review: Preview Component](../../web/src/review/components/CardPage.tsx) | No AKB; G09 | [route](../../cloud/src/v1/index.ts#L970) |
| `GET /v1/workspaces` | List your workspaces | `workspace list` | [Workspace switcher](../../web/src/components/Header.tsx) | Covered | [route](../../cloud/src/v1/index.ts#L975) |
| `POST /v1/workspaces` | Create a workspace | — | [Workspace switcher: new workspace](../../web/src/components/Header.tsx) | No AKB; G01 | [route](../../cloud/src/v1/index.ts#L976) |
| `GET /v1/workspaces/{id}` | Get a workspace | — | — | API only | [route](../../cloud/src/v1/index.ts#L977) |
| `PATCH /v1/workspaces/{id}` | Rename a workspace | — | [Workspace settings: name](../../web/src/components/Workspace.tsx) | No AKB; G01 | [route](../../cloud/src/v1/index.ts#L978) |
| `DELETE /v1/workspaces/{id}` | Delete a workspace | — | [Workspace settings: delete](../../web/src/components/Workspace.tsx) | No AKB; G01 | [route](../../cloud/src/v1/index.ts#L980) |
| `GET /v1/workspaces/{id}/stats` | Daily task counts and run usage of a workspace | — | [Stats: date range, timezone, model costs](../../web/src/pages/Stats.tsx) | No AKB; G14 | [route](../../cloud/src/v1/index.ts#L981) |
| `GET /v1/workspaces/{id}/members` | List a workspace's members | — | [Workspace settings: members](../../web/src/components/Workspace.tsx) | No AKB; G01 | [route](../../cloud/src/v1/index.ts#L983) |
| `POST /v1/workspaces/{id}/members` | Add a member | — | [Workspace settings: invite email](../../web/src/components/Workspace.tsx) | No AKB; G01 | [route](../../cloud/src/v1/index.ts#L984) |
| `PATCH /v1/workspaces/{id}/members/{account}` | Change a member's role | — | [Workspace settings: role](../../web/src/components/Workspace.tsx) | No AKB; G01 | [route](../../cloud/src/v1/index.ts#L988) |
| `DELETE /v1/workspaces/{id}/members/{account}` | Remove a member, or leave | — | [Workspace settings: remove or leave](../../web/src/components/Workspace.tsx) | No AKB; G01 | [route](../../cloud/src/v1/index.ts#L994) |
| `GET /v1/workspaces/{id}/studio-rules` | List the workspace's studio rules | `studio rule <studio> (read)` | [Studio detail: rules](../../web/src/pages/Studios.tsx) | Covered via scoped read; no general JSON listing | [route](../../cloud/src/v1/index.ts#L996) |
| `PUT /v1/workspaces/{id}/studios/{studio}/rule` | Set a studio's rule | `studio rule <studio> --text <text> or --file <path>` | [Studio detail: rules](../../web/src/pages/Studios.tsx) | Covered | [route](../../cloud/src/v1/index.ts#L997) |
| `GET /v1/workspaces/{id}/runners` | List the workspace's Runners | `runner list [--workspace <id>]` | [Computers](../../web/src/components/ComputerMenu.tsx) | Covered | [route](../../cloud/src/v1/index.ts#L1003) |
| `DELETE /v1/workspaces/{id}/runners/{machine}` | Remove a Runner | — | [Computers: remove](../../web/src/components/ComputerMenu.tsx) | No AKB; G03 | [route](../../cloud/src/v1/index.ts#L1004) |
| `PUT /v1/workspaces/{id}/runners/{machine}/share` | Share a computer with the workspace | — | [Computers: share](../../web/src/components/ComputerMenu.tsx) | No AKB; G03 | [route](../../cloud/src/v1/index.ts#L1007) |
| `DELETE /v1/workspaces/{id}/runners/{machine}/share` | Stop sharing a computer | — | [Computers: stop sharing](../../web/src/components/ComputerMenu.tsx) | No AKB; G03 | [route](../../cloud/src/v1/index.ts#L1009) |
| `PUT /v1/language` | Set your interface language | — | [Language selector](../../web/src/review/components/lang-select.tsx) | No AKB; G15 | [route](../../cloud/src/v1/index.ts#L1012) |
| `GET /v1/api-keys` | List active API keys | — | — | API only; no current UI | [route](../../cloud/src/v1/index.ts#L1018) |
| `POST /v1/api-keys` | Create an API key | — | — | API only; session required | [route](../../cloud/src/v1/index.ts#L1019) |
| `DELETE /v1/api-keys/{id}` | Revoke an API key | — | — | API only; session required | [route](../../cloud/src/v1/index.ts#L1020) |
| `GET /v1/projects` | List projects | `project list [--workspace <id>]` | [Project switcher](../../web/src/components/Header.tsx) | Covered | [route](../../cloud/src/v1/index.ts#L1025) |
| `POST /v1/projects` | Create a project | — | [Local settings: bind a new project](../../runner/src/settings.ts) | No AKB; G02 | [route](../../cloud/src/v1/index.ts#L1026) |
| `GET /v1/projects/{id}` | Get a project | `project list; task commands (scope lookup)` | [Project settings and board](../../web/src/pages/Settings.tsx) | Indirect read; no dedicated command | [route](../../cloud/src/v1/index.ts#L1027) |
| `PATCH /v1/projects/{id}` | Update a project | — | [Project settings: name](../../web/src/pages/Settings.tsx) | No AKB; G02 | [route](../../cloud/src/v1/index.ts#L1028) |
| `DELETE /v1/projects/{id}` | Delete a project | — | [Project settings: delete](../../web/src/pages/Settings.tsx) | No AKB; G02 | [route](../../cloud/src/v1/index.ts#L1030) |
| `GET /v1/projects/{id}/board` | Read the project's board files | `board conflict resolve <id>` reads current versions | [Task board/card](../../web/src/pages/Board.tsx) | Transport; G07 covers missing user-facing reads | [route](../../cloud/src/v1/index.ts#L1031) |
| `POST /v1/projects/{id}/board/archive-completions` | Reconcile completed archives after Runner sync | — | — | Normal archive receipts require synchronized card and asset versions. Managed Land uses its job finish report | [route](../../cloud/src/v1/index.ts) |
| `POST /v1/projects/{id}/board/commits` | Write what a Runner changed on the board | `board conflict resolve <id> --expect <revision> --file <path>` | — | Managed archives require the current Land job and lease; [conflict contract](board-conflicts.md) | [route](../../cloud/src/v1/index.ts#L1032) |
| `POST /v1/projects/{id}/import` | Import a local board's cards and files | — | — | API only: board import | [route](../../cloud/src/v1/index.ts#L1037) |
| `GET /v1/projects/{id}/agents` | List a project's agents | `studio instructions <agent> (read)` | [Project settings: agents](../../web/src/pages/Settings.tsx) | Partial: instructions view; G04 | [route](../../cloud/src/v1/index.ts#L1042) |
| `PUT /v1/projects/{id}/agents/{agent}` | Set an agent's schedule, or a board agent's rule | `studio instructions <agent> --text <text> or --file <path>` | [Project settings: rule and schedule](../../web/src/pages/Settings.tsx) | Partial: rule only, no schedule; G04 | [route](../../cloud/src/v1/index.ts#L1043) |
| `POST /v1/projects/{id}/agents/{agent}/run` | Run a scheduled agent now | `— (raw agent run starts a local scheduled agent)` | [Project settings: run agent now](../../web/src/pages/Settings.tsx) | No equivalent Cloud dispatch; G04 | [route](../../cloud/src/v1/index.ts#L1045) |
| `GET /v1/studios` | List studios | `studio; studio list; studio previews --triggers --studio <id> --workspace <id>` | [Studios: installed](../../web/src/pages/Studios.tsx) | Covered | [route](../../cloud/src/v1/index.ts#L1047) |
| `POST /v1/studios` | Create a studio | `studio create <folder> --request-id <id> [--workspace <id>]` | [Studio builder task: publish local files](../../web/src/pages/Studios.tsx) | Covered (agent-assisted UI) | [route](../../cloud/src/v1/index.ts#L1048) |
| `GET /v1/studios/{id}` | Get a studio | `studio pull <id> [folder]; studio clone <id> <folder>; studio push <folder> --dry-run` | [Studio detail](../../web/src/pages/Studios.tsx) | Covered | [route](../../cloud/src/v1/index.ts#L1049) |
| `PATCH /v1/studios/{id}` | Update a studio | `studio push <folder> [--request-id <id>]` | [Studio builder task: update local files](../../web/src/pages/Studios.tsx) | Covered (expected version from version.json) | [route](../../cloud/src/v1/index.ts#L1050) |
| `DELETE /v1/studios/{id}` | Delete a studio | — | [Studios: delete [force=true]](../../web/src/pages/Studios.tsx) | No AKB; G05 | [route](../../cloud/src/v1/index.ts#L1051) |
| `GET /v1/marketplace/studios` | List official studios | — | [Studios: discover](../../web/src/pages/Studios.tsx) | No AKB; G05 | [route](../../cloud/src/v1/index.ts#L1053) |
| `POST /v1/marketplace/studios` | Publish a studio folder | — | — | Publisher API only | [route](../../cloud/src/v1/index.ts#L1054) |
| `GET /v1/marketplace/studios/{id}` | Read an official studio | — | [Studio detail: official source](../../web/src/pages/Studios.tsx) | No AKB; G05 | [route](../../cloud/src/v1/index.ts#L1055) |
| `POST /v1/marketplace/studios/{id}/install` | Install an official studio | — | [Studios: install](../../web/src/pages/Studios.tsx) | No AKB; G05 | [route](../../cloud/src/v1/index.ts#L1056) |
| `POST /v1/marketplace/studios/{id}/uninstall` | Uninstall an official studio | — | [Studios: uninstall](../../web/src/pages/Studios.tsx) | No AKB; G05 | [route](../../cloud/src/v1/index.ts#L1057) |
| `POST /v1/marketplace/studios/{id}/clone` | Clone an official studio | — | [Studio detail: clone](../../web/src/pages/Studios.tsx) | No AKB; G05 | [route](../../cloud/src/v1/index.ts#L1058) |
| `GET /v1/runtimes` | List your runtimes | — | [AI tools/settings; conversation runtime chooser](../../web/src/components/Settings.tsx) | No AKB; G03 | [route](../../cloud/src/v1/index.ts#L1060) |
| `POST /v1/runtimes` | Add a runtime | — | [AI tools/settings: add runtime](../../web/src/components/Settings.tsx) | No AKB; G03 | [route](../../cloud/src/v1/index.ts#L1061) |
| `PATCH /v1/runtimes/{id}` | Update a runtime | — | [AI tools/settings: name, connector, model, settings, secrets](../../web/src/components/Settings.tsx) | No AKB; G03 | [route](../../cloud/src/v1/index.ts#L1062) |
| `DELETE /v1/runtimes/{id}` | Delete a runtime | — | [AI tools/settings: delete](../../web/src/components/Settings.tsx) | No AKB; G03 | [route](../../cloud/src/v1/index.ts#L1063) |
| `POST /v1/runtimes/{id}/test` | Test a runtime | `— (agent check checks local installation)` | [AI tools/settings: test connection](../../web/src/components/Settings.tsx) | No equivalent; G03 | [route](../../cloud/src/v1/index.ts#L1064) |
| `GET /v1/tasks` | List tasks | `task list [--project <id> or --workspace <id>] [--status <status>]` | [Board; archive](../../web/src/pages/Board.tsx) | Partial: no scope=active or requestKey query; G06 | [route](../../cloud/src/v1/index.ts#L1066) |
| `POST /v1/tasks` | Create a task | `task create <request...> --studio <id> [--project <id>]; task create --title <title> (linked project)` | [New task; triage: build now](../../web/src/pages/NewGoal.tsx) | Partial: see creation parameters in G06 | [route](../../cloud/src/v1/index.ts#L1067) |
| `GET /v1/tasks/{id}` | Get a task | `task show <task>` | [Task page](../../web/src/pages/CardPage.tsx) | Covered | [route](../../cloud/src/v1/index.ts#L1068) |
| `PATCH /v1/tasks/{id}` | Update a task during review or an active chat | — | — | Status, title and project updates are HTTP-only | [route](../../cloud/src/v1/index.ts#L1173) |
| `POST /v1/tasks/{id}/archive` | Archive and complete an eligible task | `task archive <task>` | — | Optional local card, attachment versions and Land evidence. Requires task write access and current review. | [route](../../cloud/src/v1/index.ts) |
| `POST /v1/tasks/{id}/cancel` | Cancel a task | `task remove <task> [reason...] [--discard]` | [Task: remove](../../web/src/pages/CardPage.tsx) | Covered | [route](../../cloud/src/v1/index.ts#L1075) |
| `POST /v1/tasks/{id}/stop` | Stop a running task | `task stop <task>` | [Task: stop execution](../../web/src/pages/CardPage.tsx) | Covered | [route](../../cloud/src/v1/index.ts#L1076) |
| `POST /v1/tasks/{id}/restore` | Restore a removed or completed task without starting | `task restore <task>` | [Archive/removed task: restore removed or completed task](../../web/src/components/Restore.tsx) | Covered; restores without starting | [route](../../cloud/src/v1/index.ts#L1077) |
| `POST /v1/tasks/{id}/discard` | Discard a build | `— (delivery cancel is local)` | [Task: discard build](../../web/src/pages/CardPage.tsx) | No equivalent Cloud operation; G07 | [route](../../cloud/src/v1/index.ts#L1078) |
| `GET /v1/tasks/{id}/runtimes` | List runtimes for the execute or resume action | `task resume --runtime <name-or-id>` | [Task operation](../../web/src/pages/CardPage.tsx) | G06 | [route](../../cloud/src/v1/index.ts#L1079) |
| `GET /v1/tasks/{id}/bill` | Read task cost details | — | [Task: cost bill](../../web/src/pages/CardPage.tsx) | No AKB; G07 | [route](../../cloud/src/v1/index.ts#L1080) |
| `GET /v1/tasks/{id}/handoff` | Retired handoff read | — | — | Retired: machine affinity removed | [route](../../cloud/src/v1/index.ts#L1081) |
| `POST /v1/tasks/{id}/handoff` | Retired handoff write | — | — | Retired: machine affinity removed | [route](../../cloud/src/v1/index.ts#L1082) |
| `POST /v1/tasks/{id}/execute` | Start work from the prepared review revision | — | [Task: Execute](../../web/src/pages/CardPage.tsx) | Atomic authorization of ready stages | [route](../../cloud/src/v1/index.ts) |
| `POST /v1/tasks/{id}/resume` | Resume the current Refine, Implement or Land step with its saved input and session. Accepts optional `machine` and `runtime` | `task resume <task> --runtime <name-or-id>` | [Task: resume](../../web/src/pages/CardPage.tsx) | G06 | [route](../../cloud/src/v1/index.ts#L1083) |
| `GET /v1/tasks/{id}/studio` | Get a task's studio version | `studio file <studio> <path> (pinned files)` | [Task: Studio/Preview instructions](../../web/src/pages/CardPage.tsx) | Partial indirect read, no dedicated JSON view; G07 | [route](../../cloud/src/v1/index.ts#L1089) |
| `GET /v1/tasks/{id}/card` | Read the task's card | `task show <task>; task update-questions <task> (baseline)` | [Task: card sheet](../../web/src/pages/CardPage.tsx) | Covered (show returns body) | [route](../../cloud/src/v1/index.ts#L1090) |
| `GET /v1/tasks/{id}/subtasks` | Get a group root's subtasks | `— (task inspect reads local facts)` | [Task: subtasks](../../web/src/pages/CardPage.tsx) | No Cloud read command; G07 | [route](../../cloud/src/v1/index.ts#L1091) |
| `GET /v1/tasks/{id}/diff` | Get a task's landed changes | — | [Task: landed changes](../../web/src/pages/CardPage.tsx) | No AKB; G07 | [route](../../cloud/src/v1/index.ts#L1092) |
| `PATCH /v1/tasks/{id}/questions` | Edit the task's open questions | `task update-questions <task> --append/--update/--drop/--clear; choices --option/--recommended-option/--mode/--agent` | [Task: answer/drop questions](../../web/src/pages/CardPage.tsx) | Covered for direct Cloud edits; baseline read automatically | [route](../../cloud/src/v1/index.ts#L1093) |
| `PUT /v1/tasks/{id}/card` | Save the task's card | `— (edit local body, Runner sync)` | — | Agent/API write; not an editor UI gap | [route](../../cloud/src/v1/index.ts#L1098) |
| `PUT /v1/tasks/{id}/chat/computer` | Retired chat computer selection | — | — | Retired: machine affinity removed | [route](../../cloud/src/v1/index.ts#L1105) |
| `GET /v1/reply-images/{id}` | Read a private reply image | — | [Task/discussion chat: reply images](../../web/src/review/components/ai-chat.tsx) | No dedicated image retrieval in AKB; G08 | [route](../../cloud/src/v1/index.ts#L1107) |
| `GET /v1/tasks/{id}/chat` | Read your chat on a task | `task chat <task> [--limit <n> or --all] [--follow]` | [Task: AI chat](../../web/src/pages/CardPage.tsx) | Partial: text/state, no image display; G08 | [route](../../cloud/src/v1/index.ts#L1108) |
| `POST /v1/tasks/{id}/chat` | Ask the agent on a task | `task chat <task> <message...>` | [Task: AI chat send](../../web/src/pages/CardPage.tsx) | Partial: body only; no images/runtime; G08 | [route](../../cloud/src/v1/index.ts#L1109) |
| `DELETE /v1/tasks/{id}/chat` | Clear your chat on a task. Your next message starts a new session | — | [Task: clear chat](../../web/src/pages/CardPage.tsx) | No AKB; G08 | [route](../../cloud/src/v1/index.ts#L1111) |
| `POST /v1/tasks/{id}/chat/continue` | Retry or continue the latest failed task reply | — | [Task: retry/continue reply, choose runtime](../../web/src/pages/CardPage.tsx) | No AKB; G08 | [route](../../cloud/src/v1/index.ts#L1112) |
| `POST /v1/tasks/{id}/chat/stop` | Stop the agent's reply on a task | `task chat <task> --stop` | [Task: stop reply](../../web/src/pages/CardPage.tsx) | Covered (separate from execution stop) | [route](../../cloud/src/v1/index.ts#L1113) |
| `GET /v1/chats` | List your chats | — | [Chats: project, waiting, external source](../../web/src/pages/Chats.tsx) | No AKB; G10 | [route](../../cloud/src/v1/index.ts#L1114) |
| `POST /v1/discussions` | Start a discussion | `— (goal new opens an external-host discussion)` | [New discussion: send a message with text/images/runtime](../../web/src/pages/NewGoal.tsx) | No equivalent; G10 | [route](../../cloud/src/v1/index.ts#L1123) |
| `POST /v1/discussions/external` | Open an external-host discussion (not only Claude Code) | `goal new (host session; no explicit discussion selector)` | [Chats: external-host conversation](../../web/src/pages/Chats.tsx) | Indirect/session-bound support | [route](../../cloud/src/v1/index.ts#L1124) |
| `GET /v1/discussions/{id}` | Read a discussion | `goal new/save/drop/start (context read)` | [Discussion page](../../web/src/pages/Discussion.tsx) | Partial: no read/list command; G10 | [route](../../cloud/src/v1/index.ts#L1126) |
| `DELETE /v1/discussions/{id}` | Delete a discussion | — | [Chats: delete discussion](../../web/src/pages/Chats.tsx) | No AKB; G10 | [route](../../cloud/src/v1/index.ts#L1127) |
| `POST /v1/discussions/{id}/chat` | Send a message in a discussion | — | [Discussion: send text/images, select runtime](../../web/src/pages/Discussion.tsx) | No AKB; G10 | [route](../../cloud/src/v1/index.ts#L1128) |
| `DELETE /v1/discussions/{id}/chat` | Clear a discussion's messages | — | [Discussion: clear](../../web/src/pages/Discussion.tsx) | No AKB; G10 | [route](../../cloud/src/v1/index.ts#L1130) |
| `PUT /v1/discussions/{id}/draft` | Save a discussion's goals | `goal new --title <text> --body-file <path> --studio <id>; goal save --id <goal> [fields]` | [Agent drafts shown in discussion](../../web/src/pages/Discussion.tsx) | Covered in current conversation (expectedVersion automatic) | [route](../../cloud/src/v1/index.ts#L1131) |
| `POST /v1/discussions/{id}/chat/continue` | Retry or continue the latest failed discussion reply | — | [Discussion: retry/continue](../../web/src/pages/Discussion.tsx) | No AKB; G10 | [route](../../cloud/src/v1/index.ts#L1132) |
| `POST /v1/discussions/{id}/chat/stop` | Stop the agent's reply | — | [Discussion: stop reply](../../web/src/pages/Discussion.tsx) | No AKB; G10 | [route](../../cloud/src/v1/index.ts#L1133) |
| `PATCH /v1/discussions/{id}/goals/{goal}` | Change a Goal's studio | `goal save --id <goal> --studio <id> (via whole draft)` | [Discussion: change Studio](../../web/src/pages/Discussion.tsx) | Indirect/session-bound; G11 | [route](../../cloud/src/v1/index.ts#L1140) |
| `DELETE /v1/discussions/{id}/goals/{goal}` | Withdraw a Goal | `goal drop --id <goal> (via whole draft)` | [Discussion: drop goal](../../web/src/pages/Discussion.tsx) | Covered in current conversation | [route](../../cloud/src/v1/index.ts#L1143) |
| `POST /v1/discussions/{id}/goals/{goal}/start` | Start or refine a Goal | `goal start --id <goal>` | [Discussion: Goal actions](../../web/src/pages/Discussion.tsx) | Partial: no project/action/machine; G11 | [route](../../cloud/src/v1/index.ts#L1145) |
| `GET /v1/triage` | List triage items | `— (triage check reads local source identity)` | [Triage: open/history, project, state, order](../../web/src/pages/Triage.tsx) | No equivalent Cloud listing; G12 | [route](../../cloud/src/v1/index.ts#L1147) |
| `POST /v1/triage` | Propose a triage item | `— (triage add writes local board)` | — | API only; raw item sync is indirect | [route](../../cloud/src/v1/index.ts#L1148) |
| `POST /v1/triage/{id}/dismiss` | Dismiss a triage item | — | [Triage: dismiss, reason](../../web/src/pages/Triage.tsx) | No AKB; G12 | [route](../../cloud/src/v1/index.ts#L1149) |
| `POST /v1/triage/{id}/restore` | Restore a dismissed triage item | — | [Triage: restore](../../web/src/pages/Triage.tsx) | No AKB; G12 | [route](../../cloud/src/v1/index.ts#L1151) |
| `GET /v1/rejections` | List what the planner has not learned | `raw review-dismissals (agent reads)` | — | Agent/internal workflow, not a UI gap | [route](../../cloud/src/v1/index.ts#L1152) |
| `POST /v1/rejections/reviewed` | Mark rejections learned | `raw review-dismissals (agent marks learned)` | — | Agent/internal workflow, not a UI gap | [route](../../cloud/src/v1/index.ts#L1153) |
| `GET /v1/tasks/{id}/guests` | List a task's guests | — | [Task: Share, guest list](../../web/src/pages/CardPage.tsx) | No AKB; G09 | [route](../../cloud/src/v1/index.ts#L1155) |
| `PUT /v1/tasks/{id}/guests/{email}` | Invite a guest to a task | — | [Task: Share, invite guest/lang/share_token](../../web/src/pages/CardPage.tsx) | No AKB; G09 | [route](../../cloud/src/v1/index.ts#L1156) |
| `DELETE /v1/tasks/{id}/guests/{email}` | Remove a guest from a task | — | [Task: Share, remove guest](../../web/src/pages/CardPage.tsx) | No AKB; G09 | [route](../../cloud/src/v1/index.ts#L1157) |
| `POST /v1/tasks/{id}/review` | Propose a plan, report status or revise a node | `task review` | Task review plan and nodes | Versioned writes; questions stay independent | [route](../../cloud/src/v1/index.ts#L1160) |
| `GET /v1/tasks/{id}/comments` | List a task's comments | — | [Task: comments](../../web/src/pages/CardPage.tsx) | No AKB; G09 | [route](../../cloud/src/v1/index.ts#L1163) |
| `POST /v1/tasks/{id}/comments` | Comment on a task | `task comment <task> <text...>` | [Task: comment](../../web/src/pages/CardPage.tsx) | Covered; session required | [route](../../cloud/src/v1/index.ts#L1167) |
| `GET /v1/tasks/{id}/share-links` | List a task's share links | — | [Task: Share](../../web/src/pages/CardPage.tsx) | No AKB; G09 | [route](../../cloud/src/v1/index.ts#L1174) |
| `POST /v1/tasks/{id}/share-links` | Share a task | — | [Task: Share, invited/anyone](../../web/src/pages/CardPage.tsx) | No AKB; G09 | [route](../../cloud/src/v1/index.ts#L1175) |
| `PATCH /v1/share-links/{id}` | Change who a share link admits | — | [Task: Share, change access](../../web/src/pages/CardPage.tsx) | No AKB; G09 | [route](../../cloud/src/v1/index.ts#L1176) |
| `DELETE /v1/share-links/{id}` | Revoke a share link | — | [Task: Share, revoke](../../web/src/pages/CardPage.tsx) | No AKB; G09 | [route](../../cloud/src/v1/index.ts#L1178) |
| `GET /v1/tasks/{id}/artifacts` | List a task's artifacts | — | — | API only: enumerate artifacts | [route](../../cloud/src/v1/index.ts#L1180) |
| `POST /v1/tasks/{id}/artifacts` | Create an artifact | `— (Runner asset sync)` | — | Producer transport | [route](../../cloud/src/v1/index.ts#L1182) |
| `GET /v1/artifacts/{id}` | Get an artifact | — | [Task: load Preview](../../web/src/pages/CardPage.tsx) | No AKB; G09 | [route](../../cloud/src/v1/index.ts#L1186) |
| `POST /v1/artifacts/{id}/versions` | Submit a new version | `— (Runner sync publishes files)` | [Preview Component: save edited content/pin](../../web/src/review/lib/artifacts.ts) | Partial indirect file producer; no content/pin command; G09 | [route](../../cloud/src/v1/index.ts#L1187) |
| `GET /v1/artifacts/{id}/versions/{version}` | Get a version | — | [Task: Preview version](../../web/src/pages/CardPage.tsx) | No AKB; G09 | [route](../../cloud/src/v1/index.ts#L1188) |
| `GET /v1/artifacts/{id}/versions/{version}/file` | Download a version's file | — | [Task: Preview file/download](../../web/src/pages/CardPage.tsx) | No AKB; G09 | [route](../../cloud/src/v1/index.ts#L1189) |
| `GET /v1/artifacts/{id}/versions/{version}/component` | Read the component a version is pinned to | — | [Task: load pinned Preview Component](../../web/src/pages/CardPage.tsx) | No AKB; G09 | [route](../../cloud/src/v1/index.ts#L1190) |
| `POST /v1/artifacts/{id}/uploads` | Start a file upload | `— (Runner asset sync)` | — | Producer transport | [route](../../cloud/src/v1/index.ts#L1192) |
| `PUT /v1/uploads/{id}` | Upload a file | `— (Runner asset sync)` | — | Producer transport | [route](../../cloud/src/v1/index.ts#L1193) |
| `PUT /v1/uploads/{id}/parts/{part}` | Upload one part of a file | `— (Runner asset sync)` | — | Producer transport | [route](../../cloud/src/v1/index.ts#L1194) |
| `POST /v1/uploads/{id}/complete` | Complete a file sent in parts | `— (Runner asset sync)` | — | Producer transport | [route](../../cloud/src/v1/index.ts#L1195) |
| `GET /v1/tasks/{id}/decisions` | List a task's decisions | `— (Runner memory review reads)` | [Task: review history](../../web/src/pages/CardPage.tsx) | No user read command; G09 | [route](../../cloud/src/v1/index.ts#L1197) |
| `POST /v1/tasks/{id}/decisions` | Approve or request changes; optional approval after reply | `task approve <task> --revision <n> [--stage <id>]` | Task chat: explicit stage decision | Versioned stage approval | [route](../../cloud/src/v1/index.ts#L1199) |
| `GET /v1/components` | List the account's components | `— (raw components reads local docs)` | — | Component publisher API; different from raw command | [route](../../cloud/src/v1/index.ts#L1213) |
| `POST /v1/components` | Publish a component version | — | — | Component publisher API | [route](../../cloud/src/v1/index.ts#L1214) |
| `GET /v1/components/{name}` | Read a component and its versions | — | — | Component publisher API | [route](../../cloud/src/v1/index.ts#L1215) |
| `PUT /v1/components/{name}/versions/{version}/bundle` | Upload a version's bundle | — | — | Component publisher API | [route](../../cloud/src/v1/index.ts#L1216) |
| `DELETE /v1/components/{name}/versions/{version}` | Remove a component version | — | — | Component publisher API | [route](../../cloud/src/v1/index.ts#L1218) |
| `GET /v1/alerts` | List unread alerts | — | [Notification bell](../../web/src/components/Notifications.tsx) | No AKB; G16 | [route](../../cloud/src/v1/index.ts#L1221) |
| `POST /v1/alerts/{id}/read` | Mark an alert read | — | [Notification bell: mark read](../../web/src/components/Notifications.tsx) | No AKB; G16 | [route](../../cloud/src/v1/index.ts#L1222) |
| `GET /v1/events` | List events | — | [Live task/board/chat updates](../../web/src/stream.ts) | UI transport; not a separate feature gap | [route](../../cloud/src/v1/index.ts#L1224) |
| `GET /v1/events/stream` | Stream events | — | [Live task/board/chat updates (SSE)](../../web/src/stream.ts) | UI transport; not a separate feature gap | [route](../../cloud/src/v1/index.ts#L1225) |

## Cloud service and compatibility routes

Service: Cloud Worker. Compatibility means still reachable in the current router, not a claim that the frozen `legacy` UI is shipped on `main`.

| Method and path | Purpose / access | AKB | UI entry | Coverage / classification | Source |
| --- | --- | --- | --- | --- | --- |
| `GET /health` | Liveness, no authentication | — | — | Service | [index.ts](../../cloud/src/index.ts) |
| `GET /pricing` | Public pricing HTML | — | External pricing page | Public page, no AKB | [index.ts](../../cloud/src/index.ts) |
| `GET /v1/openapi.json` | Public API schema, no authentication | — | — | API discovery | [index.ts](../../cloud/src/v1/index.ts) |
| `GET /v1/session` | Verified account and admission state | `account` | Web sign-in/account | Covered | [index.ts](../../cloud/src/index.ts) |
| `POST /v1/invite-request` | Verified but unadmitted account requests admission | — | — | API only; not an active Web entry | [index.ts](../../cloud/src/index.ts) |
| `POST /v1/self-check` | Admitted account; post-deploy write check | — | — | Operations only | [index.ts](../../cloud/src/index.ts) |
| `POST /v1/boards` | Register a local board | — | — | Compatibility API, no current UI/CLI caller | [index.ts](../../cloud/src/index.ts) |
| `POST /v1/boards/{board}/server` | Attach a board server | — | — | Compatibility API | [index.ts](../../cloud/src/index.ts) |
| `POST /v1/boards/{board}/server/detach` | Detach a board server | — | — | Compatibility API | [index.ts](../../cloud/src/index.ts) |
| `GET /v1/servers` | List servers | — | — | Compatibility API | [index.ts](../../cloud/src/index.ts) |
| `GET /v1/servers/{server}/requests` | List server requests | — | — | Compatibility API | [index.ts](../../cloud/src/index.ts) |
| `POST /v1/requests/{id}/claim` | Claim request | — | — | Compatibility API | [index.ts](../../cloud/src/index.ts) |
| `POST /v1/requests/{id}/renew` | Renew claim | — | — | Compatibility API | [index.ts](../../cloud/src/index.ts) |
| `GET /v1/events` | Old board event feed (session without after) | — | — | Compatibility branch; see dispatch note | [index.ts](../../cloud/src/index.ts) |
| `POST /v1/events` | Publish old board event | — | — | Compatibility branch; see dispatch note | [index.ts](../../cloud/src/index.ts) |
| `GET /v1/events/{id}` | Read old event | — | — | Compatibility API | [index.ts](../../cloud/src/index.ts) |
| `POST /v1/events/{id}/retire` | Retire old event | — | — | Compatibility API | [index.ts](../../cloud/src/index.ts) |
| `POST /v1/events/{id}/action` | Record old event action | — | — | Compatibility API | [index.ts](../../cloud/src/index.ts) |
| `POST /v1/events/{id}/outcome` | Record old event outcome | — | — | Compatibility API | [index.ts](../../cloud/src/index.ts) |
| `POST /v1/watch-summary` | Post changed-scope summary to connected chat | — | — | Compatibility API | [index.ts](../../cloud/src/index.ts) |
| `POST /v1/slack/install` | Begin account-bound OAuth consent | — | — | API only; no current UI caller | [index.ts](../../cloud/src/index.ts) |
| `GET /v1/slack/connection` | Read connection | — | — | API only | [index.ts](../../cloud/src/index.ts) |
| `GET /v1/slack/conversations` | List reachable channels and DM | — | — | API only | [index.ts](../../cloud/src/index.ts) |
| `POST /v1/slack/destination` | Choose channelId/channelName | — | — | API only | [index.ts](../../cloud/src/index.ts) |
| `POST /v1/slack/disconnect` | Disconnect/revoke | — | — | API only | [index.ts](../../cloud/src/index.ts) |
| `GET /v1/slack/installed` | OAuth nonce return | — | Slack redirect | Callback, excluded from gaps | [index.ts](../../cloud/src/index.ts) |
| `POST /v1/slack/actions` | Signed interaction body | — | Slack interactive message | Callback, excluded from gaps | [index.ts](../../cloud/src/index.ts) |
| `GET /v1/lark/connection` | Read connection | — | — | API only | [index.ts](../../cloud/src/index.ts) |
| `GET /v1/lark/chats` | List reachable chats | — | — | API only | [index.ts](../../cloud/src/index.ts) |
| `POST /v1/lark/destination` | Choose destinationId/destinationName/direct | — | — | API only | [index.ts](../../cloud/src/index.ts) |
| `POST /v1/lark/disconnect` | Disconnect | — | — | API only | [index.ts](../../cloud/src/index.ts) |
| `POST /v1/lark/{cloud}/connect` | Begin OAuth; cloud is feishu or lark | — | — | API only | [index.ts](../../cloud/src/index.ts) |
| `GET /v1/lark/{cloud}/connected` | OAuth nonce return | — | Lark/Feishu redirect | Callback, excluded from gaps | [index.ts](../../cloud/src/index.ts) |
| `POST /v1/lark/{cloud}/callback` | Encrypted/signed events and challenge | — | Lark/Feishu message | Callback, excluded from gaps | [index.ts](../../cloud/src/index.ts) |
| `GET /card/{board}/{task}` | Redirect to ai4kanban://card/… | — | External card link | Compatibility redirect | [index.ts](../../cloud/src/index.ts) |
| `POST /v1/speech` | Generate narration; WildCrane API balance | `tts <text...> --voice <name> [--tier <tier>] --out <file>` | — | Covered; no current Web generator | [index.ts](../../cloud/src/index.ts) |
| `POST /v1/image` | Generate image; WildCrane API balance | `image <prompt...> --aspect <ratio> [--tier <tier>] [--ref <file>] --out <file>` | — | Covered; no current Web generator | [index.ts](../../cloud/src/index.ts) |
| `POST /v1/music` | Generate instrumental track; WildCrane API balance | `music <prompt...> [--seconds <n>] --out <file>` | — | Covered; no current Web generator | [index.ts](../../cloud/src/index.ts) |
| `POST /v1/transcriptions` | Queue transcription of a task audio artifact version | `transcribe` | — | Covered | [transcriptions.ts](../../cloud/src/transcriptions.ts) |
| `GET /v1/transcriptions?artifact=…&version=…` | Read the caller's most recently accepted job for an audio version | — | — | Public API | [transcriptions.ts](../../cloud/src/transcriptions.ts) |
| `GET /v1/transcriptions/{id}` | Read a transcription job and its result | `transcribe` | — | Covered | [transcriptions.ts](../../cloud/src/transcriptions.ts) |

`/v1/events` dispatch is conditional: `after` or an API-key bearer selects public V1;
a session without `after` selects the old feed. Public V1 has only GET here, so POST with
an API key or `after` is refused. Do not count both GET branches as distinct UI features.

## Cloud billing

Service: Cloud Worker; verified session except the signed Creem webhook. UI calls: [Billing](../../web/src/components/Billing.tsx), [Subscribe](../../web/src/pages/Subscribe.tsx), [Web API](../../web/src/api.ts).

| Method and path | Purpose / access | AKB | UI entry | Coverage / classification | Source |
| --- | --- | --- | --- | --- | --- |
| `GET /v1/pricing` | Read the public hosting, top-up and API catalog | — | Pricing | Public | [billing-catalog.ts](../../cloud/src/billing-catalog.ts) |
| `GET /v1/billing` | Read plan, renewal price, limits, API balance and pricing | — | Settings/Subscribe | No billing/quota command; G13 | [billing.ts](../../cloud/src/billing.ts) |
| `POST /v1/billing/trial` | Start trial | — | Settings/Subscribe | No AKB; G13 | [billing.ts](../../cloud/src/billing.ts) |
| `POST /v1/billing/checkout` | Buy Pro, storage or an API top-up | — | Subscribe/Top up | No AKB; G13 (storage is API-only here) | [billing.ts](../../cloud/src/billing.ts) |
| `POST /v1/billing/confirm` | Confirm checkoutId or subscriptionId | — | Checkout return | No AKB; G13 | [billing.ts](../../cloud/src/billing.ts) |
| `POST /v1/billing/portal` | Open customer billing portal | — | Settings: manage billing | No AKB; G13 | [billing.ts](../../cloud/src/billing.ts) |
| `POST /v1/billing/resume` | Undo scheduled subscription cancellation | — | — | API only; no current UI caller | [billing.ts](../../cloud/src/billing.ts) |
| `GET /v1/billing/invoices` | Read invoices | — | — | API only; no current UI caller | [billing.ts](../../cloud/src/billing.ts) |
| `POST /v1/billing/webhook` | Signed provider event | — | Creem | Callback, excluded from gaps | [billing.ts](../../cloud/src/billing.ts) |

## Cloud Runner protocol

Service: Cloud Worker, consumed by [Runner API](../../runner/src/api.ts). These routes use the account session plus machine/job claims; they are not general API-key commands. Web reads are identified separately.

| Method and path | Purpose / access | AKB | UI entry | Coverage / classification | Source |
| --- | --- | --- | --- | --- | --- |
| `GET /v1/runner/version` | Target version; machine, optional alpha=true/false; unauthenticated | — | Local settings: update channel | Internal launcher transport; local UI gap G17 | [runners.ts](../../cloud/src/runners.ts) |
| `GET /v1/runner` | Read registered Runner | — | Web computer setup; local settings | Transport read; runner list covers workspace listing | [runners.ts](../../cloud/src/runners.ts) |
| `POST /v1/runner` | Register version/runtimes/secrets/protocol/akbContract | — | — | After task session cutover, requires protocol 34 and AKB contract 42 or later | [runners.ts](../../cloud/src/runners.ts) |
| `POST /v1/runner/release` | Release machine ownership | — | Local settings: sign out | Internal revocation; account sign-out is local only, G17 | [runners.ts](../../cloud/src/runners.ts) |
| `GET /v1/runner/presence` | WebSocket; machine UUID | — | — | Internal presence transport | [runners.ts](../../cloud/src/runners.ts) |
| `GET /v1/runner/folders` | machine; elsewhere=1 lists unbound projects | `goal new (scope lookup)` | Project folders/local settings | Partial indirect lookup; G02 | [runners.ts](../../cloud/src/runners.ts) |
| `POST /v1/runner/folders` | Bind machineId/name/path, optional project | — | Local settings: bind folder | No AKB; G02 | [runners.ts](../../cloud/src/runners.ts) |
| `POST /v1/runner/folders/{project}/remove` | Unbind machineId/project | — | Project folders/local settings | No AKB; G02 | [runners.ts](../../cloud/src/runners.ts) |
| `GET /v1/runner/chats` | Archived task chats for this machine | — | — | Internal memory-review selection | [runners.ts](../../cloud/src/runners.ts) |
| `GET /v1/runner/tasks` | Running/queued machine tasks | — | — | Plugin client transport; task list is workspace/project scoped | [runners.ts](../../cloud/src/runners.ts) |
| `POST /v1/runner/reviews` | Dispatch archived-chat review job | — | — | Internal review dispatch | [runners.ts](../../cloud/src/runners.ts) |
| `GET /v1/runner/agents` | machine/project; due scheduled agents | — | — | Internal scheduling | [runners.ts](../../cloud/src/runners.ts) |
| `GET /v1/runner/jobs` | Read this machine's jobs | — | — | Protocol 34 for new claims. Omits waiting Land while the project lease is held | [runners.ts](../../cloud/src/runners.ts) |
| `POST /v1/runner/jobs` | Dispatch job or request periodic agent | — | — | Internal dispatch | [runners.ts](../../cloud/src/runners.ts) |
| `GET /v1/runner/jobs/{job}` | Read job state/progress | `task chat <task> [--follow] (reply job only)` | Task/discussion chat; run log | Phased jobs include `flow.phase` and Land includes `flow.land_from`; G07 | [runners.ts](../../cloud/src/runners.ts) |
| `POST /v1/runner/jobs/{job}/claim` | Claim with machineId | — | — | Task jobs include `sessionKind` (`refine`, `implement`, `land` or `card_chat`). Binds the session and claims the project Land lease atomically | [runners.ts](../../cloud/src/runners.ts) |
| `POST /v1/runner/jobs/{job}/renew` | Renew machineId and progress | `raw in-run commands (lease side effect)` | — | Renews the current lease and returns a stop signal. Expired Land jobs are refused | [runners.ts](../../cloud/src/runners.ts) |
| `POST /v1/runner/jobs/{job}/finish` | Outcome and report | — | — | A task job can report `session`, `sessionCostUsd` or `sessionReset` on success, failure or stop. Implement reports `landReady: { deliveryId? }`. Land reports `archive: { path, seq, assets_seq }` and optional `landing: { commit, branch }` | [runners.ts](../../cloud/src/runners.ts) |
| `POST /v1/runner/jobs/{job}/approve` | Reserve/cancel reply approval | `task approve <task> (via local reply bridge)` | Task: approval after reply | Internal bridge; no direct job command | [runners.ts](../../cloud/src/runners.ts) |
| `GET /v1/runner/jobs/{job}/stream` | WebSocket; machine for producer, after for reader | `task chat <task> --follow (reply only)` | Task/discussion: run log | Partial: reply follow only; G07 | [runners.ts](../../cloud/src/runners.ts) |
| `PUT /v1/runner/jobs/{job}/images/{key}` | Upload reply image; machine; key is SHA-256 | — | — | Internal image producer | [runners.ts](../../cloud/src/runners.ts) |
| `POST /v1/runner/diffs/{id}` | Answer requested commit diff | — | — | Internal producer; consumer gap is task diff G07 | [runners.ts](../../cloud/src/runners.ts) |

## Cloud templates and catalog

Service: Cloud Worker. Templates require a verified session; file access may require Pro and publication requires publisher rights. Public catalog permits GET and HEAD (listed separately); its external website is not a current `web/src` UI entry.

| Method and path | Purpose / access | AKB | UI entry | Coverage / classification | Source |
| --- | --- | --- | --- | --- | --- |
| `GET /v1/templates` | Search category/tags/query/limit | `template search [words...] --category <category> --tags <tags> [--limit <n>]` | — | Covered | [templates.ts](../../cloud/src/templates.ts) |
| `POST /v1/templates` | Publish multipart template files/metadata | `template publish <dir> [--preview <file>] [--evidence <file>] [--replace]` | — | Covered, publisher only | [templates.ts](../../cloud/src/templates.ts) |
| `GET /v1/templates/tags` | Read category tags | `template list-tags --category <category>` | — | Covered | [templates.ts](../../cloud/src/templates.ts) |
| `GET /v1/templates/{name}` | Read metadata and file manifest | `template get <name> --to <dir>` | — | Covered | [templates.ts](../../cloud/src/templates.ts) |
| `DELETE /v1/templates/{name}` | Remove template | `template delete <name>` | — | Covered, publisher only | [templates.ts](../../cloud/src/templates.ts) |
| `PUT /v1/templates/{name}/showcase` | Register showcase files | `template showcase <name> <dir>` | External catalog | Covered, publisher only | [templates.ts](../../cloud/src/templates.ts) |
| `GET /v1/templates/{name}/source` | Source and evidence manifest | `template source <name> [--to <dir>]` | — | Covered | [templates.ts](../../cloud/src/templates.ts) |
| `GET /v1/templates/{name}/previews` | Preview manifest | `template preview <name> --to <dir>` | — | Covered | [templates.ts](../../cloud/src/templates.ts) |
| `GET /v1/templates/{name}/files/{path...}` | Download template file | `template get <name> --to <dir>` | — | Covered, manifest checked | [templates.ts](../../cloud/src/templates.ts) |
| `GET /v1/templates/{name}/previews/{path...}` | Download preview file | `template preview <name> --to <dir>` | — | Covered | [templates.ts](../../cloud/src/templates.ts) |
| `GET /v1/templates/{name}/evidence/{path...}` | Download evidence | `template source <name> --to <dir>` | — | Covered | [templates.ts](../../cloud/src/templates.ts) |
| `GET /v1/catalog` | Public categories/cards | — | External catalog | Public read; template search is an authenticated alternative | [catalog.ts](../../cloud/src/catalog.ts) |
| `HEAD /v1/catalog` | Public catalog headers | — | — | Public transport | [catalog.ts](../../cloud/src/catalog.ts) |
| `GET /v1/catalog/{name}` | Public template detail | — | External catalog | Public read; no current repository UI gap | [catalog.ts](../../cloud/src/catalog.ts) |
| `HEAD /v1/catalog/{name}` | Public detail headers | — | — | Public transport | [catalog.ts](../../cloud/src/catalog.ts) |
| `GET /v1/catalog/{name}/media/{version}/{path}` | Public registered preview/showcase media; one encoded path segment | — | External catalog | Public media transport | [catalog.ts](../../cloud/src/catalog.ts) |
| `HEAD /v1/catalog/{name}/media/{version}/{path}` | Media headers/ranges | — | — | Public transport | [catalog.ts](../../cloud/src/catalog.ts) |

## Cloud training and contact

Service: Cloud Worker. External site consumers; no current Web app callers, so these are not AKB UI gaps.

| Method and path | Purpose / access | AKB | UI entry | Coverage / classification | Source |
| --- | --- | --- | --- | --- | --- |
| `GET /v1/training/availability` | Public booking availability | — | External training site | Public website API | [training.ts](../../cloud/src/training.ts) |
| `POST /v1/training/bookings` | Book slot, contact details and verification | — | External training site | Public website API | [training.ts](../../cloud/src/training.ts) |
| `GET /v1/training/records` | Operator booking records, operator authentication | — | — | Operator API | [training.ts](../../cloud/src/training.ts) |
| `GET /v1/training/bookings/{reference}` | Read booking with token query | — | External manage link | Token-scoped website API | [training.ts](../../cloud/src/training.ts) |
| `POST /v1/training/bookings/{reference}/cancel` | Cancel booking with token body | — | External manage link | Token-scoped website API | [training.ts](../../cloud/src/training.ts) |
| `POST /v1/contact` | Submit contact form (optional trailing slash) | — | External contact site | Public website API | [contact.ts](../../cloud/src/contact.ts) |

## Cloud relays and component host

Service: Cloud Worker. Relays preserve upstream authentication; they are not extra business operations to add to AKB.

Web builds use `VITE_API_URL` (default `https://api.wildcrane.ai`) for the auth relay, `/v1` HTTP,
SSE and run log WebSockets. The Web Cookie origin is `https://app.wildcrane.ai`.
With `x-wildcrane-session: cookie`, OTP verification and PKCE or refresh grants return
`{ expires_at?, expires_in?, user? }` and set host-only `HttpOnly; Secure; SameSite=Lax` cookies.
`wc_access` uses `/`; `wc_refresh` uses `/auth/v1`. Native clients use the original API domain.

| Method and path | Purpose / access | AKB | UI entry | Coverage / classification | Source |
| --- | --- | --- | --- | --- | --- |
| `POST /auth/v1/otp` | Send sign-in code | — | Web/local sign-in | Authentication transport; local sign-in G17 | [auth-relay.ts](../../cloud/src/auth-relay.ts) |
| `POST /auth/v1/verify` | Verify sign-in code | — | Web/local sign-in | Authentication transport | [auth-relay.ts](../../cloud/src/auth-relay.ts) |
| `POST /auth/v1/token` | Exchange pkce or refresh_token grant | `account (refresh side effect)` | Web/local sign-in | Authentication transport | [auth-relay.ts](../../cloud/src/auth-relay.ts) |
| `POST /auth/v1/logout` | Revoke the current Web session and clear both cookies (`204`) | — | Web sign-out | Authentication transport | [auth-relay.ts](../../cloud/src/auth-relay.ts) |
| `GET /realtime/v1/websocket` | Realtime WebSocket upgrade; upstream private-topic authorization | — | — | Internal client transport | [realtime-relay.ts](../../cloud/src/realtime-relay.ts) |
| `GET https://{hash}.{COMPONENT_HOST}/{path...}` | Serve immutable Preview Component bundle (empty/directory path uses index.html) | — | Task/shared Preview Component iframe | UI asset transport; G09 covers component/version reads | [components.ts](../../cloud/src/v1/components.ts) |
| `HEAD https://{hash}.{COMPONENT_HOST}/{path...}` | Component asset headers | — | — | Asset transport | [components.ts](../../cloud/src/v1/components.ts) |

## Cloud operations

Service: Cloud Worker. All require the service-role bearer and have no UI or AKB equivalent. They are excluded from the UI gap backlog.

| Method and path | Purpose / access | AKB | UI entry | Coverage / classification | Source |
| --- | --- | --- | --- | --- | --- |
| `POST /internal/workspaces/{workspace}/board-move` | Move board files | — | — | Internal operation | [index.ts](../../cloud/src/index.ts) |
| `POST /internal/workspaces/{workspace}/triage-move` | Move triage items | — | — | Internal operation | [index.ts](../../cloud/src/index.ts) |
| `POST /internal/projects/{project}/schedules-move` | Move schedules | — | — | Internal operation | [index.ts](../../cloud/src/index.ts) |
| `POST /internal/workspaces/{workspace}/rules-merge` | Merge rules | — | — | Internal operation | [index.ts](../../cloud/src/index.ts) |
| `POST /internal/workspaces/{workspace}/studio-memory-move` | Move shared agent memory | — | — | Internal operation | [index.ts](../../cloud/src/index.ts) |

## Cloud Durable Object bindings

Services are named by the synthetic hosts below. Methods are the actual callers’ methods, not a promise that each private handler validates them. `Board`, `RunLog`, `RunnerPresence`, `EventHub`, `DiffCall` and `MusicCall` have no public ingress at these hosts. Alarms and WebSocket frames are not additional HTTP endpoints.

| Method and path | Purpose / access | AKB | UI entry | Coverage / classification | Source |
| --- | --- | --- | --- | --- | --- |
| `POST https://board/restore` | Restore task and card atomically | — | — | Internal binding only | [board.ts](../../cloud/src/board.ts) |
| `POST https://board/card-paths` | Find project card paths by number | — | — | Internal binding only | [board.ts](../../cloud/src/board.ts) |
| `POST https://board/review` | Serialize decisions and Runner preview/reply writes | — | — | Internal binding only | [board.ts](../../cloud/src/board.ts) |
| `POST https://board/prepare-index` | Flush pending project index | — | — | Internal binding only | [board.ts](../../cloud/src/board.ts) |
| `POST https://board/diff` | Read files since sequence/prefixes | — | — | Internal binding only | [board.ts](../../cloud/src/board.ts) |
| `POST https://board/read` | Read named paths | — | — | Internal binding only | [board.ts](../../cloud/src/board.ts) |
| `POST https://board/list` | List prefix | — | — | Internal binding only | [board.ts](../../cloud/src/board.ts) |
| `POST https://board/list-each-project` | List each project folder | — | — | Internal binding only | [board.ts](../../cloud/src/board.ts) |
| `POST https://board/unlearned` | Read unlearned state | — | — | Internal binding only | [board.ts](../../cloud/src/board.ts) |
| `POST https://board/remember-unlearned` | Record learned sequence state | — | — | Internal binding only | [board.ts](../../cloud/src/board.ts) |
| `POST https://board/indexed` | Acknowledge indexed files | — | — | Internal binding only | [board.ts](../../cloud/src/board.ts) |
| `POST https://board/commit` | Compare and commit files | — | — | Internal binding only | [board.ts](../../cloud/src/board.ts) |
| `POST https://board/drop` | Delete prefix | — | — | Internal binding only | [board.ts](../../cloud/src/board.ts) |
| `POST https://board/destroy` | Delete workspace board storage | — | — | Internal binding only | [board.ts](../../cloud/src/board.ts) |
| `GET (WS) https://run-log/runner` | Connect log producer | — | — | Internal binding only | [run-log.ts](../../cloud/src/run-log.ts) |
| `GET (WS) https://run-log/page` | Connect log reader, after cursor | — | — | Internal binding only | [run-log.ts](../../cloud/src/run-log.ts) |
| `GET (WS) https://run-log/ended` | Read ended log | — | — | Internal binding only | [run-log.ts](../../cloud/src/run-log.ts) |
| `POST https://run-log/stop` | Notify reply stop | — | — | Internal binding only | [run-log.ts](../../cloud/src/run-log.ts) |
| `POST https://run-log/cleanup` | Purge retained ended log | — | — | Internal binding only | [run-log.ts](../../cloud/src/run-log.ts) |
| `GET (WS) https://presence/connect` | Machine heartbeat | — | — | Internal binding only | [presence.ts](../../cloud/src/presence.ts) |
| `POST https://presence/notify` | Save and notify pending reply delivery | — | — | Internal binding only | [presence.ts](../../cloud/src/presence.ts) |
| `POST https://presence/claimed` | Acknowledge delivery claim | — | — | Internal binding only | [presence.ts](../../cloud/src/presence.ts) |
| `GET (WS) https://hub/stream` | Internal event hint stream | — | — | Internal binding only | [stream.ts](../../cloud/src/v1/stream.ts) |
| `POST https://hub/poke` | Notify subscribers to reread | — | — | Internal binding only | [stream.ts](../../cloud/src/v1/stream.ts) |
| `POST https://hub/hint` | Notify subscribers with hint payload | — | — | Internal binding only | [stream.ts](../../cloud/src/v1/stream.ts) |
| `POST https://diff-call/wait` | Wait for computer diff answer | — | — | Internal binding only | [diff.ts](../../cloud/src/diff.ts) |
| `POST https://diff-call/answer` | Return computer diff answer | — | — | Internal binding only | [diff.ts](../../cloud/src/diff.ts) |
| `POST https://music-call/` | Run alarm-backed hosted music call | — | — | Internal binding only | [music.ts](../../cloud/src/music.ts) |
| `POST https://transcription-run/` | Schedule a transcription job | — | — | Internal binding only | [transcriptions.ts](../../cloud/src/transcriptions.ts) |

## Runner loopback HTTP

Service: local Runner on `127.0.0.1`. The settings-link server uses fixed port 47821; the other servers choose ports dynamically. Settings, sign-in, settings-link and reply-approval servers are separate origins, even where `/` repeats. Settings `/api/*` requires same-origin cookie and CSRF after ticket exchange. The [settings router](../../runner/src/settings-server.ts) accepts only the action names listed below; unknown names are refused by the action handler.

| Method and path | Purpose / access | AKB | UI entry | Coverage / classification | Source |
| --- | --- | --- | --- | --- | --- |
| `GET /` | Local settings HTML | — | Settings | Local page | [settings-server.ts](../../runner/src/settings-server.ts) |
| `GET /settings-client.js` | Settings client bundle | — | Settings | Local asset | [settings-server.ts](../../runner/src/settings-server.ts) |
| `POST /control/ping` | Discover live settings server; private bearer | — | — | Internal control | [settings-server.ts](../../runner/src/settings-server.ts) |
| `POST /control/open` | Create ticket and settings URL; private bearer | — | Plugin: open settings | Internal control | [settings-server.ts](../../runner/src/settings-server.ts) |
| `POST /session` | Exchange ticket for cookie/CSRF session | — | Settings | Local authentication | [settings-server.ts](../../runner/src/settings-server.ts) |
| `POST /api/state` | Read account, projects, folders and update preference; session/CSRF | — | Local settings | No AKB settings state view; G17 | [settings.ts](../../runner/src/settings.ts) |
| `POST /api/updates` | Save acceptAlphaUpdates boolean | — | Local settings: alpha updates | No AKB; G17 | [settings.ts](../../runner/src/settings.ts) |
| `POST /api/signIn` | Start local account sign-in | — | Local settings: sign in | No AKB; G17 | [settings.ts](../../runner/src/settings.ts) |
| `POST /api/signOut` | Revoke executions and release Runner before forgetting session | `account sign-out (local credentials only)` | Local settings: sign out | Partial; G17 | [settings.ts](../../runner/src/settings.ts) |
| `POST /api/connections` | Check CLI connections, optional name | `agent check <agent>` | Local settings: AI tools | Local readiness/login check; not a prompt-based runtime test | [settings.ts](../../runner/src/settings.ts) |
| `POST /api/pick` | Native folder chooser or authorized current folder | — | Local settings: add folder | No AKB; G02 | [settings.ts](../../runner/src/settings.ts) |
| `POST /api/cancel` | Discard pending folder selection | — | Local settings: cancel folder choice | No AKB; G02 | [settings.ts](../../runner/src/settings.ts) |
| `POST /api/remove` | Remove bound project folder | — | Local settings: remove folder | No AKB; G02 | [settings.ts](../../runner/src/settings.ts) |
| `POST /api/bind` | Bind selected folder to existing/new project | — | Local settings: bind folder | No AKB; G02 | [settings.ts](../../runner/src/settings.ts) |
| `GET /settings` | Open local settings from ephemeral link | — | Plugin settings link | Internal bridge | [settings-link.ts](../../runner/src/settings-link.ts) |
| `GET /` | Ephemeral sign-in HTML | — | Local sign-in window | Local authentication page; handler does not constrain method | [signin.ts](../../runner/src/signin.ts) |
| `POST /send` | Send email code | — | Local sign-in window | Authentication transport; G17 | [signin.ts](../../runner/src/signin.ts) |
| `POST /verify` | Verify email code | — | Local sign-in window | Authentication transport | [signin.ts](../../runner/src/signin.ts) |
| `GET /signed-in?state={state}` | OAuth PKCE code or error callback | — | Supabase redirect | Validates the sign-in state | [signin.ts](../../runner/src/signin.ts) |
| `POST /` | Ephemeral reply approval bridge, bearer, rejects Origin | `task approve <task> [--stage <id>]` | Task reply: request approval | Covered by the packaged CLI reply approval test | [reply-approval.ts](../../runner/src/reply-approval.ts) |

Runner sends Supabase `GET /auth/v1/authorize` with `provider=github` or `provider=google`,
`code_challenge`, `code_challenge_method=s256`, and a URL-encoded
`redirect_to=http://127.0.0.1:{port}/signed-in?state={state}`. GitHub adds `scopes=user:email`.
The callback exchanges `code` through Cloud's PKCE relay after validating `state`.
Error callbacks carry `error` and optionally `error_code` and `error_description`.
`error=access_denied` without `error_code` shows cancellation. Other errors show sign-in failure.

## Routing boundaries

- **Preflight**: Cloud returns OPTIONS for its configured CORS surfaces; this is shared transport, not another business operation per row.
- **Upstream calls**: database RPC, model/provider HTTP, Auth `/authorize` and library/MCP exports are dependencies or other protocols, not extra project HTTP ingress. The lists cover every HTTP router shipped in Cloud and Runner on `main`.
- **Frozen applications**: the old desktop, kanban-ui, web, cloud-ui and telemetry apps from `legacy` are not counted as current UI. Compatibility routes that remain on `main` are still listed above.
- **Removed operations**: [the current input validator](../../cloud/src/v1/input.ts#L346) refuses preview role decisions; old CLI preview flags were removed. The two workspace Studio role PUT routes are removed; requests return the standard HTTP 404 `not_found` without writes or redirects. Handoff/chat-computer routes refuse in [the migration](../../cloud/migrations/0160_immutable_runtime_computers.sql). They do not represent missing UI coverage.

## Studio notes and background-task settings

- `GET /v1/workspaces/{id}/studio-rules`: no body; returns `{studios: [...]}`.
  Each Studio has `id`, `name`, `names`, `builtin`, `icon` and `rule`.
  The empty top-level `data` and old `off`, `previews`, `stages`, `land`,
  `scheduled` fields are absent. Unknown/inaccessible workspaces use existing errors.
- `PUT /v1/workspaces/{id}/studios/{studio}/rule`: `{ "rule": "..." }`;
  returns the updated Studio in the same shape. Trimmed empty text clears notes.
  Notes apply to that Studio across this workspace's projects; other Studios and
  workspaces are unchanged. Missing/non-text `rule` or more than 20,000 characters:
  HTTP 400 `bad_request`; unknown Studio: HTTP 404 `not_found`.
- `GET /v1/projects/{id}/agents`: retains `studios`, `board` and `data`;
  Studio metadata no longer includes `previews`, `stages`, `land` or `scheduled`.
  Project background-task rules, schedules and run state remain in `data`.
- Removed `PUT /v1/workspaces/{id}/agents/{agent}` and
  `PUT /v1/workspaces/{id}/studios/{studio}/agents/{agent}` accept no input.
  With valid authentication, the unmatched route returns HTTP 404
  `{ "error": { "code": "not_found", "message": "No such endpoint." } }`.
  No rule, runtime, toggle or schedule is written. There is no replacement alias.

```sh
curl -H "Authorization: Bearer $TOKEN" "$API/v1/workspaces/$WORKSPACE/studio-rules"
curl -X PUT -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  "$API/v1/workspaces/$WORKSPACE/studios/wf_builtin_coding/rule" \
  -d '{"rule":"Write card titles in English."}'
curl -H "Authorization: Bearer $TOKEN" "$API/v1/projects/$PROJECT/agents"
# Removed route: HTTP 404, no writes.
curl -X PUT -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  "$API/v1/workspaces/$WORKSPACE/agents/builder" -d '{"rule":"Old note"}'
curl -X PUT -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  "$API/v1/workspaces/$WORKSPACE/studios/wf_builtin_coding/agents/builder" -d '{"on":true}'
```
