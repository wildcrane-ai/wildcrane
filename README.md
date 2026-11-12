# WildCrane for Cursor

Shape goals with Cursor in your own chat and start them as WildCrane tasks, run on this computer.

- **Needs**: the Cursor editor (not the Cursor CLI), and Node 22 or later. macOS and Linux.
- **Goals**: tell Cursor what you want to build; it asks in the chat and saves the goals,
  replying with one line and a link per goal. Review, change the studio, discard and **Start** on
  the web: Cursor never starts a task.
- **Ask Cursor**: for your projects, recent discussions and agent connections.
- **`akb`**: when none is installed, Cursor is told the full path of the Runner's own. Not on
  Windows.

## Install

In Cursor, open **Customize**, search **WildCrane**, then **Install**. It updates on its own.

## Settings

Run `/wildcrane` in a Cursor chat to open WildCrane settings in your browser: sign in, project
folders and AI tools.

## Develop

```sh
cd runner && npm install && npm run build      # writes plugins/*/server/dist/start.mjs
export WILDCRANE_RUNNER_DIR=$PWD               # Cursor runs this checkout's Runner
ln -s "$PWD/../plugins/cursor" ~/.cursor/plugins/local/wildcrane
```

Then run **Developer: Reload Window** in Cursor, and check the plugin under **Customize**.

## Check it

```sh
cd runner && npm test
plugins/cursor/server/bin/wildcrane cursor </dev/null && echo started
echo '{"session_id":"c1"}' | plugins/cursor/hooks/session.sh
```

## Release

Each `plugin-v*` release puts the built plugin at the root of the `cursor-plugin` branch, the Git
source the Cursor Marketplace listing points at.
