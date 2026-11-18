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

顶层 `task`、`goal`、`workspace`、`project`、`runner` 直接读写 WildCrane 云端，结果立即在网页可见，不读写本地看板。全部支持 `--json`。

```sh
akb task list [--project <id> | --workspace <id>] [--status <status>]
akb task show <task>
akb task create <request...> [--project <id>] [--studio <id>]
akb task approve <task> [--comment <text>]
akb task chat <task> <message...>
akb task remove <task> [reason...]
akb task restore <task>
akb task resume <task>
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
| `task remove` | `POST /v1/tasks/{id}/cancel`，`reason` 可选 | `Removed WC-12. Restore it with akb task restore WC-12.` |
| `task restore` | `POST /v1/tasks/{id}/restore`，无需请求体 | `Restored WC-12. Status: stopped.` |
| `task resume` / `stop` | `POST /v1/tasks/{id}/resume` / `stop` | `Resumed WC-12.` / `Stopped WC-12.` |
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
- **`--json`**：成功为 `{"ok":true, …云端返回}`；失败为 `{"ok":false,"error":{"kind":"<code>","code":"<code>","message":"…"}}`。

### 创建任务与恢复

`akb task create <request...> [--project <id>] [--studio <id>]` 创建任务并异步准备可审阅卡片。
请求可包含中文和多行验收项；无本地看板时，使用 `--project` 指定目标。
无法确定工作台时提示 `--studio` 用法，不创建空任务。

成功回执保留任务编号、标题及网页链接，随后显示 `Status: <云端状态>`；`--json` 沿用现有封装及任务字段。
`queued` 表示等待执行，`running` 表示正在执行，均不表示正文已经生成；`failed` 同时显示失败原因。
使用 `akb task show <task>` 回读状态和正文，在任务页审阅生成结果；后续创建失败从原任务查看原因。

`akb task resume <task>` 恢复可继续的已停止或失败任务；历史创建未提交且尚无卡片的任务也从原任务继续准备卡片。
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
akb goal new --title <title> --body-file <file> [--studio <id>] [--previews <agents>]
akb goal save --id <goal> [--title <title>] [--body-file <file>] [--studio <id>] [--previews <agents>]
akb goal drop --id <goal>
akb goal start --id <goal>
akb guide discuss-goal
```

保存不会开始任务；网页讨论的 start 标记本轮结束后开始，外部会话立即发起。`--previews ui,api` 选择审阅要点，空字符串清空，省略保留同一工作台的选择。Codex 与 Claude Code 会话使用同一命令；成功结果附讨论链接。10 个目标上限不变。未登录时报下节的 `signed_out`。`akb raw goal` 与 `akb raw idea` 已删除；`guide discuss-idea` 保留兼容。

`akb raw previews --triggers --studio <id> [--workspace <id>] [--json]` 只列该工作台启用的要点；讨论中可省略工作空间。详见 [目标审阅接口](../docs/api/goal-previews.md)。

## 软件故障根因定位

需要定位软件故障的根因与修复方向时，读取 `akb guide troubleshoot`。
此命令只输出指南，不执行排查或修改代码，无需额外参数或配置。
`akb --json guide troubleshoot` 返回 `guide: "troubleshoot"` 和 `text`，沿用现有 JSON 结果封装。


## Preview agents

`akb raw previews [agent] [id] [note...]` lists this board's agents or asks one to preview a card.
Add `--print` to work in the current session, or `--follow` to watch a separate run.

`akb raw previews --triggers [--json]` lists names and original `akb.when` conditions in catalog order,
including disabled and unassigned agents. Agents without a condition display `Always` and are always selected; JSON keeps `when: null`.
JSON returns `agents: { name: string, when: string | null }[]`, `problems` and `output` in the standard response.
An empty catalog returns `agents: []` with a message. Catalog diagnostics match the regular listing.
This read-only query accepts `--board` and `--dir`. Combining it with positional arguments,
`--print`, `--follow` / `-f` or `--notes` exits with 1 and JSON error kind `invalid-usage`.

## 完成交付

所属交付的当前运行登记自己的工作台步骤。最后一步同时结束交付并归档，返回既有归档交接。

```sh
akb raw delivery complete <id> [--commit <sha> --branch <name>] --json
akb raw delivery cancel <id> --json
akb raw delivery resume <id> --json
```

`id` 接受卡片或交付编号。软件步骤提供已合入的完整 40 或 64 位提交号和目标分支，两项必须同时提供。
Builder 自行创建分支和 worktree、处理冲突、检查并合入，登记接口校验参数和归属。
文件步骤沿用工作台的成果清单与文件存在性校验，无需 Git。

完成返回 `{ "ok": true, "deliveryId": "...", "finished": false }`，最后一步的 `finished` 为 `true`，并附上归档交接。
同一运行重复登记相同结果返回原结果。结果不同、参数错误、运行不拥有当前步骤或成果不齐时非零退出，交付保留供恢复。
成功退出的运行仍须完成登记。归档中断后可重试同一结果。

`cancel` 停止运行并结束交付，保留磁盘成果。`resume` 返回交付与运行编号，继续原会话或从既有成果恢复。
交付外仍可使用 `akb raw archive <id>` 手动归档。`delivery conflict`、`delivery blocked` 和 `delivery discard` 已移除。

工作台只存于云端（#409）：`akb studio list` 列出当前工作区可用的工作台，各版本缓存在本机 `studios/`；`akb raw studio validate <文件夹>` 检查一个工作台文件夹，`akb raw studio rename` 只在「搭建工作台」任务里写草稿，`delete`、`agent` 已移除，改在网页上管理。
