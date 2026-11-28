# Studio definitions

## Definition

A Studio is one `STUDIO.md`: YAML frontmatter holds display metadata, while Preview
blocks contain short output instructions. No role configuration, `when`, split Preview
files or per-Preview component allowlist is used.

```markdown
---
name: Coding
description: Plan and deliver software changes.
icon: software
previews:
  prompts:
    icon: prompt
    title: {en: Prompts, zh: 提示词}
    description: {en: Review changes to instructions., zh: 审阅指令变更。}
---

## Work

Produce only the requested work. Keep outputs concise.

## Land

Check the approved changes, merge them into the target branch, and record the commit and branch.

## Previews

<Preview id="prompts">

Show the changed instructions; follow `akb guide write-prompt` when writing them.
Recommended display: inline Markdown for one small change, Assets for two files,
or Set for more than two files.

</Preview>
```

- **Metadata**: required nonempty `name`; optional `names`, `description`, `needsArtifact`,
  Studio `icon` and `previews`. The display map uses unique lowercase dash-separated IDs.
  Custom Preview authoring requires non-blank `en` and `zh` entries in both `title` and
  `description`. A missing `icon` displays `file`. Older definitions remain readable:
  labels fall back to English, another supplied title, or the ID. Review points open
  the description when it is available in the current language.
- **Follow-ups**: Optional `allowedFollowUps` is a string of admission rules for Follow-up and
  Reflect. Omit it or leave it blank to disable both. Built-in Coding is enabled by default.
- **Schema**: use one shared strict JSON Schema, with additionalProperties:false for
  Studio metadata and each Preview metadata object, explicit locale keys, no coercion,
  and existing glyph/path-part icon constraints. Reject nulls, malformed or duplicate YAML
  keys, unknown fields, invalid locale values and invalid icons. `when`, `file`, `components`,
  `format`, `land`, `scheduled`, `memoryFiles`, `runtime`, `session`, `after` and `stages`
  do not belong in the new definition. YAML is checked before constructing its map.
- **Sections**: include exactly one top-level `## Work`, `## Land`, and `## Previews`.
  Work describes the workflow and tools. Land describes what to deliver, where it goes,
  what to check and what to record. Both require instructions. Put every Preview block
  under Previews, which may be empty when there are no Previews. Use `## Setup` and
  `## Planning` when needed. Headings in code examples and Preview blocks do not count.
- **Blocks**: opening `<Preview id="<id>">` and closing `</Preview>` each occupy their own
  line, with optional indentation. Require exactly one quoted `id` attribute and a nonempty
  Markdown body. Reject missing or stray closing tags, malformed reserved tags, nested or
  self-closing Preview blocks, extra attributes and repeated IDs. Recognize this delimiter
  grammar without treating the Markdown body as an XML document. Fenced and inline code
  examples are literal; headings inside a block are ordinary output requirements.
- **ID correspondence**: map keys and body block IDs must match exactly in both directions.
  Every block needs one map entry. An unused metadata entry fails. Without
  blocks, omit `previews` or use `{}`. Block order determines result order; YAML key order
  does not. Renaming a title or icon leaves the explicit ID unchanged.
- **Context**: the app parses the complete file and provides the work and delivery instructions,
  block IDs and short bodies to the model, together with all supported component usage
  once per Studio session. Display metadata is excluded from generated prompt context.
  References and AKB Guides are read when needed, not eagerly expanded. Direct authoring
  edits can still read the complete source file. Display recommendations remain prose,
  not enforced file-count rules or configuration.
- **References**: keep safe local links to optional references, scripts and shared resources.
  Reject missing paths, traversal, absolute paths and escaping symlinks. Resolve
  `akb guide <topic>` against shipped topics. Ordinary external evidence links stay links.
  Reading, validation or publication never executes a referenced script.
- **Task output**: results use the same `<Preview id="<id>">` / `</Preview>` delimiters,
  with Markdown and existing components rendered inside them. The app supplies labels
  and icons from the task-bound Studio map, not from generated text or the latest market
  version. Unknown IDs fail except recorded migration-only historical IDs. Single results
  display directly; multiple results retain Multitab and the full scrollable directory.
  Both devices display only the current result; Set remains the file selector inside it.
