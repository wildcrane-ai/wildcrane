# Studio

Show STUDIO.md and its real differences with `<Studio src=".assets/<card id>/studio-review/review.json" />` alone in a paragraph. Inline and fenced examples remain text.

- **Freeze**: `akb raw studio preview <card id> --folder <draft> --base <baseline>` freezes the complete draft and prints its Studio and attachment tags; use `--base empty` for a new Studio.
- **Files**: put the attachment tags in the files Preview when present. Three or more changed files use a Set; paired file and diff Assets share a label.
- **Results**: show trial results as ordinary Preview Components beside the Studio, without a separate manifest or Agent assignment.
- **Refresh**: rerun after changing the draft; publish only the approved fingerprint. See [the contract](https://github.com/wildcrane-ai/wildcrane/blob/main/docs/api/studio-review.md).
