# WildCrane for Antigravity CLI

Requires Antigravity CLI and Node.js 22+. Install or update from the same URL, then open a new AGy session.
需要 Antigravity CLI 和 Node.js 22+。从同一地址安装或更新，再开启新的 AGy 会话。

```sh
agy plugin install https://github.com/wildcrane-ai/wildcrane/tree/antigravity-plugin
```

Run `/wildcrane` to open local settings. Tell AGy what you want to build to save a goal you can start on the web, or ask it to find a task. The plugin uses your existing WildCrane login and folder bindings.
用 `/wildcrane` 打开本机设置。和 AGy 讨论要做的事，在网页启动保存的目标，也可以请 AGy 查找任务。插件沿用 WildCrane 登录和项目目录绑定。

On first use the launcher reuses or downloads WildCrane Runner 0.6.107 or later. Runner updates automatically.
首次使用时，启动器复用或下载 WildCrane Runner 0.6.107 或更高版本。Runner 会自动更新。

Uninstalling keeps your WildCrane account, project bindings, goals and tasks.
卸载后保留 WildCrane 账号、项目绑定、目标和任务。

```sh
agy plugin uninstall wildcrane
```

For local development, run `npm run build` in `runner/`, then install `plugins/antigravity/` by absolute path. Set `WILDCRANE_RUNNER_DIR` to the checkout's `runner/` directory to test the local build.
本地开发时，先在 `runner/` 中构建，再用绝对路径安装 `plugins/antigravity/`。将 `WILDCRANE_RUNNER_DIR` 指向该工作树的 `runner/` 可测试本地构建。
