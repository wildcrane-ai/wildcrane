# WildCrane for Claude Code and ZCode

Shape goals in your own Claude Code or ZCode session and start them as WildCrane tasks, run on
this computer. No separate Runner to install: the plugin starts this computer's Runner, downloading
it on first start, and the Runner updates itself. One Runner serves every tool open on this computer.

- **看板与技能**：通过插件连接云端项目；Runner 在绑定目录和运行任务时把 kanban 技能写入项目，无需手动安装，并维护提交保护，保留用户文件和已有钩子。

- **Needs**: Claude Code 2.1.287 or later with plugin mods on, or ZCode; and Node 22 or later on the PATH.
- **Settings**: `/wildcrane` opens this computer's settings in the browser — sign-in, project
  folders and AI tools. Projects and tasks are on the web. In ZCode, ask in the conversation to
  open WildCrane settings, sign in, or add this folder to a project.
- **Clarifying**: tell Claude what needs doing in the conversation; it shapes the goals and returns their web links. Review and start goals on the web.
- **`akb`**: sessions you start yourself run the Runner's `akb` ahead of any installed one, and
  find the board of a folder added to a project. Not on Windows.

## Install

Claude Code:

```sh
claude plugin marketplace add wildcrane-ai/wildcrane
claude plugin install wildcrane@wildcrane
```

ZCode:

1. Open **Settings → Plugin Management → Discover**, click **+**, and enter `wildcrane-ai/wildcrane`.
2. Find **wildcrane** and click **Get**.

If adding the marketplace times out behind a proxy, set `ZCODE_HTTP_PROXY=http://host:port` and
restart ZCode: it does not read `http_proxy`.

## Update

`/wildcrane` replies with these commands when a newer version is released. The
Runner, its tools and `akb` update on their own; the plugin rarely needs to:

```sh
claude plugin marketplace update wildcrane
claude plugin update wildcrane@wildcrane
```

Then run `/reload-plugins` in Claude Code. To update automatically, turn on auto-update for
wildcrane under `/plugin` → Marketplaces.

In ZCode, update **wildcrane** under **Settings → Plugin Management**.

## Develop

```sh
cd runner && npm install && npm run build      # writes runner/dist/ and plugins/*/server/dist/start.mjs
WILDCRANE_RUNNER_DIR=$PWD claude --plugin-dir ../plugins/claude-code   # run this checkout's Runner
```

Releasing: raise `version` in `.claude-plugin/plugin.json` (and `plugins/codex/plugin.json`, `plugins/cursor/.cursor-plugin/plugin.json`, `plugins/kimi-code/kimi.plugin.json`), push
the tag `plugin-v<version>`
(`.github/workflows/plugin-release.yml`, which updates Codex's and Cursor's branches). The marketplace
installs this folder from the public repo's main, where `public-sync` adds the built
`server/dist/start.mjs`; it carries no Runner.

## Check it

```sh
cd plugins/claude-code && claude plugin validate . && claude plugin test .
```
