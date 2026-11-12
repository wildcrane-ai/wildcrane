# OpenCode 的 WildCrane 插件

在 OpenCode 讨论目标，到 WildCrane 网页审阅、启动；也能查询、创建和管理任务。沿用已有登录、项目与计费。需要 Node.js 22+、Runner 0.6.55+；首次使用自动下载 Runner。

## 安装

OpenCode V2（2.2.7+）：

```sh
opencode plugin add wildcrane-opencode
```

OpenCode V1（1.18.30+）：在 `opencode.json` 或 `opencode.jsonc` 的现有 `plugin` 数组追加插件，再重启：

```json
{ "plugin": ["wildcrane-opencode@0.1.21"] }
```

V2 也可配置 `{ "plugins": ["wildcrane-opencode"] }`。保留其他配置。无需配置 MCP 或复制技能。插件装入六个原生工具，以及 `wildcrane-discuss-goal`、`wildcrane-tasks`、`wildcrane`（设置）三个技能，沿用宿主权限。

让 OpenCode 打开 WildCrane 设置，即可登录、添加项目。讨论工作只保存目标，用户从网页开始；明确要求新建任务时会实际创建任务。插件只传工具参数及会话身份，不上传整段对话。

## 更新和恢复

- **V2**：运行 `opencode plugin update wildcrane-opencode`，再运行 `opencode service restart`。固定版本不会自动更新；修改本插件条目以解除固定或切换版本。
- **V1**：修改 `plugin` 中本插件的版本并重启。若缓存仍旧，关闭 OpenCode，在 `opencode debug paths` 显示的缓存内只移除 `wildcrane-opencode`，再重启；保留其他包和配置。
- **下载失败或离线**：检查 npm、WildCrane 的网络连通性及 `node --version`（22+），再重新加载。低于 0.6.55 的 Runner 会被拒绝，不会冒充其他宿主运行。
- **断线或取消**：恢复连接后重试。同一会话重开仍找到同一讨论。取消时写入可能已到达 Cloud，重试保存前先读取最新讨论。

## 卸载和回退

V2 运行 `opencode plugin remove wildcrane-opencode`；固定版本时使用配置中的完整包名。V1 只移除 `plugin` 中本插件的条目并重启。关闭或重载后释放本插件连接，不关闭其他宿主使用的 Runner。

后续升级可固定 `wildcrane-opencode@<版本>` 回退。首版可通过移除插件停用。任务、讨论和登录会保留；服务端回退仍须兼容读取 `opencode` 数据。

接口、构建、发布顺序和官方依据见 [English README](README.md)。npm 发布与生态目录 PR 合并分别记录；提交不代表已收录。
