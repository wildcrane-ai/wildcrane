# WildCrane for Kimi Code

Shape goals with Kimi Code in your own session and start them as WildCrane tasks, run on this computer.

- **Needs**: Kimi Code 2.4 or later (the `kimi` command), and Node 22 or later. macOS and Linux.
  The older `kimi-cli` has no plugins.
- **Goals**: tell Kimi Code what you want to build; it asks in the conversation and saves the
  goals, replying with one line and a link per goal. Review, change the workflow, discard and
  **Start** on the web: Kimi Code never starts a task.
- **Ask Kimi Code**: for your projects, recent discussions and agent connections.
- **`akb`**: when none is installed, Kimi Code is told the full path of the Runner's own. Not on
  Windows.

## Install

In Kimi Code, run:

```text
/plugins install https://github.com/wildcrane-ai/wildcrane/tree/kimi-plugin
```

Then run `/new`. Kimi Code tells you when a newer version is out; update it from `/plugins`.

## Settings

Ask Kimi Code to open WildCrane settings; they open in your browser: sign in, project folders and
AI tools.

## Develop

```sh
cd runner && npm install && npm run build      # writes runner/dist/ and plugins/*/server/dist/start.mjs
export WILDCRANE_RUNNER_DIR=$PWD               # Kimi Code runs this checkout's Runner
kimi                                           # then: /plugins install <checkout>/plugins/kimi-code
```

After a rebuild, `/plugins remove wildcrane` and install it again: Kimi Code runs a copy. Each
`plugin-v*` release adds the built plugin to the `kimi-plugin` branch, at its root.

## Check it

```sh
cd runner && npm test                          # the component's tools, lock and lifecycle
plugins/kimi-code/server/bin/wildcrane kimi </dev/null && echo started
```
