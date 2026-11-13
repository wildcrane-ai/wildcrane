# OpenCode 的 WildCrane 插件

在 OpenCode 讨论目标，到 WildCrane 网页审阅、启动；也能查询、创建和管理任务。沿用已有登录、项目与计费。需要 OpenCode 2.2.7+、Node.js 22+、Runner 0.6.55+；首次使用自动下载 Runner。

## 安装

```sh
npx --yes wildcrane-opencode@latest install
```

安装器先下载 WildCrane，再修改全局 `opencode.json(c)` 中的本插件条目。保留其他插件、注释、instructions、权限和用户技能。无需配置 MCP 或复制技能。插件注册六个原生工具，以及 `wildcrane-discuss-goal`、`wildcrane-tasks`、`wildcrane`（设置）三个技能；同名用户技能优先。

让 OpenCode 打开 WildCrane 设置，即可登录、添加项目。讨论工作只保存目标，用户从网页开始；明确要求新建任务时会实际创建任务。插件只传工具参数及会话身份，不上传整段对话。

## 更新

```sh
npx --yes wildcrane-opencode@latest update
```

安装后即可检查更新。固定版本保持固定。下载成功后才修改配置；失败时报告原因，保留当前配置版本。

## 固定版本、回退或卸载

```sh
npx --yes wildcrane-opencode@latest install 0.1.21
npx --yes wildcrane-opencode@latest remove
```

将 `0.1.21` 换成所需的已发布版本。不带版本运行 `install` 可恢复跟随更新。安装、切换版本或卸载后重新打开 OpenCode。只改 WildCrane；保留任务、讨论、登录、其他插件及用户技能。

安装器管理 `OPENCODE_CONFIG_DIR` 或 `$XDG_CONFIG_HOME/opencode` 下的全局配置（默认 `~/.config/opencode`），下载版本保存在其专属的 `wildcrane/packages` 目录。`install` 会迁移已有全局 npm 条目，不修改项目配置。OpenCode 原生更新命令依赖异步发现的插件清单，因此 WildCrane 使用上述统一命令。

## 接口与发布

工具契约见 [英文说明](README.md#interfaces-and-release)。在 `runner/` 运行 `npm run build`，再在本目录运行 `npm pack`；先发布兼容的 Runner，再发布插件。
