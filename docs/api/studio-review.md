# Studio file reviews

## Generate a review

Requires akb 0.11.56+ and Runner 0.6.70+ for synchronization. Runner 0.6.70 initially ships on Alpha.

```sh
akb raw studio preview 733 --folder ./draft --base ./baseline --results ./results.json
```

- **Inputs**: an existing card, a complete draft folder and an unchanged baseline folder.
  An existing Studio requires matching `{id, version}` in both folders' `version.json`.
  A new Studio uses `--base empty`; its draft must have no `version.json`.
- **Results**: optional JSON array using the result entries below. Its paths are relative
  to the manifest. Omission means no supplied results. Only named files are read.
- **Output**: `.assets/<card>/studio-review/review.json` and frozen copies of its complete
  file and result dependencies. The command prints the `<Studio>` tag; `--json` adds
  `file` (absolute JSON path) and `tag` to the standard CLI response.
- **Failure**: nonzero exit with the input path and reason. Failed generation leaves
  the previous review intact. Studio file and task asset limits continue to apply.

| Failure | CLI error kind |
| --- | --- |
| Card does not exist | `no-such-card` |
| Missing baseline, mismatched versions or invalid result manifest | `bad-args` |
| Invalid Studio files or Agent metadata | `studio-problems` |
| Missing, unreadable, escaping, oversized or cyclic file dependency | `bad-args` |

The command copies inputs and generates unified diffs. It makes no Agent run or
publication request. `version.json` identifies the source; it is not a reviewed file.

## Read a review

```html
<Studio src=".assets/733/studio-review/review.json" label="Coding" />
```

`version: 2` selects file review. Legacy `rounds / land / scheduled` JSON keeps its
diagram behavior. Unknown versions fail visibly; they do not fall back to a diagram.
All top-level fields are required; arrays may be empty.

```json
{
  "version": 2,
  "base": {"id": "wf_builtin_coding", "version": 23, "fingerprint": "<baseline fingerprint>"},
  "fingerprint": "<draft fingerprint>",
  "agents": [{"agent": "ui-designer", "title": {"en": "UI design", "zh": "界面设计"}}],
  "files": [{
    "path": "agents/ui-designer/AGENT.md",
    "before": "files/ui-designer/before.txt",
    "after": "files/ui-designer/after.txt",
    "diff": "files/ui-designer/change.diff"
  }],
  "results": [{"agent": "ui-designer", "component": "Asset", "src": "results/page.html", "label": "Draft"}]
}
```

- **`base`**: the baseline's Studio ID, published version and validation fingerprint;
  `null` means the explicitly empty baseline of a new Studio.
- **`fingerprint`**: the draft fingerprint returned by `akb raw studio validate`.
  Fingerprints identify frozen inputs; reading never fetches a newer Studio version.
- **`agents`**: unique Agent IDs and their existing `title: {en, zh?}` and optional `icon`
  metadata, in Studio order. Use draft metadata, or baseline metadata for removed Agents.
- **`files`**: the union of baseline and draft paths. Each unique `path` is relative to
  the Studio root, with `/` separators and no absolute, `.` or `..` segments.
  `before` and `after` name frozen file texts; `null` means that side does not exist.
  At least one side must exist. `diff` names the generated unified diff for changed files;
  it is absent only when the texts match. New and deleted sides use `/dev/null` in the diff.
- **`results`**: ordered existing previews, each with a target `agent`, a `component`
  and that component's existing attributes. The Agent must exist in the draft or baseline.
  An empty array supplies no results.

File texts preserve the Studio file representation used by validation. Store source
snapshots as `.txt` so instructions and embedded tags remain source text.
`agents/<id>/…` belongs to that Agent. Other paths belong to the Studio.
Show Agent entries with changed files or supplied results, keeping their unchanged files
available as full text. Show common files only when changed. Derive entries from these
files and metadata; the JSON stores no tab tree.

## Result entries

`--results` accepts the same array stored in `results`. Relative paths are copied and
rewritten into the review snapshot. Keep the existing component rules:

| `component` | Existing attributes |
| --- | --- |
| `Asset` | `src`, optional `label`, `alt`, `device`, `loop`, `variants` |
| `Set` | `label`, `items`: Asset attribute objects, with the existing Set grouping rules |
| `Compare` | `a`, `b`, optional `shots`, `label`, `a-label`, `b-label` |
| `Storyboard` | `src`, optional `label` |

Strings keep their tag values. `loop` is a boolean; `variants` is an object mapping
labels to resource references. `Set.items` contains only Asset attributes.

For example, `results.json` can contain:

```json
[{"agent":"ui-designer","component":"Asset","src":"./page.html","label":"Draft"}]
```

Render results after that Agent's files through the existing viewers and actions.
No result entry means no result preview. These entries grant no execution or approval.

## Resolve files and failures

Every file side, diff and result source is a declared resource reference. Result references
include variants, Set items, Compare sides and shots, and their transitive dependencies.
References in generated JSON are relative to that JSON. Display-only `path` is not a reference.

Use the existing task resource collection, upload, rewrite and pull flow. Readers accept artifact IDs only from the current task's resource manifest. Generation accepts local files only. To reuse another task's result,
explicitly copy the authorized files and their dependencies into this task first.
Remote URLs, absolute paths and links escaping the allowed roots are refused.

The task's resource manifest pins each artifact version. It also records upload failures;
the Studio JSON adds no version pins or access tokens. Reopening, sharing or pulling a
review uses those same pins, permissions and expiry rules, even after local inputs are removed.

Invalid JSON or review structure prevents the review from rendering. A missing, corrupt,
oversized, cyclic or failed resource identifies the affected path and reason; keep valid
entries available. Stop a cyclic branch without nesting it. Never display a retained old
version as this attempt's result. A failed root upload shows a review error.

```mermaid
sequenceDiagram
    participant Agent
    participant CLI
    participant Runner
    participant Cloud
    participant Review
    Agent->>CLI: raw studio preview (draft, baseline, results)
    CLI-->>Agent: Frozen files and Studio tag, or input error
    Runner->>Cloud: Upload declared dependencies, then review JSON
    Runner->>Cloud: Sync task resource pins and errors
    Review->>Cloud: Read task or shared review with existing access
    Cloud-->>Review: Allowed pinned versions, or existing access error
    Review-->>Review: Files, then results; report failed references
```
