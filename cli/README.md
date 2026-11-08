# wildcrane

The CLI for WildCrane. See the draft. Let agents do the rest.

See the [project README](https://github.com/wildcrane-ai/wildcrane#readme) for the product overview and [documentation](https://wildcrane.ai/docs) for setup and usage.

## 安装或更新

适用于通过 npm 安装的独立 CLI：

```bash
npm install -g wildcrane@latest
```

Still on the old `ai4kanban` package? Run `npm uninstall -g ai4kanban` first; both install `akb`.

Run `akb help` for commands and `akb guide` for workflows.

通过插件连接云端项目。`akb install` 和整个 `akb skill` 命令树已移除；kanban 技能由 Runner 在绑定目录时写入项目。
`akb update` 只修复已有看板并检查 CLI 新版本，不安装技能或钩子。

## 在对话里操作 WildCrane

顶层 `task`、`goal`、`workspace`、`project`、`runner` 直接读写 WildCrane 云端，结果立即在网页可见，不读写本地看板。全部支持 `--json`。

```sh
akb task list [--project <id>] [--status <status>]
akb task show <task>
akb task create <request...> [--project <id>] [--workflow <id>]
akb task approve <task> [--comment <text>]
akb task chat <task> <message...>
akb task remove <task> [reason...]
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
| `task create` | `POST /v1/tasks`（`source: api`） | `Created WC-13: <标题>  <网页链接>` |
| `task approve` | `POST /v1/tasks/{id}/decisions`，`decision: approve` 带当前 `review_revision` | `Approved WC-12.` |
| `task chat` | `POST /v1/tasks/{id}/chat`，`body: <message>` | `Sent to WC-12.`，等同网页任务页的对话框 |
| `task remove` | `POST /v1/tasks/{id}/cancel`，`reason` 可选 | `Removed WC-12. Restore it on the web.` |
| `task resume` / `stop` | `POST /v1/tasks/{id}/resume` / `stop` | `Resumed WC-12.` / `Stopped WC-12.` |
| `task comment` | `POST /v1/tasks/{id}/comments` | `Commented on WC-12.` |
| `workspace list` | `GET /v1/workspaces` | 每行 `ws_…  <名称>` |
| `project list` | `GET /v1/projects?workspace=` | 每行 `prj_…  WC  <名称>` |
| `runner list` | `GET /v1/workspaces/{id}/runners` | 每行 `<机器名>  online/offline` |

- **`<task>`**：`WC-12`、`task_…`，或在已关联项目的文件夹里只写 `12`。
- **`--status`**：`queued`、`running`、`waiting_review`、`done`、`failed`、`cancelled`、`stopped`。
- **`--workflow`**：`akb workflow list` 显示的名字。
- **默认项目**：`--project` 优先，否则用当前文件夹 `.akb/base.json` 关联的项目；`task list` 也可改用 `--workspace`；`runner list` 的工作区默认取该项目所在工作区。都没有时报错并列出可选项。
- **`--json`**：成功为 `{"ok":true, …云端返回}`；失败为 `{"ok":false,"error":{"kind":"<code>","code":"<code>","message":"…"}}`。

### 错误（退出码 1，文字写 stderr）

| 情况 | code | 英文文字 |
| --- | --- | --- |
| 未登录 | `signed_out` | Not signed in to WildCrane Cloud. Sign in from Configuration → Cloud in the WildCrane app, then try again. |
| 登录过期 | `expired` | Your WildCrane Cloud sign-in has expired. Sign in again from Configuration → Cloud in the WildCrane app, then try again. |
| 无法连接 | `unreachable` | Could not reach WildCrane Cloud. Check your connection and try again. |
| 无法确定项目 | `no_project` | Pick a project with --project: `<prj_… WC 名称>, …` |
| 只写编号却无关联项目 | `no_project` | Write the full task key, like WC-12, or run this in a linked folder. |
| 云端拒绝 | 云端的 `code` | 云端返回的 `message`，如任务不存在、当前状态不能批准 |

参数缺失按现有用法错误处理。未登录时不读写任何本地文件。

```sh
akb task create "Add a dark mode toggle" --workflow coding
akb task approve WC-13 --comment "Looks right"
akb task chat WC-13 "Keep the toggle in Settings only"
akb task remove WC-13 "Not needed this quarter"
```

## 讨论目标

目标包含结果和 `## Done when` 验收清单：

```sh
akb goal new --title <title> --body-file <file> [--workflow <id>] [--previews <agents>]
akb goal save --id <goal> [--title <title>] [--body-file <file>] [--workflow <id>] [--previews <agents>]
akb goal drop --id <goal>
akb goal start --id <goal>
akb guide discuss-goal
```

保存不会开始任务；网页讨论的 start 标记本轮结束后开始，外部会话立即发起。`--previews ui,api` 选择审阅要点，空字符串清空，省略保留同一工作流的选择。Codex 与 Claude Code 会话使用同一命令；成功结果附讨论链接。10 个目标上限不变。未登录时报下节的 `signed_out`。`akb raw goal` 与 `akb raw idea` 已删除；`guide discuss-idea` 保留兼容。

`akb raw previews --triggers --workflow <id> [--workspace <id>] [--json]` 只列该工作流启用的要点；讨论中可省略工作空间。详见 [目标审阅接口](../docs/api/goal-previews.md)。

## 软件故障根因定位

需要定位软件故障的根因与修复方向时，读取 `akb guide troubleshoot`。
此命令只输出指南，不执行排查或修改代码，无需额外参数或配置。
`akb --json guide troubleshoot` 返回 `guide: "troubleshoot"` 和 `text`，沿用现有 JSON 结果封装。


## Preview agents

`akb raw previews [agent] [id] [note...]` lists this board's agents or asks one to preview a card.
Add `--print` to work in the current session, or `--follow` to watch a separate run.

`akb raw previews --triggers [--json]` lists names and original `akb.when` conditions in catalog order,
including disabled and unassigned agents. Missing conditions display `Not configured`.
JSON returns `agents: { name: string, when: string | null }[]`, `problems` and `output` in the standard response.
An empty catalog returns `agents: []` with a message. Catalog diagnostics match the regular listing.
This read-only query accepts `--board` and `--dir`. Combining it with positional arguments,
`--print`, `--follow` / `-f` or `--notes` exits with 1 and JSON error kind `invalid-usage`.

## 完成交付

所属交付的当前运行登记自己的工作流步骤。最后一步同时结束交付并归档，返回既有归档交接。

```sh
akb raw delivery complete <id> [--commit <sha> --branch <name>] --json
akb raw delivery cancel <id> --json
akb raw delivery resume <id> --json
```

`id` 接受卡片或交付编号。软件步骤提供已合入的完整 40 或 64 位提交号和目标分支，两项必须同时提供。
Builder 自行创建分支和 worktree、处理冲突、检查并合入，登记接口校验参数和归属。
文件步骤沿用工作流的成果清单与文件存在性校验，无需 Git。

完成返回 `{ "ok": true, "deliveryId": "...", "finished": false }`，最后一步的 `finished` 为 `true`，并附上归档交接。
同一运行重复登记相同结果返回原结果。结果不同、参数错误、运行不拥有当前步骤或成果不齐时非零退出，交付保留供恢复。
成功退出的运行仍须完成登记。归档中断后可重试同一结果。

`cancel` 停止运行并结束交付，保留磁盘成果。`resume` 返回交付与运行编号，继续原会话或从既有成果恢复。
交付外仍可使用 `akb raw archive <id>` 手动归档。`delivery conflict`、`delivery blocked`、`delivery discard` 和 `workflow worktree` 已移除。

工作流只存于云端（#409）：`akb workflow list` 列出当前工作区可用的工作流，各版本缓存在本机 `workflows/`；`akb raw workflow rename` 只在「搭建工作流」任务里写草稿，`delete`、`agent` 已移除，改在网页上管理。
