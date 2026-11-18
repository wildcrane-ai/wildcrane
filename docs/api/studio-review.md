# Studio file reviews

```sh
akb raw studio preview 819 --folder ./draft --base ./baseline
```

- **Inputs**: a card, complete draft and unchanged baseline. Existing Studios need matching `{id, version}` in both `version.json` files; new Studios use `--base empty` without a version file.
- **Output**: frozen files and real unified diffs under `.assets/<card>/studio-review/`. The command prints a `<Studio>` tag plus attachment tags; JSON output includes `file` (absolute snapshot path), `tag` and `files` (attachment Markdown).
- **Review**: put `tag` in the studio Preview and nonempty `files` in the files Preview. Attachments pair full source with its diff under one label; three or more changed files use `<Set>`. Deleted files retain their diff.
- **Trials**: use ordinary Preview Components in the studio Preview. No result manifest or Agent assignment is required.
- **Failure**: invalid definitions report `studio-problems`; missing cards report `no-such-card`; invalid baselines or files report `bad-args`. Failed generation preserves the last snapshot.

The task's ordinary Preview tabs switch between Studio and Files. One Preview displays directly.
The Studio viewer shows STUDIO.md, with the complete source available beside its diff.
Creation, feedback, approval and completion use the existing task flow.

## Frozen source

```html
<Studio src=".assets/819/studio-review/review.json" />
```

The existing version 2 snapshot holds publication evidence, not a tab or role configuration:

```json
{
  "version": 2,
  "base": {"id": "wf_example", "version": 3, "fingerprint": "<baseline fingerprint>"},
  "fingerprint": "<draft fingerprint>",
  "files": [{
    "path": "STUDIO.md",
    "before": "files/0/before.txt",
    "after": "files/0/after.txt",
    "diff": "files/0/change.diff"
  }]
}
```

- **Baseline**: `base` is null for a new Studio; otherwise it pins the published ID, version and validation fingerprint.
- **Fingerprint**: matches `akb raw studio validate`, including the complete draft and its version file. Publication must match the approved snapshot.
- **Files**: the union of baseline and draft paths except version.json, including unchanged files. Paths are unique safe relative paths. A missing side is null; at least one side exists. Changed files have a diff, using `/dev/null` for additions and deletions.
- **Source text**: frozen `.txt` files preserve the exact validated source; embedded Preview tags remain text.
- **History**: old version 2 snapshots with `agents` and `results` remain readable, including their result dependencies. Files and results display without Agent tabs. Legacy `rounds / land / scheduled` diagrams remain readable. New snapshots omit both old fields; `--results` is retired.

## Resources and publishing

All file sides and diffs are declared references, relative to their snapshot. Task resource
collection and synchronization pin them using existing permissions and error handling.
Missing or failed resources identify the affected path without hiding valid files. Unknown
versions and invalid snapshots fail visibly. Readers never substitute a newer source.

Publish through the existing create/push commands after approval. Preserve the pulled version
and request ID; reuse the same request ID and payload after a timeout. A stale base requires
pulling the current version and merging both sets of changes, updating the review together.
Ask only about unresolved semantic conflicts. A failed or unverified save leaves the task
unfinished; a successful save follows ordinary task completion.
