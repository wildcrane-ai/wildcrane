# WildCrane for OpenCode

Discuss goals, review them on the WildCrane website, and manage tasks from OpenCode. Uses your existing WildCrane login, projects and billing. Requires OpenCode 2.2.7+, Node.js 22+ and Runner 0.6.55+ (downloaded on first use).

## Install

```sh
npx --yes wildcrane-opencode@latest install
```

The installer downloads WildCrane before changing its entry in your global `opencode.json(c)`. Other plugins, comments, instructions, permissions and user skills are preserved. No MCP configuration or skill copying is needed. Six native tools and three skills are registered: `wildcrane-discuss-goal`, `wildcrane-tasks`, and `wildcrane` (settings). User skills with the same name take precedence.

Ask to open WildCrane settings to sign in or add a project. Discussing work saves a goal for review; ask to create a task when you want an actual task. Goals remain on the website until you start them. The adapter sends only tool arguments and session identity, never the complete chat.

## Update

```sh
npx --yes wildcrane-opencode@latest update
```

This also checks for updates immediately after installation. Pinned versions stay pinned. Downloads finish before configuration changes; a failure reports the cause and leaves the configured version in place.

## Pin, roll back or uninstall

```sh
npx --yes wildcrane-opencode@latest install 0.1.21
npx --yes wildcrane-opencode@latest remove
```

Replace `0.1.21` with the desired published version. Run `install` without a version to follow updates again. Reopen OpenCode after any installation, version change or removal. Only WildCrane changes; tasks, discussions, login, other plugins and user skills remain.

The installer manages global configuration under `OPENCODE_CONFIG_DIR`, or `$XDG_CONFIG_HOME/opencode` (default `~/.config/opencode`). It retains downloaded versions in its own `wildcrane/packages` directory. Existing global npm entries are migrated by `install`; project configuration is left untouched. OpenCode's native update command uses an asynchronously discovered plugin inventory, so use the commands above for WildCrane.

## Interfaces and release

The native tools preserve the existing contracts: `wildcrane_open_settings({path?,project?})`, `wildcrane_status({path?})`, `wildcrane_sign_in({})`, `wildcrane_add_folder({path,project?})`, `wildcrane_draft_read({discussionId?,path?})`, and `wildcrane_draft_save({discussionId,expectedVersion,goals?,ideas?})`. Pass exactly one goal list on save. Every call uses the real host session and directory; missing identity fails explicitly. Task operations use the returned `akb` executable and `akb task --help`.

Build with `npm run build` in `runner/`, then `npm pack` here. Shared skills are copied completely at build time. Release after the compatible Runner. See [OpenCode plugin configuration](https://opencode.ai/docs/plugins/) and [native tools, skills and cleanup](https://opencode.ai/docs/build/plugins/server/).

[中文](README.zh-CN.md)
