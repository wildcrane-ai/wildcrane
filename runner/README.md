# wildcrane-runner

WildCrane's Local Runner. It connects this computer to WildCrane and runs the tasks WildCrane
sends on your local Claude Code, Codex, OpenCode or Cursor.

支持 macOS、Windows 和 Linux，通过终端运行。桌面端 App 已暂停支持。

```sh
npm install -g wildcrane-runner
wildcrane-runner
```

首次启动会打开浏览器登录。独立 Runner 与插件内的 Runner 每分钟检查云端指定版本，
下载成功后自动保存交接并替换 Runner，恢复任务和对话，独立执行中的任务继续运行。
新版启动失败或两分钟内未连上云端时，自动退回刚才运行的版本，五分钟后可重试同一版本。
旧安装需更新一次启动器。终端安装使用 `npm install -g wildcrane-runner@latest`，插件安装使用
宿主的插件更新入口。重启旧 Runner 所在的终端或插件会话后，启动器会自动迁移旧版本记录。

更新交接的作业保留 7 天，期间断网会等待重连。已完成的结果直接回写；操作结果不明或
连接器无法提供恢复依据时，任务会提示检查后续跑，避免重复执行。
更新交接不计作失败或模型重试；有原会话且进程已停止的未决操作，检查已有改动后可继续。
Cloud 的 Runner 发布入口会先运行真实数据库的更新恢复回归；缺少 PostgreSQL 或验证失败时禁止推广版本。

任务对话与项目讨论的模型失败最多共尝试三次，恢复窗口为两分钟；续接前先核对已有结果，
保留成果与用户决定。失败仍保留已生成的回复，并提供手动重试入口。

Codex 由 Runner 管理原生 App Server，任务直接连接；Runner 更新或崩溃不会断开原有任务。
需要支持原生持久监听的 Codex（已验证 0.169.0-alpha.11.1）；不支持时会在提交任务前提示更新。
旧共享服务上的任务与保留服务先安全结束，新任务使用新路径；状态不明的旧工作会保留。

- **看板与技能**：通过插件连接云端项目；Runner 在绑定目录和运行任务时把 kanban 技能写入项目，无需手动安装，并维护提交保护，保留用户文件和已有钩子。

- **Node**: 22 or newer.
- **代理**：Runner 优先使用启动环境的 `HTTP_PROXY`、`HTTPS_PROXY` 或 `ALL_PROXY`，否则跟随 macOS 系统代理。其他平台可通过环境变量指定代理。旧版 `proxy.env` 中仍需使用的配置可移到启动环境。
- **One computer per account**: a second computer is refused while the first is connected.
- **Folders**: tasks run in `~/.wildcrane/work/`, or in a project folder listed in
  `~/.wildcrane/projects.json` (`{ "projects": ["/path/to/project"] }`). Any other folder is
  refused. 在插件中添加项目文件夹，或手动维护该列表。
- **Task folders**: a task's jobs share its board, `<project>/.akb/kanban` (kept out of git),
  or for a project with no folder here its own one, `~/.wildcrane/cache/<project>/.akb/kanban`
  (a git repository). They run one at a time and sync the card, memory and assets with
  WildCrane before and after each job.
- **Cache**: what a project keeps here is rebuilt from WildCrane by its next job. At start and
  once a day the Runner removes a project unused for 7 days or no longer in your account — its
  whole `cache/<project>/`, or only a linked folder's `.akb/` — unless a job runs there, a
  delivery is paused there, or its last sync failed.
- **Diagnostics**: The Runner, launcher and task processes share a local JSON Lines log at
  `~/.wildcrane/logs/runner.log` (`$WILDCRANE_HOME/logs/runner.log` when overridden).
  It records lifecycle events, stdout and stderr, including output from earlier task attempts.
  Output may contain task content. The log files are private to the local user.
  Logs rotate on UTC date changes or at 5 MiB. The current file and up to three archives
  (`runner.log.YYYY-MM-DD.N`) cover at most seven UTC dates including today, and 20 MiB total.
  Existing per-worker and Codex log files from earlier versions remain in place.
  If the log cannot be written, the Runner continues and warns on stderr at most once a minute per process.
- **Runner files**: `~/.wildcrane/bin/` holds the downloaded versions and the `akb` shims.
- **Periodic agents**: in each project folder it also runs the board's own agents (reflect,
  describe-project, review-dismissals, prune-memory) and each studio's scheduled agents, when
  due by this computer's clock — on your runtime, so they use its quota.
