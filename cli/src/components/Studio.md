# Studio

Show a studio's diagram or file review with `<Studio src=".assets/<card id>/studio.json" label="..." />` alone in a paragraph. Inline and fenced examples remain text.

- **Diagram**: `akb raw studio diagram <studio id> <card id>` writes the diagram and prints its tag.
- **File review**: `akb raw studio preview <card id> --folder <draft> --base <baseline> [--results <manifest>]` freezes real files, differences and supplied results. Use `--base empty` only for a new Studio.
- **Data**: use the generated JSON; rerun after changing inputs. Files precede supplied results; unavailable resources show their reason. See [the contract](https://github.com/wildcrane-ai/wildcrane/blob/main/docs/api/studio-review.md).
