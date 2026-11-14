# CLI contract 17

Only current command names and stored formats execute. `akb raw`, the npm command names,
`docs/kanban`, `.akb/kanban`, explicit `--board`, single-stage previews and execution recovery remain supported.

| Retired input | Current input |
| --- | --- |
| `guide discuss-idea` | `guide discuss-goal` |
| `guide spec-skill`, `guide spec-agent` | `guide preview-agent` |
| `recommend-tech-stack`, `technology-selection` | `tech-stack-advisor` |
| `ui-design` | `ui-designer` |
| `video-assets` | `hyperframes-editor` |
| `memory-reviewer` | `chat-reviewer` |
| `user-docs` | `copywriting`, when registered in that studio |
| Goal preview `ui`, `api` | Exact registered preview names |
| `skills/*`, `SKILL.md` discovery | `agents/<name>/AGENT.md` |
| `reads: commits` | `reads: archived-cards` |
| `AI4KANBAN_LANGUAGE_LINE`, job `languageLine` | `AI4KANBAN_LANGUAGE`, job `language` |
| `harness`, `harnessSettings`, `agentHarness`, `.local.json` models | `runtimes`, `agentRuntime` in project state |
| `.mockups/<id>/` | `.assets/<id>/` |
| Old global/module/one-file agent memory | `memory/agents/<owner>/` |
| Machine-home project state, absolute old plan paths | Project-local `.akb/boards/...`, logical `plans/...` |
| Body `## Source`, triage `source`/`platform` | Card `source`/`triage`, triage `source_type`/`meta` |

Unknown guides retain `unknown-guide`; unknown previews retain `no-such-spec-agent` or
`needs-input`. Create/update/goal preview changes reject unknown names before saving.
Old fields do not create runtimes or infer runtime IDs. Retired pointer files are left intact.

`akb.session: new` remains a recommendation for a separate session; the calling agent chooses.
`akb.after` retains the studio's actual approval dependencies. Neither implies internal stages.
Explicit empty language means no system language, without falling back to local settings.
User prompt text is retained. Only the two current system-language paragraphs are replaced on
supported resumes and child runs; connectors unable to update them retain their existing handling.

## One-time conversion

Build the CLI, then run the standalone converter outside normal CLI reads:

```sh
node cli/dist/retire-legacy.mjs --project /absolute/project --board /absolute/project/.akb/kanban --dry-run
node cli/dist/retire-legacy.mjs --project /absolute/project --board /absolute/project/.akb/kanban --apply --receipt /private/backups/local.json
```

A Runner package carries it at `dist/akb/dist/retire-legacy.mjs`. Supply `--legacy-state <dir>`
only for that board's authorized machine-home copy. It remains untouched. Only key variable names may be inventoried; key values are never exposed, copied or reassigned.
Backups exclude `.env`. Model-specific runtime rows explicitly retain their base's secret
references through `secretRefs`; existing runtime IDs and key variables stay unchanged.

The plan lists paths and fingerprints. Different same-named files or conflicting bindings stop
the entire apply. Affected active runs must finish or stop with a saved checkpoint; unrelated
runs continue. The converter copies complete asset trees, including unreferenced files, dependencies
and executable permissions. It converts frozen structures while preserving stage IDs, generations,
asset versions, approvals, session IDs and dependencies. Recurring cards with unresolved questions
or dependencies remain blocked for review; other originals remain archived as plans.

UI writing and illustration preferences fold into `ui-designer`'s `writing.md`, `style.md` and
`redesign.md`; its prompt reads them once. Video catalogues move with their files and references.
User prose, code-fenced heading examples, logs and unrelated historical files retain their content.
Backups and a receipt are written before mutations, then output fingerprints are verified.
Repeated conversion makes no further changes. A failed apply retains its prepared receipt.

After deploying the additive Cloud migration and synchronizing the converted board, inspect and
apply only the authorized project/workspace:

```sh
node cloud/scripts/retire-cli-legacy.mjs --project <project> --workspace <workspace> --dry-run
node cloud/scripts/retire-cli-legacy.mjs --project <project> --workspace <workspace> --apply --local-receipt /private/backups/local.json --receipt /private/backups/cloud.json
```

The Cloud operation inventories task metadata, frozen previews, pinned studio versions, pending
platform jobs, schedules and agent/runtime bindings. Changed definitions get new version snapshots;
shared versions and other projects' task pins are retained. Optimistic row checks reject concurrent
claims, approvals or edits. `GET /v1/projects/{id}` includes additive `akbContract`; existing projects
remain at 16 until conversion verifies, and new projects start at 17. Runner checks this and the
local conversion marker before using contract 17. Offline or unconverted projects stay held.

## Delivery and rollback

Back up all Cloud tables as required by [deployment](../deploy.md), deploy migrations and compatible
Cloud, then publish the Runner carrying contract 17 through Alpha/candidate/stable. Publish changed
studios and promote CLI contract 17 after conversion. The global Runner protocol floor is unchanged.
Plugins need no release because their calls and distributed instructions are unchanged.

Stop new dispatch before a rollback. Withdraw Runner/CLI rollout, restore compatible applications,
then use guarded receipts:

```sh
node cloud/scripts/retire-cli-legacy.mjs --project <project> --workspace <workspace> --rollback /private/backups/cloud.json --apply
node cli/dist/retire-legacy.mjs --rollback /private/backups/local.json
```

New edits or approvals stop restoration instead of being overwritten. Keep new immutable studio
snapshots, migration history and receipts. Fix schema forward; never replace the database with an
old backup or restart live workers to perform conversion.