- **Validation**: CLI validation, create and update, Cloud writes, and official packaging
  use the same section, schema, delimiter, ID and reference checks. Reject invalid input
  atomically. Existing published definitions, task pins and review baselines remain readable.
  Source diagnostics identify the file, line, column, field or block path, code and repair
  hint; validators report errors without modifying files. The Agent fixes editable drafts
  from these diagnostics and reruns validation before continuing its authorized operation.

## Skills and resources

A Studio can keep text files at safe relative paths. The root version, publication and official catalog metadata files are reserved. Each optional Agent Skill has an
entry at `skills/<name>/SKILL.md` and can include scripts, references and templates under
the same directory. Use standard YAML metadata and Markdown instructions. For imports,
record the source URL and fixed revision under `metadata`. [Agent Skills specification](https://agentskills.io/specification)

A fresh runtime session receives a Markdown catalog with names, descriptions and
absolute SKILL.md paths. The Agent reads a skill and its resources when it needs them.
A new execution takes the latest publication. A continuing execution keeps its saved
version, and recovery fails explicitly if that snapshot is unavailable.

## Validation diagnostics

`akb studio validate <folder> --json` returns its existing action-result envelope.
On success: `{folder, problems: [], fingerprint}`. On failure: a nonzero exit and
`studio-problems`, containing structured problems with `file`, `line`, `column`, `path`,
`code`, `message` and `hint`; no fingerprint is accepted. HTTP writes use the same problems
inside the existing `bad_request` error details and create no version.

| Code | Condition | Repair hint |
| --- | --- | --- |
| yaml-syntax / yaml-duplicate-key | Invalid YAML or repeated key | Correct the indicated YAML location |
| studio-schema | Unknown field, wrong type, invalid icon or locale title | Correct the field against its expected schema |
| studio-land-missing | Studio body has no `## Land` section | Add the heading and describe delivery |
| studio-land-empty | The section has no instructions | Describe delivery, checks and what to record |
| studio-land-duplicate | Studio body has multiple `## Land` headings | Combine instructions under one heading |
| studio-work-missing / studio-work-empty / studio-work-duplicate | Missing, empty or repeated `## Work` | Describe the workflow under one heading |
| studio-previews-missing / studio-previews-duplicate | Missing or repeated `## Previews` | Keep one heading even when there are no Preview blocks |
| preview-section | Preview block is outside `## Previews` | Move the block under the heading |
| preview-tag | Malformed, nested, self-closing or extra-attribute tag | Use one non-nested Preview block with only id |
| preview-unclosed | An opening tag has no closing tag | Add `</Preview>` after this block |
| preview-unexpected-close | A closing tag has no opening tag | Remove it or restore its opening tag |
| preview-id / preview-empty | Invalid/repeated ID or blank body | Use a unique stable ID and describe the output |
| preview-metadata-missing | Body ID is absent from YAML | Add the same ID under previews, using `{}` if needed |
| preview-body-missing | YAML ID has no body block | Add its block or remove unused metadata |
| studio-reference | Missing or unsafe linked resource or unknown Guide | Correct the indicated reference |

For example, a block opened on line 16 without its closing tag reports:

```json
{"file":"STUDIO.md","line":16,"column":1,"path":"previews.prompts","code":"preview-unclosed","message":"Preview prompts is not closed","hint":"Add </Preview> after this block."}
```

Report the unclosed block before producing ID mismatch errors derived from that malformed
block. Independent errors can be returned together, in source order. Revalidation recomputes
the complete file; it does not treat a prior failed draft as valid or silently rename IDs.

## CLI

The examples use a folder `./release-notes` containing the `STUDIO.md` above.
`--json` retains the standard CLI envelope; the fields below describe its action result.
No command below starts an Agent or creates an approval.

### `akb studio validate <folder> --json`

Validates the complete folder and returns `{folder, problems: [], fingerprint}`. The
fingerprint covers skill files and resources. A draft with skills also returns `skillContext`,
the runtime Markdown catalog with paths in that draft for a trial.
Invalid definitions exit nonzero with `studio-problems`, including each file, field path, source line and reason.
For example, `STUDIO.md:16:1 previews.prompts: preview-unclosed — add </Preview>`. An unreadable folder is `bad-args`.

```sh
akb studio validate ./release-notes --json
```

### `akb studio create <folder> --request-id <id> [--workspace <id>]`

Publishes the complete folder to the existing workspace scope. Returns
`{id, version, changed: true, requestId}` and writes `version.json`.
Malformed files return `bad-studio`; missing request IDs return `bad-args`.
Retries with the same request and payload return the original version. Reusing the ID
for different content fails rather than creating a second version.

```sh
akb studio create ./release-notes --request-id release-notes-1
```

### `akb studio pull <id> [folder]`

Writes the frozen current files plus `{id, version}` in `version.json` to an empty folder;
returns `{id, version, folder}`. Nonempty destinations return `bad-args` and inaccessible
Studios retain the existing access error. The complete catalog, Preview metadata and resources survive a round trip.

```sh
akb studio pull wf-example ./release-notes-edit
```

### `akb studio clone <id> <folder> [--name <name>] [--json]`

Copies the latest definition and reusable files of a Studio from `akb studio list` to a
new or empty local folder. Omitting `--name` adds a copy suffix to the source names.
The draft includes README, ABOUT and package screenshots. It excludes the source's `version.json`. Studios with
MCP servers cannot be cloned. Skills and their resources are copied. The draft is validated before writing.

The successful JSON response includes `{ok, source, sourceVersion, folder}`, where
`source` is the listed ID and `folder` is the absolute destination. Review as a new Studio
with `--base empty` and use `akb studio create` after approval.

```sh
akb studio clone blog-post ./technical-articles --name "Technical articles" --json
```

### `akb studio push <folder> --request-id <id>`

Replaces the complete definition against `version.json`. Returns
`{id, version, changed: true, requestId}`. Existing unchanged and `--dry-run` behavior stays.
An invalid definition returns `bad-studio`; a missing baseline is `bad-args`, an official
Studio is `studio-read-only`, and a moved baseline is `studio-moved`. On conflict, pull into
a fresh folder, reconcile the files and review the result before publishing again.

```sh
akb studio push ./release-notes-edit --request-id release-notes-2
```

### `akb studio list --json`

Each entry includes `previews: [{id, instructions, title?, description?, icon?}]` joined from Preview blocks and the YAML display map, or `[]`.
`instructions` is the short section body; linked references are not expanded.
It has no format discriminator, `agent`, `after`, `land` or memory entries.

```sh
akb studio list --json
```

### `akb studio skills <studio> [--json]`

Lists skill names and descriptions. JSON returns `{skills: [{name, description}]}`.
A Studio with no skills returns an empty list. Within an execution, the task's Studio
uses the saved snapshot. Outside an execution, the command reads the current version.

### `akb studio file <studio> <path> [--json]`

Reads a Studio text file, including `skills/<name>/<path>`, using the same version
selection as studio skills. JSON returns `{studio, file, text}`. An unknown path returns
no-such-studio-file.

### `akb components [component...]`

Run without arguments for a compact list of built-in Preview Components, supported
Asset formats, preview requirements, and download availability. Pass component names
to print their usage in the requested order, for example `akb components Set Storyboard`.
An unknown name returns `unknown-component`.

### `akb raw components --studio <id> [--docs] --json`

Returns all supported components in existing registry order, with their usage when
`--docs` is present: `{components: string[], docs?}`. Every Studio gets the same vocabulary;
no Preview declaration or filter is read. `--preview` is not supported and returns
`bad-args`; an unknown Studio retains `unknown-studio`. This does not start work.

```sh
akb raw components --studio coding --docs --json
```

## HTTP

Use the existing bearer credential, workspace access rules and response envelope.
Application Preview entries are `{id, instructions, title?, description?, icon?}`, joined by ID from `STUDIO.md`;
`title` and `description` are locale maps. Model prompts receive only `{id, instructions}`. There is no `format` discriminator
or alternate role-based response.

### `GET /v1/studios?workspace=<id>`

Returns the existing paginated `{data, next, catalogVersion}`. Each entry exposes its Preview catalog. For example:

```json
{"id":"wf_example","previews":[{"id":"release-notes","title":{"en":"Release notes","zh":"更新说明"},"instructions":"Write the requested release notes."}]}
```

Other existing Studio fields remain present. Existing authentication and workspace errors
still apply.

```sh
curl -H 'Authorization: Bearer <credential>' 'https://api.ai4kanban.dev/v1/studios'
```

### `GET /v1/studios/{id}`

Returns existing Studio metadata, `version`, complete `files`, and the same
`previews` as the list. `diagram` is `null`, because there is no Agent graph.
`files` includes the existing generated `version.json`. Inaccessible IDs retain `not_found`.

```sh
curl -H 'Authorization: Bearer <credential>' 'https://api.ai4kanban.dev/v1/studios/wf_example'
```

### `GET /v1/tasks/{id}/studio`

Returns the task's Studio, including the current or requested version and complete
files with any skill tree. The Runner saves this response when starting an execution
and uses that snapshot for continued work.

### `POST /v1/studios`

Input is `{files: {<relative path>: <text>}, workspace?}`; metadata is read from
`files["STUDIO.md"]`. Return the existing Studio publication result and version, HTTP 201.
Send `Idempotency-Key` for safe retries. `studio-create.json` contains that complete input.

```sh
curl -X POST -H 'Authorization: Bearer <credential>' -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: release-notes-1' --data-binary @studio-create.json \
  'https://api.ai4kanban.dev/v1/studios'
```

### `PATCH /v1/studios/{id}`

Input is `{files, expectedVersion}` plus the existing optional workspace scope. All files
are replaced together. Return the existing publication result and new version, HTTP 200.
`studio-update.json` contains the complete files and the last read `expectedVersion`.

```sh
curl -X PATCH -H 'Authorization: Bearer <credential>' -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: release-notes-2' --data-binary @studio-update.json \
  'https://api.ai4kanban.dev/v1/studios/wf_example'
```

Both writes retain `bad_request` for malformed definitions, invalid paths or missing
fields, `payload_too_large` for existing limits, `version_conflict` for moved baselines,
and `operation_reused` for a key naming another payload. Existing authentication,
authorization, read-only and quota rules still apply. Errors identify the offending
Studio file and, its field path and source line. A failed write changes no version.

## Execution boundary

Until task-specific review plans are introduced, a task uses the existing single
task review: instructions and requested drafts are reviewed together, then the ordinary
task context completes the approved work. It uses no Preview Agent, role session or
per-Preview stage state. No-preview tasks still reach that review; absent `land` does not
mean automatic completion. Delivery completion keeps the existing commit/branch evidence
for software tasks. Draft edits invalidate the affected current task review through the
existing revision checks; approval remains a user action.

The saved task, current execution ownership, discussion, files and approved requirements
are the continuation source. Independent memory is neither injected nor automatically
updated. A stopped or outdated execution cannot submit; a missing session requires an
explicit takeover rather than an automatic replacement session.

## Marketplace files

The built-in Carousel Post Studio (`wf_builtin_carousel_post`) is omitted from
`GET /v1/marketplace/studios` and `GET /v1/studios`. Its detail URLs, marketplace
install and clone requests, task creation with that ID, and start requests for
open Goals that use it return `404 not_found`.

### `POST /v1/marketplace/studios`

The existing `{slug, files, dry_run?}` input accepts the complete Studio, including its optional skill tree. It uses the
same validation, marketplace file rules, creator permission and existing publication
result. Invalid files return `bad_request` or `payload_too_large`; access errors stay as-is.

```sh
curl -X POST -H 'Authorization: Bearer <credential>' -H 'Content-Type: application/json' \
  --data-binary @marketplace-studio.json 'https://api.ai4kanban.dev/v1/marketplace/studios'
```

### `GET /v1/marketplace/studios/{id}`

The existing detail result keeps its fields; `diagram` is `null`.
It does not render the Preview catalog as an Agent graph. Inaccessible IDs retain `not_found`.

```sh
curl -H 'Authorization: Bearer <credential>' \
  'https://api.ai4kanban.dev/v1/marketplace/studios/wf_builtin_coding'
```

### `GET /v1/studios/{id}/readme?workspace={workspaceId}&lang={languageTag}`

Read the current Studio's user guide. Marketplace listings can be read before installation.
A workspace Studio must belong to the requested workspace. A root `README.md` or
`README.<locale>.md` can embed package images from `screenshots/<name>.png|jpg|jpeg|webp`.

Nonblank documents match the exact language tag case-insensitively, then the base language,
then the unsuffixed file. The same order applies to legacy ABOUT when no README matches.
The response is `{ readme: { filename, lang, markdown, images } | null }`.
`images` maps referenced package paths to bitmap data URLs. `lang` is null for an
unsuffixed document.

### `POST /v1/marketplace/studios/{id}/clone`

Copies the complete definition and resources using the existing optional
`{workspace, name}` input, permission and idempotency rules. Returns the existing new
Studio result, HTTP 201. MCP files make cloning fail with
`bad_request`, as does a source without the required sections. Missing source IDs remain
`not_found`. Cloning creates no Agent configuration.

```sh
curl -X POST -H 'Authorization: Bearer <credential>' -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: coding-copy-1' -d '{"name":"My coding studio"}' \
  'https://api.ai4kanban.dev/v1/marketplace/studios/wf_builtin_coding/clone'
```

## Existing task groups and migration

Convert existing definitions once into Preview blocks and matching YAML display maps.
Keep stable IDs and move known display icons and localized titles into the map; do not
translate or regenerate them during execution. Inline short output requirements, keep
useful selection intent as prose, and retain optional resource links without `when`,
per-Preview files or components fields. Validate every converted definition before switching.

Convert old agent sections and selections through the one-time ID mapping. Preserve all
body content, source order, Sets, asset/version references and review history. Merge sections
mapped to one ID in source order and wrap them in one closed Preview block. Unmapped historical
results retain stable task-local historical IDs and existing localized labels in card metadata,
solely for display. Normal authoring cannot create new historical IDs. Reuse the same mapping
on reruns and stop ambiguous active tasks for review; migration never starts execution.

CLI create/pull/push, HTTP read/create/update and marketplace publish/clone preserve full
STUDIO.md, display maps and linked resources in the version fingerprint. Normal reads have
no H2/icon-comment, old directory or role execution fallback. Title/icon edits retain the
same selected ID, reading position and file grouping. Existing approval consistency holds.

### Cutover history

The production cutover is complete. Current task and Studio APIs read and write the
converted data. Historical Preview IDs, task decisions and artifact versions stay
available through the usual reads. See the [deployment record](../deploy.md#single-studio-cutover-820-and-873)
for migration receipts and retirement details.

## Published packages

Studio publication accepts the existing JSON file map. The expanded ZIP may contain
up to 10 MiB in total and 2 MiB per file. Limits use UTF-8 bytes and the original
bytes of marketplace screenshots. An oversized file or package returns
`413 payload_too_large` naming the limit.

| Endpoint | Result |
| --- | --- |
| `GET /v1/studios/{id}?view=metadata` | The current version, Previews and its package reference. |
| `GET /v1/tasks/{id}/studio?view=metadata[&version={version}]` | The task's current or specified version, with current and historical Previews. Deleted Studio handling is unchanged. |
| `GET /v1/studios/{id}/versions/{version}/package` | ZIP for a readable Studio version. |
| `GET /v1/tasks/{id}/studio/versions/{version}/package` | ZIP for the task's Studio version, using task read permission. |

A package reference contains `version`, `filesSha256`, `zipSha256`, `zipBytes`
and an authenticated API-relative `downloadUrl`. Downloads return
`application/zip`, `Content-Length`, the quoted ZIP digest as `ETag` and
`Cache-Control: private, no-store`. Missing or inaccessible versions return
`404 not_found`. An unavailable registered object returns `503 service_unavailable`.
Omit `view` for the original JSON response with files.

Runners bind an execution to the version selected during preparation and validate
the ZIP and file digests before caching it. Other tasks on the machine can reuse
that version after confirming its metadata with Cloud.
