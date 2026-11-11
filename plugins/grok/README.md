# WildCrane for Grok Build

Discuss goals, manage tasks, and open local WildCrane settings from Grok Build.

## Install / 安装

Needs macOS or Linux, Node 22+, and Grok Build (validated with 1.0.70).
需要 macOS 或 Linux、Node 22+ 和 Grok Build（以 1.0.70 验证）。

```sh
grok plugin install wildcrane-ai/wildcrane@grok-plugin --trust
```

`--trust` allows the plugin to start its local MCP server. The launcher downloads the
WildCrane Runner on first use. No Claude Code installation or manual MCP configuration is
needed. Open a new Grok session after installing.
`--trust` 允许插件启动本机 MCP 服务，首次使用会下载 Runner。无需安装 Claude Code 或手填 MCP；安装后新开 Grok 会话。

Tell Grok what you want to build; it saves goals for you to review and **Start** on the web.
Ask it to list or change your tasks, or run `/wildcrane` to open settings and sign in.
Existing WildCrane login, projects and billing apply; Grok credentials are never read or migrated.
描述要做的事情后，在网页审阅并启动目标；也可让 Grok 列出或操作任务。`/wildcrane` 打开本机设置以登录。沿用 WildCrane 登录、项目和计费，不读取或迁移 Grok 凭据。

## Update and recover / 更新与恢复

```sh
grok plugin update wildcrane
```

Reopen the session. Updates follow the installed source; no Grok auto-update settings are changed.
更新后重开会话。更新跟随安装来源，不改变 Grok 自动更新设置。

To install or restore a verified commit, replace `<full-sha>` with the recorded 40-character
commit of the public `grok-plugin` branch:
安装或恢复已验证版本时，使用公开 `grok-plugin` 分支上记录的完整提交 SHA：

```sh
grok plugin uninstall wildcrane
grok plugin install wildcrane-ai/wildcrane@<full-sha> --trust
```

A pinned commit stays pinned. Reinstall from `@grok-plugin` to follow releases again.
固定提交不会跟随分支更新；重新安装 `@grok-plugin` 恢复跟随发布。

| Problem / 问题 | Recovery / 恢复 |
| --- | --- |
| Signed out / 未登录 | `/wildcrane`: sign in / 登录 |
| No AI tool ready / 无可用 Agent | `/wildcrane`: install or sign in to a supported tool / 安装或登录 Agent |
| Disabled / 已禁用 | `grok plugin enable wildcrane` |
| Untrusted installation / 安装未信任 | Repeat the install with `--trust` / 加 `--trust` 重新安装 |
| Missing Node / 缺少 Node | Install Node 22+, reopen Grok / 安装 Node 22+ 后重开 |
| Runner download, old Runner, network or update failure / Runner 下载、旧版本、网络或更新失败 | Check connectivity and retry; Grok requires Runner 0.6.52+ / 检查网络后重试，需 Runner 0.6.52+ |
| First release fails / 首版故障 | Disable or uninstall; wait for a higher fixed version / 禁用或卸载，等待修复版 |

```sh
grok plugin disable wildcrane
grok plugin uninstall wildcrane
```

These commands retain WildCrane data, login, projects and other plugins.
禁用和卸载保留 WildCrane 数据、登录、项目及其他插件。

## Develop / 开发

Run `npm run build` in `runner/`, then install `plugins/grok` by its absolute local path.
Set `WILDCRANE_RUNNER_DIR` to that checkout's `runner/` to test its component without a download.
Use an isolated `GROK_HOME` and `--leader-socket` for tests; never copy Grok credentials.
Skills are generated from `plugins/shared/skills/`; edit the shared source.
在 `runner/` 构建后安装本地插件路径；测试时设置独立 `GROK_HOME` 和 leader socket，不复制凭据。技能源在共享目录维护。

## Sources / 依据

- [Official plugin documentation](https://docs.x.ai/build/features/skills-plugins-marketplaces)
- [Official catalog submission rules](https://github.com/xai-org/plugin-marketplace#add-or-update-a-plugin)

Direct installation and catalog listing are separate. Do not claim an official listing until its
PR is merged. Every catalog update must pin the new full SHA and regenerate its component index.
直接安装与官方目录上架独立；目录 PR 合并前不宣称已上架。目录更新需固定新 SHA 并重新生成组件索引。
