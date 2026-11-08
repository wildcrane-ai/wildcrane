# WildCrane for dsh

Shape goals with dsh in your own chat and start them as WildCrane tasks, run on this computer.

- **Needs**: dsh, [pnpm](https://pnpm.io/installation), and Node 22 or later. macOS and Linux.
- **Goals**: tell dsh what you want to build; it asks in the chat and saves the goals, replying
  with one line and a link per goal. Review, change the workflow, discard and **Start** on the web:
  dsh never starts a task.
- **Ask dsh**: for your projects, recent discussions and agent connections.

## Install

```sh
dsh plugin --profile web add wildcrane-dsh
```

Then restart `dsh web`.

## Update

dsh tells you when a newer version is out. Run the same command with `@latest`, then restart
`dsh web`.

## Settings

Run `/wildcrane` in a dsh chat to open WildCrane settings in your browser: sign in, project
folders and AI tools.