- **akb**: tasks started from WildCrane run akb's studios, on whichever of those the task's
  runtime names, with the version WildCrane names, else the copy the Runner carries (`dist/akb/`).
  Each registration may name a new one: it downloads from npm in the background to
  `~/.wildcrane/bin/akb/<version>/`, and takes over at the next task step once its contract matches
  and it answers `--version`. One that fails is never tried again (`bin/akb/state.json`); a version
  not chosen for 7 days is removed. No npmjs access means staying on the version in use.

## Development

`npm install` here (it builds `dist/`), `npm test`, `npm run lint`. The Runner bundles the CLI's
harness, session and Realtime code from `../cli/src`, and the CLI itself into `dist/akb/`, so
`cli/` needs its own `npm install`.
Releasing: [`docs/deploy.md`](../docs/deploy.md).

## 插件目标草稿

Codex 使用 `wildcrane_draft_read({ path?, discussionId? })`，Claude 使用 `wildcrane_draft_read({ discussionId?, sessionId? })`。返回 version、studios、goals 和同值 ideas，以及讨论 url 和各目标 url；已开始目标链接任务。

`wildcrane_draft_save({ discussionId, expectedVersion, goals })` 保存全部开放目标，最多 10 个，遗漏的开放目标会丢弃，保存不会开始任务。旧 ideas 入参继续可用，缺少或同传两者均返回 bad_request。冲突返回最新 version、goals 和 ideas，供合并后重试。两个宿主的保存结果都含目标网页链接。目标从网页管理和开始。`wildcrane_status().recent[]` 提供 goals 计数及兼容 ideas 计数。

`wildcrane_status({ path? })` 另返回 `akb`：本插件 `akb` 的绝对路径，登录与否都有；本机未能写好时省略。不支持 MCP 说明的宿主（如 dsh）用它运行 `akb task`，无需打开讨论。

```text
wildcrane_status({ path: "/Users/me/app" })
→ { "signedIn": false, "akb": "/Users/me/.wildcrane/bin/akb/akb", "signing": null, "connections": [...] }
```

Runner（含启动器的更新与下载、它启动的看板命令）与其启动的 Agent 优先继承 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 及其小写变量。缺少这些变量时，macOS 上使用系统已启用的手动 HTTP、HTTPS、SOCKS 代理与绕过列表，每分钟及每个任务前重新读取，开关或修改代理无需重启；不执行 PAC。其他平台通过启动 Runner 的环境配置代理。无代理配置时保持直连。连接恢复后以最终执行结果收尾；可选 MCP 错误保留在日志中，不单独使任务失败。

## 共享本机设置

运行 `wildcrane-runner --settings`，或在 Claude Code、Codex 中要求打开 WildCrane 设置，即可登录、查看工具状态、选择项目文件夹和解除绑定。Claude Code 的 `/wildcrane`、Codex 的 `$wildcrane` 直接打开它；旧的登录和添加目录工具继续可用。

选择文件夹后仍需确认才会授权。新项目可直接选择所属空间；绑定仅指定任务目录，不提供文件系统隔离。界面随 Runner 和两种插件打包，无需联网下载页面资源。

设置服务仅在前台宿主运行期间可用，同一配置目录共用一个入口；关闭宿主后，从其他插件重新打开即可。终端复用已有入口时正常退出，承载服务时保持前台运行。本机运行过更新的 Runner 时，设置页由它提供，无需更新插件；旧版 Runner 不带设置页时使用宿主自带的。无法自动打开浏览器时，可在同一电脑手动访问输出的临时地址。

先发布支持协议 14 的 Runner 与插件，再发布云端设置引导。云端仍接受现有协议，不提高最低版本；旧插件显示更新提示。回退保留原会话和兼容目录清单。

本机设置的“接受 Alpha 版本更新”默认关闭，Alpha 风险较高，不建议日常使用。
开启一次后持续接收团队验证版本；关闭后保留当前版本，等待正式版追上，不会因关闭选项自动降级。
运维主动撤回版本仍可触发回滚。同版本晋级不重启。

偏好独立保存在 `runnerHome()/preferences.json`（默认 `~/.wildcrane/preferences.json`）的
`acceptAlphaUpdates` 布尔字段；断网可保存，重启和退出登录保留，不随账号同步。
同一目录的终端和插件共用设置。旧安装必须手动更新一次安装包或插件以升级外层启动器；
只自动更新子进程不能获得 Alpha 支持。此选项只控制 Runner，不影响 akb 或插件自身的更新渠道。
