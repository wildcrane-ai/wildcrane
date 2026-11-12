# WildCrane for OpenCode

Discuss goals, review them on the WildCrane website, and manage tasks from OpenCode. Uses your existing WildCrane login, projects and billing. Requires Node.js 22+ and Runner 0.6.55+ (downloaded on first use).

## Install

OpenCode V2 (2.2.7+):

```sh
opencode plugin add wildcrane-opencode
```

OpenCode V1 (1.18.30+): append this package to the existing `plugin` array in `opencode.json` or `opencode.jsonc`, then restart:

```json
{ "plugin": ["wildcrane-opencode@0.1.21"] }
```

V2 can also use `{ "plugins": ["wildcrane-opencode"] }`. Keep your other entries. No MCP configuration or skill copying is needed. The package registers six native tools and three skills: `wildcrane-discuss-goal`, `wildcrane-tasks`, and `wildcrane` (settings). Existing permission rules still apply.

Ask to open WildCrane settings to sign in or add a project. Discussing work saves a goal for review; ask to create a task when you want an actual task. Goals remain on the website until you start them. The adapter sends only tool arguments and session identity, never the complete chat.

## Update and recovery

- **V2**: run `opencode plugin update wildcrane-opencode`, then `opencode service restart`. Exact versions stay pinned; edit your own package entry to unpin or change versions.
- **V1**: change only this package's version in `plugin`, then restart OpenCode. If its cached package is stale, close OpenCode, remove only `wildcrane-opencode` under the cache shown by `opencode debug paths`, and restart. Preserve other packages and configuration.
- **Download or offline errors**: check network access to npm and WildCrane, confirm `node --version` is 22+, then reload. A Runner older than 0.6.55 is refused rather than used under another host.
- **Disconnected or cancelled calls**: retry after reconnecting. Session identity survives a plugin restart; a cancelled write may already have reached Cloud, so read the discussion before retrying a save.

## Uninstall and rollback

V2: `opencode plugin remove wildcrane-opencode` (use the exact configured package target if pinned). V1: remove only this package from `plugin` and restart. Close or reload OpenCode to release its plugin connection. Other hosts retain their Runner connections.

Pin `wildcrane-opencode@<version>` in your own package entry to roll back a future update. This first release can be disabled by removing it. Tasks, discussions and login are retained; server rollback must keep the `opencode` host and its data readable.

## Interfaces and release

The native tools preserve the existing contracts: `wildcrane_open_settings({path?,project?})`, `wildcrane_status({path?})`, `wildcrane_sign_in({})`, `wildcrane_add_folder({path,project?})`, `wildcrane_draft_read({discussionId?,path?})`, and `wildcrane_draft_save({discussionId,expectedVersion,goals?,ideas?})`. Pass exactly one goal list on save. Every call uses the real host session and directory; missing identity fails explicitly. Task operations use the returned `akb` executable and `akb task --help`.

Build with `npm run build` in `runner/`, then `npm pack` here. Shared skills are copied completely at build time; V1's discovery copies change only their registered names. `plugin-v*` publishes npm updates through the existing release workflow, after the compatible Cloud migration/deploy and Runner release. npm publication and ecosystem PR acceptance are separate milestones.

Official references: [plugin configuration](https://opencode.ai/docs/plugins/), [V1/V2 compatibility](https://opencode.ai/docs/build/plugins/migrate-v1), [native tools, skills and cleanup](https://opencode.ai/docs/build/plugins/server/).

[中文](README.zh-CN.md)
