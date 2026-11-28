# wildcrane

The CLI for WildCrane. See the draft. Let agents do the rest.

See the [project README](https://github.com/wildcrane-ai/wildcrane#readme) for the product overview and [documentation](https://wildcrane.ai/docs) for setup and usage.

## 安装或更新

适用于通过 npm 安装的独立 CLI：

```bash
npm install -g wildcrane@latest
```

Still on the old `ai4kanban` package? Run `npm uninstall -g ai4kanban` first; both install `akb`.

Run `akb help` for commands and `akb guide` for studios.

通过插件连接云端项目。`akb install` 和整个 `akb skill` 命令树已移除；kanban 技能由 Runner 在绑定目录时写入项目。
`akb update` 只修复已有看板并检查 CLI 新版本，不安装技能或钩子。

## 在对话里操作 WildCrane

顶层 `task`、`goal`、`workspace`、`project`、`runner` 支持 `--json`。归档或移除当前 Runner 任务时，命令可以先在本机受理，再由 Runner 同步。

```sh
akb task list [--project <id> | --workspace <id>] [--status <status>]
akb task show <task>
akb task create <request...> [--project <id>] [--studio <id>]
akb task approve <task> [--comment <text>]
akb task chat <task> <message...>
akb task archive <task>
akb task remove <task> [reason...]
akb task restore <task>
akb task resume <task> [--json]
akb task stop <task>
akb task comment <task> <text...>
akb workspace list
akb project list [--workspace <id>]
akb runner list [--workspace <id>]
```

| 命令 | 云端接口 | 成功输出 |
| --- | --- | --- |
| `task list` | `GET /v1/tasks?project=&status=` | 每行 `WC-12  running  <标题>` |
| `task show` | `GET /v1/tasks/{id}` + `/card` | 标题、状态、流程、网页链接，再接卡片正文 |
| `task create` | `POST /v1/tasks`（`source: api`，`run: true`，启动卡片准备） | `Created WC-13: <标题>  <网页链接>`，随后显示实际状态 |
| `task approve` | `POST /v1/tasks/{id}/decisions`，`decision: approve` 带当前 `review_revision` | `Approved WC-12.` |
| `task chat` | `POST /v1/tasks/{id}/chat`，`body: <message>` | `Sent to WC-12.`，等同网页任务页的对话框 |
| `task archive` | `POST /v1/tasks/{id}/archive` | Cloud 确认后显示已归档，当前 Runner 任务可处于待同步。 |
| `task remove` | `POST /v1/tasks/{id}/cancel`，`reason` 可选 | Cloud 确认后显示已移除，当前 Runner 任务可处于待同步。 |
| `task restore` | `POST /v1/tasks/{id}/restore`，无需请求体 | `Restored WC-12. Status: stopped.` |
| `task resume` / `stop` | `POST /v1/tasks/{id}/resume` / `stop` | 显示续跑已排队或启动，以及停止已请求或完成。 |
| `task comment` | `POST /v1/tasks/{id}/comments` | `Commented on WC-12.` |
| `workspace list` | `GET /v1/workspaces` | 每行 `ws_…  <名称>` |
| `project list` | `GET /v1/projects?workspace=` | 每行 `prj_…  WC  <名称>` |
| `runner list` | `GET /v1/workspaces/{id}/runners` | 每行 `<机器名>  online/offline` |

- **`<task>`**：`WC-12`、`task_…` 原样使用；纯数字如 `12` 使用所选位置关联项目的编号，适用于所有接收 `<task>` 的命令，包括聊天读取、跟随和停止回复。
- **`--status`**：`queued`、`running`、`waiting_review`、`done`、`failed`、`cancelled`、`stopped`。
- **`--studio`**：创建时必填，使用 `akb studio list` 显示的名字；省略返回 `no_studio`，不创建任务。
- **项目位置**：`--board` 优先，其次为 `AI4KANBAN_BOARD`、`--dir`、当前目录。看板使用其所属项目的关联；目录向上查找 `.akb/base.json`。共享参数可放在命令前后，相对路径以调用目录为准；读取关联不初始化或修改看板。
- **显式选择**：`task list` 的 `--project` 优先于 `--workspace`，否则推导项目；`task create` 的 `--project` 优先；`runner list` 的 `--workspace` 优先，否则取所选项目的工作区。`project list` 仍列出全部可见项目，仅用 `--workspace` 筛选。
- **完整列表**：`task list` 自动读完所有页，保持范围、状态筛选和服务端顺序。文字每个任务一行；JSON 的 `data` 包含全部任务，`next` 为 `null`，空列表为 `data: []`。后续页失败仍非零退出，沿用错误封装，不输出成功的部分列表；任务越多，等待越久。
- **无关联项目**：需要推导项目却未找到有效关联时，返回 `no_project`，不会退回原执行目录；完整 key/id 或显式项目、工作区无需位置关联。
- **错误**：失败以非零退出。终端和 JSON 都显示 Cloud 错误码及原因。JSON 的 `error.retryable` 表明是否属于暂时失败。待同步和已受理的后台操作以实际状态返回。

### 创建任务与恢复

`akb task create <request...> [--project <id>] [--studio <id>]` 创建任务并异步准备可审阅卡片。
请求可包含中文和多行验收项；无本地看板时，使用 `--project` 指定目标。
无法确定工作台时提示 `--studio` 用法，不创建空任务。

成功回执保留任务编号、标题及网页链接，随后显示 `Status: <云端状态>`；`--json` 沿用现有封装及任务字段。
`queued` 表示等待执行，`running` 表示正在执行，均不表示正文已经生成；`failed` 同时显示失败原因。
使用 `akb task show <task>` 回读状态和正文，在任务页审阅生成结果；后续创建失败从原任务查看原因。

`akb task resume <task> [--json]` 与网页的 Resume 按钮使用同一 Cloud 接口，恢复可继续的已停止或失败任务。
例如在关联项目中运行 `akb task resume 1198`。Cloud 受理后返回 `queued` 或 `running`，拒绝时显示原因并以非零状态退出。
历史创建未提交且尚无卡片的任务也从原任务继续准备卡片。
保留编号与聊天，不批量自动启动历史任务。已有有效卡片的任务继续当前流程，不重复创建卡片。

创建前的参数、项目、权限与连接错误沿用下表；空请求为用法错误。
连接中断而未收到回执时，先查询目标项目确认是否已创建，再决定是否重试；CLI 不自动重发创建请求。
重复执行创建不是恢复原任务；恢复失败不能输出已恢复或卡片已完成。

```sh
akb task create "Add a dark mode toggle" --project prj_example --studio coding
akb task show WC-13
akb task resume WC-13
```

### 恢复已移除或已完成任务

```sh
akb task restore WC-12
akb task restore 12 --dir /work/project --json
```

`akb task restore <task>` 将原任务放回看板，保留编号、内容、成果和历史，不启动执行。
`<task>`、位置选项、登录要求及 `--json` 沿用本节公共规则；不需要本机 Runner 在线。

| 恢复前 | 恢复后的状态 |
| --- | --- |
| 已移除，原为等审核 | `waiting_review` |
| 已移除，原为失败 | `failed` |
| 其他已移除任务 | `stopped` |
| 已完成且卡片可恢复 | `stopped` |

成功文字为 `Restored <key>. Status: <status>.`；`--json` 返回 `{"ok":true, …Task}`。
任务与卡片位置、标记及索引一致后才返回成功；Runner 联网后同步回本机。
恢复不会回退已落地代码、下游任务或已清除的依赖，也不会复活过期附件。

父任务组仍在看板时，子任务回原组并撤销该条目的完成勾选或删除线。
父组已归档时，子任务先回到看板，保留所属关系；父组需要另行恢复。
恢复根任务会搬回其文件夹，其他子任务仍保留各自状态，不会一起重新打开。

恢复已完成任务后，`akb task resume <task>` 首次续跑会重新规划并进入审阅流程，
不会续用旧实现会话或重放旧交付。已移除任务恢复后的续跑行为保持不变。

| 情况 | HTTP / code | 结果 |
| --- | --- | --- |
| 任务已在看板，包括重复恢复 | `409 / conflict` | 不改变当前任务；回读任务确认状态 |
| 原卡片不可恢复、正在永久删除或目标位置冲突 | `409 / conflict` | 不覆盖文件，不报告恢复成功 |
| 卡片存储暂时不可用 | `503 / service_unavailable` | 同一次恢复可重试完成；不启动执行 |

任务不存在、无权限与登录错误沿用现有错误。CLI 失败非零退出，不打印成功回执。
未收到回执时先用 `akb task show <task>` 确认；恢复仍未完成时重试同一命令，不创建新任务。

### 错误（退出码 1，文字写 stderr）

| 情况 | code | 英文文字 |
| --- | --- | --- |
| 未登录 | `signed_out` | Not signed in to WildCrane Cloud. Sign in from Configuration → Cloud in the WildCrane app, then try again. |
| 登录过期 | `expired` | Your WildCrane Cloud sign-in has expired. Sign in again from Configuration → Cloud in the WildCrane app, then try again. |
| 无法连接 | `unreachable` | Could not reach WildCrane Cloud. Check your connection and try again. |
| 未选择工作台 | `no_studio` | Choose --studio from akb studio list. |
| 无法确定项目 | `no_project` | Pick a project with --project: `<prj_… WC 名称>, …` |
| 只写编号却无关联项目 | `no_project` | Write the full task key, like WC-12, or run this in a linked folder. |
| 云端拒绝 | 云端的 `code` | 云端返回的 `message`，如任务不存在、当前状态不能批准 |

参数缺失按现有用法错误处理。未登录时不读写任何本地文件。

```sh
akb task list --dir /work/project-b --status running --json
akb task show 12 --board /work/project-b/.akb/kanban
akb runner list --dir /work/project-b
akb task create "Add a dark mode toggle" --studio coding
akb task approve WC-13 --comment "Looks right"
akb task chat WC-13 "Keep the toggle in Settings only"
akb task remove WC-13 "Not needed this quarter"
```

## 讨论目标

目标包含结果和 `## Done when` 验收清单：

```sh
akb goal new --title <title> --body-file <file> [--studio <id>] [--review <flow> | --review-file <file>] [--preview-definitions-file <file>]
akb goal save --id <goal> [--title <title>] [--body-file <file>] [--studio <id>] [--review <flow> | --review-file <file>] [--preview-definitions-file <file>]
akb goal drop --id <goal>
akb goal start --id <goal>
akb guide discuss-goal
```

保存只更新草稿。网页讨论中，`start` 在本轮回复结束后发起任务，Runner 通过 `KANBAN_GOALS` 传递包含 `workspace?`、`studios` 和 `goals` 的草稿文件。外部会话中，`start` 立即发起并返回讨论链接。每个讨论最多保留 10 个目标。

目标审阅要点及查询语义见 [目标审阅接口](../docs/api/goal-previews.md)。

## 软件故障根因定位

需要定位软件故障的根因与修复方向时，读取 `akb guide troubleshoot`。
此命令只输出指南，不执行排查或修改代码，无需额外参数或配置。
`akb --json guide troubleshoot` 返回 `guide: "troubleshoot"` 和 `text`，沿用现有 JSON 结果封装。


## 本地任务与运行

先运行 `akb help`，再用对应子命令的 `--help` 查参数。

- **建卡**：`akb task create --title "<title>" [--studio <id>]` 由 Cloud 分配编号并立即写入当前看板。返回编号及路径。正文直接在卡片文件里补写，审阅和问题分别用 `task review` 和 `task update-questions`。
- **看板**：`akb board list` 查看本地卡片，`task inspect` 查看本地卡片和执行记录，`task validate` 校验，`task update` 更新字段。Cloud 任务继续用 `task list` 和 `task show`。
- **流程**：`akb task refine|revise|resolve|implement <id> …` 启动本地流程。加 `--print` 在当前会话读取流程。用 `akb run list`、`run log`、`run stop` 或 `run resume` 管理本地运行。

### 关联看板的本地编辑

在 Runner 维护的关联看板上，`task update`、当前会话任务的 `task update-questions`、写入本地收件箱的 `triage add`、关联项目会话的 `goal new|save|drop|start`，以及兼容命令 `raw update|update-questions|reject`，写入前会确认本机 Runner 在线、当前账号已授权该目录，且 Cloud 绑定与本地项目一致。直连 Cloud 的提案提交（含 `triage decide`）、独立本地看板和离线排查沿用现有路径。

校验失败以 `1` 退出。`--json` 返回 `{ "ok": false, "error": { "kind": "runner-required", "code": "…", "message": "…" } }`，`message` 为英文恢复提示。

| `error.code` | 恢复方式 |
| --- | --- |
| `runner-offline` | 运行 `wildcrane-runner` 或重开 WildCrane 插件 |
| `runner-signed-out` | 在 WildCrane 设置中登录项目所属账号 |
| `runner-folder-not-authorized` | 在 WildCrane 设置中授权该目录 |
| `runner-project-not-bound` | 在 WildCrane 设置中将目录关联到正确的项目 |
| `runner-project-link-invalid` | 在 WildCrane 设置中检查并重新关联目录 |
| `runner-binding-unverified` | 检查 Cloud 连接后重试 |

## Preview

`akb studio previews [--studio <id>] [--json]` 列出 Studio 声明的 Preview ID 和制作说明。任务会话按需制作产物，审阅与批准使用 `akb task review` 和 `akb task approve`。

## 完成交付

所属交付的当前运行登记自己的工作台步骤。最后一步同时结束交付并归档，返回既有归档交接。

```sh
akb delivery complete <id> [--commit <sha> --branch <name>] --json
akb delivery cancel <id> --json
```

`id` 接受卡片或交付编号。软件步骤提供已合入的完整 40 或 64 位提交号和目标分支，两项必须同时提供。
Builder 自行创建分支和 worktree、处理冲突、检查并合入，登记接口校验参数和归属。
文件步骤沿用工作台的成果清单与文件存在性校验，无需 Git。

完成返回 `{ "ok": true, "deliveryId": "...", "finished": false }`，最后一步的 `finished` 为 `true`，并附上归档交接。
同一运行重复登记相同结果返回原结果。结果不同、参数错误、运行不拥有当前步骤或成果不齐时非零退出，交付保留供恢复。
成功退出的运行仍须完成登记。归档中断后可重试同一结果。

`cancel` 停止运行并结束交付，保留磁盘成果。使用 `akb task resume <task>` 恢复 Cloud 任务，Runner 会接续原有交付。
交付外仍可使用 `akb task archive <task>` 手动归档。`delivery conflict`、`delivery blocked` 和 `delivery discard` 已移除。

工作台只存于云端（#409）：`akb studio list` 列出当前工作区可用的工作台，各版本缓存在本机 `studios/`；`akb studio validate <文件夹>` 检查一个工作台文件夹，`akb studio file <studio> <path>` 读取工作台文件，`akb studio preview <card> --folder <draft> --base <baseline>` 冻结待审阅版本。
