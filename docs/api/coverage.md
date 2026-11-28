# API AKB and UI coverage

Track which current UI operations can be performed with AKB, and which still need a
command or parameter. This is a source audit, not a live deployment or permission test.
No API or command is added by this documentation.

Checked **2026-11-17** against `main` at
`8c60b6fb4299cdbe49b2a912b27727f699276fdc`; CLI **0.11.71**, contract **18**.

| Inventory | Contents |
| --- | --- |
| [HTTP coverage](coverage-http.md) | 133 public/shared method-path registrations, plus service, compatibility, callback, internal binding and Runner loopback routes; purpose, command, UI entry, coverage and source for every row. |
| [AKB coverage](coverage-akb.md) | 103 command-tree entries including groups, hidden declarations, all nonshared options and four `goal` moves; API relationships and local-only operations. |
| [UI gaps](#ui-gaps) | Missing operations or parameters for current UI features backed by working APIs. |

## Reading coverage

- **Covered**: the command performs the named operation; it does not imply support for every optional API field.
- **Partial**: the command exposes only part of the operation, is restricted to the current conversation, or reaches the result through another API. The missing UI operation or parameter is named below.
- **No AKB**: there is no equivalent command. Only rows with a current, working UI operation enter the UI gap list.
- **API only or transport**: no current UI entry, or a producer/consumer protocol behind a feature. These are recorded separately from UI gaps.
- **Local**: local files, settings, processes or cached definitions; no corresponding business API. Runner synchronization is identified explicitly and does not count as a direct command.
- **Retired**: still declared but refused, or kept only to explain an old spelling. It does not count as support or as a missing UI feature.

API registration and handler behavior take precedence over OpenAPI summaries and help text.
For example, `raw agent set` does not manage Cloud runtimes, `run log` does not read
arbitrary Cloud job logs, and `raw components` does not publish Preview Components.

## UI gaps

All entries below are **Open** as of the checked baseline. This table is the tracking
record; no follow-up implementation or priority is implied. On a fix, retain its ID and
record the closing task/commit and date. API details and per-route sources are in the
[HTTP inventory](coverage-http.md); CLI options and implementations are in the
[AKB inventory](coverage-akb.md).

| ID | UI operation and evidence | API operations | Existing AKB coverage and missing operation or parameter | Status |
| --- | --- | --- | --- | --- |
| G01 | [Workspace switcher](../../web/src/components/Header.tsx), [workspace settings](../../web/src/components/Workspace.tsx): create/rename/delete workspace; read/invite/change/remove members or leave | POST `/v1/workspaces`; PATCH/DELETE `/v1/workspaces/{id}`; GET/POST `/members`; PATCH/DELETE `/members/{account}` under that workspace | `workspace list` lists only. No workspace mutations or member commands. | Open |
| G02 | [Project settings](../../web/src/pages/Settings.tsx), [project folders](../../web/src/components/ProjectFolders.tsx), [local settings](../../runner/src/settings.ts): create/rename/delete project; choose/bind/unbind local folder | POST `/v1/projects`; PATCH/DELETE `/v1/projects/{id}`; GET/POST `/v1/runner/folders`, POST `/v1/runner/folders/{project}/remove`; local POST `/api/pick`, `/api/cancel`, `/api/bind`, `/api/remove` | `project list` only; goal scope lookup reads folder bindings indirectly. No project mutation or folder authorization/binding commands. | Open |
| G03 | [AI tool settings](../../web/src/components/Settings.tsx), [computer menu](../../web/src/components/ComputerMenu.tsx): read/add/edit/delete/test Cloud runtime; remove/share/unshare computer | GET/POST `/v1/runtimes`; PATCH/DELETE `/v1/runtimes/{id}`; POST `/test`; DELETE workspace `/runners/{machine}`; PUT/DELETE `/runners/{machine}/share` | `runner list` lists computers. `agent check` checks local installation/login where supported; `raw agent use/set/picks` changes local settings. No Cloud runtime CRUD, prompt test or computer mutations. | Open |
| G04 | [Project agent settings](../../web/src/components/Agents.tsx): view schedules/run state, enable/disable/change cadence, run now | GET `/v1/projects/{id}/agents`; PUT `/v1/projects/{id}/agents/{agent}` with `schedule.on/cadence`; POST `/run` | `studio instructions` reads and writes rules for project background tasks. Schedules and dispatch use the project agents API. | Open |
| G05 | [Studios](../../web/src/pages/Studios.tsx): discover/read official Studio, install/uninstall/clone; delete own Studio, including force confirmation | GET `/v1/marketplace/studios` and `/{id}`; POST `/{id}/install`, `/uninstall`, `/clone`; DELETE `/v1/studios/{id}?force=true` | `studio list/pull/create/push` covers installed definitions and folder publication. No marketplace or delete command, nor force parameter. | Open |
| G06 | [New task](../../web/src/pages/NewGoal.tsx), [triage build now](../../web/src/pages/Triage.tsx), [board](../../web/src/pages/Board.tsx), [resume](../../web/src/components/ResumeTask.tsx), [task review](../../web/src/pages/CardPage.tsx): create with images/runtime/context/triage/skip-plan, resume with runtime, request changes, query active tasks | GET/POST `/v1/tasks`; GET `/v1/tasks/{id}/runtimes`; POST `/resume` with `runtime`; POST `/decisions` with `request_changes`; GET `/v1/tasks?scope=active` | `task create` exposes project/Studio/text; `task create --title <title>` adds local card metadata/triage/previews but has no request image/runtime/context/skip_plan options. `task approve` has no request-changes decision. `task list` has project/workspace/status, not scope=active or UI request-key recovery queries. | Open |
| G07 | [task page](../../web/src/pages/CardPage.tsx), [cost bill](../../web/src/components/CostBill.tsx), [run log](../../web/src/components/RunLog.tsx): discard build, read bill/Studio/subtasks/landed diff/job progress and logs | POST `/v1/tasks/{id}/discard`; GET `/bill`, `/studio`, `/subtasks`, `/diff`; GET `/v1/runner/jobs/{job}` and `/stream` | `task show` reads task/card, not these dedicated views; `studio file` accesses pinned Studio files but no complete task Studio JSON. `task chat --follow` follows only one task reply's job/log. Local inspect, delivery cancel and run log are not Cloud equivalents. | Open |
| G08 | [Task AI chat](../../web/src/review/components/ai-chat.tsx): attach images, choose runtime, display/download private reply images, clear or retry/continue reply | GET/POST/DELETE `/v1/tasks/{id}/chat`; POST `/chat/continue`; GET `/v1/reply-images/{id}` | `task chat` reads/sends text and follows/stops the selected reply. No image input/download action, runtime flag, clear or continue operation. Raw JSON may retain image metadata; that is not image rendering/retrieval. | Open |
| G09 | [Share](../../web/src/review/components/share.tsx), [task page](../../web/src/pages/CardPage.tsx), [shared review](../../web/src/review/components/CardPage.tsx), [Preview host](../../web/src/review/lib/artifacts.ts): manage links/guests; read comments/decisions; shared-token comment; read/download/edit Preview versions | Task `/share-links`, `/guests`, `/comments`, `/decisions`; `/v1/share-links/{id}`; `/v1/shared/{token}` and its file/comment/component routes; `/v1/artifacts/{id}` and version/file/component routes | `task comment` posts a signed-in member comment. No history, sharing/guest/token-review commands or artifact read/download/content-save/pin options. Runner asset upload is an indirect producer, not these review operations. | Open |
| G10 | [Chats](../../web/src/pages/Chats.tsx), [new discussion](../../web/src/pages/NewGoal.tsx), [discussion](../../web/src/pages/Discussion.tsx): list/filter/read/delete conversations, create Web discussion, send images/text with runtime, clear/stop/retry | GET `/v1/chats` with project/waiting/external/requestKey; POST `/v1/discussions`; GET/DELETE `/{id}`; POST/DELETE `/{id}/chat`; POST `/chat/stop`, `/chat/continue` | `goal` reads/opens only the host session's discussion for draft operations; no general discussion selector, chat, runtime/image or list/delete command. `task chat` targets tasks, not discussions. | Open |
| G11 | [Discussion goal start](../../web/src/pages/Discussion.tsx): start or refine a Goal in the chosen project and computer | POST `/v1/discussions/{id}/goals/{goal}/start` with `project`, `machine`, `action`, `expectedVersion` | `goal start --id` saves/starts in the current discussion and supplies expectedVersion automatically; no explicit discussion/project/machine/action flags. Studio changes/drop work through whole-draft saves in that session. | Open |
| G12 | [Triage](../../web/src/pages/Triage.tsx): list current/history, filter by project/state/order, dismiss with reason and restore | GET `/v1/triage`; POST `/v1/triage/{id}/dismiss`, `/restore` | `triage add/check` writes/looks up local items by source. No Cloud list/history/dismiss/restore; local rejects concern task cards. Task creation from triage is covered in G06. | Open |
| G13 | [Billing](../../web/src/components/Billing.tsx), [Subscribe](../../web/src/pages/Subscribe.tsx): read plan, quota, balance and rates, start trial, buy Pro or top up, confirm checkout and open billing portal | GET `/v1/billing`; POST `/trial`, `/checkout`, `/confirm`, `/portal` | No billing command. `account` reads identity/admission only; media generation uses API balance but does not manage billing. Storage purchase, invoices and renewal resume are API-only in current Web and excluded from this gap. | Open |
| G14 | [Stats](../../web/src/pages/Stats.tsx): daily counts/usage, costs by model and date range | GET `/v1/workspaces/{id}/stats?from=…&to=…&tz=…` | No stats/date-range/timezone/model cost command. | Open |
| G15 | [Language selector](../../web/src/review/components/lang-select.tsx): save interface language | PUT `/v1/language` with `lang=en/zh` | No account language command. Local runtime/language settings are not this preference. | Open |
| G16 | [Notifications](../../web/src/components/Notifications.tsx): list and mark alerts read | GET `/v1/alerts`; POST `/v1/alerts/{id}/read` | No alert commands. | Open |
| G17 | [Local settings](../../runner/src/settings.ts): sign in, read settings state, accept alpha updates, sign out with execution revocation and Runner release | Local POST `/api/signIn`, `/api/state`, `/api/updates`, `/api/signOut`; Cloud POST `/v1/runner/release`, Auth relay | `account` reads shared credentials and `account sign-out` clears them locally. No sign-in, alpha preference or equivalent revoke/release flow. `update` repairs/checks the CLI; it does not set Runner's update channel. Folder actions are G02. | Open |

## Excluded from UI gaps

- **Restoration covered**: `task restore <task>` now matches the archive/task UI for removed and completed tasks, without starting execution; added in [#807](../../cli/src/commands/task.ts#L221), commit `cb9dc86d`.

- **Retired roles**: Studio role instructions/runtime and per-role on/off return `not_found`. The Task review API checks explicit plan and stage revisions. AKB manages them internally for Agent writes. [Agents](../../cloud/src/v1/agents.ts), [Task review](task-review.md).
- **Retired transfer**: handoff/chat-computer routes remain registered but refuse in [0160](../../cloud/migrations/0160_immutable_runtime_computers.sql). Resume's working runtime selection is G06.
- **No current UI**: API-key management, direct task patch/review/card writes, board import, component publication, marketplace publication, direct triage proposal, rejection learning, legacy events, Slack/Lark settings, invoices and renewal resume remain separately listed in the HTTP inventory.
- **Protocol and callbacks**: Runner claims/renew/finish, asset uploads, board commits, realtime/SSE, Durable Object calls, signed provider callbacks and service-role migrations are not independent user command gaps. Public training/contact/catalog APIs have external website consumers, not current `web/src` entries.

## Maintenance

- **Same change**: when a route, command option or UI action changes, update its inventory row and affected gap in the same change; use [Concepts](../concepts.md) for names.
- **Sources**: re-enumerate `ROUTES`/`SHARED_ROUTES` and special OpenAPI handling in `cloud/src/v1/index.ts`; check `cloud/src/index.ts` and every delegated router, Durable Object `fetch`, Runner settings actions and ephemeral servers. OpenAPI alone omits these surfaces.
- **Commands**: enumerate `buildAkbProgram` and `buildBoardProgram` in `cli/src/lib/cli/`; include `FLOWS`, the `goal` move argument and hidden options. Inspect handlers for required options and refusals; do not infer support from declarations alone.
- **UI evidence**: trace calls from `web/src/api.ts`, `web/src/review/api.ts`, their actual components/pages and `runner/src/settings.ts`. A client export without a reachable, accepted operation is not a shipped feature.
- **Validation**: compare method/path sets and command/option sets against source, check all relative links, then update the checked date/baseline and gap states. Keep aliases separate; identify conditional dispatch. Retain closed gap IDs with the fix reference instead of silently renumbering.
