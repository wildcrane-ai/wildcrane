---
name: Studio builder
names:
  zh: 搭建工作台
description: Designs and publishes studios through reviewed drafts.
needsArtifact: false
icon: studio-kit
previews:
  studio:
    icon: studio
    title:
      en: Studio
      zh: 工作台
  files:
    icon: file
    title:
      en: Files
      zh: 附属文件
---

Plan the requested Studio change and deliver the approved files.

- **Card**: name the target studio or say it is new, the requested outcome, and a draft folder under this card’s assets. Give a new studio a sample request for its trial.
- **Writing**: before writing or revising studio instructions, read and follow `akb guide write-prompt`.
- **Definition**: use the `STUDIO.md` template below and link to longer instructions as needed. Give each Preview a stable ID, a short block describing the output and recommended components, and matching English and Chinese titles and descriptions in YAML.
- **Existing studio**: start with `akb studio pull <id> <empty-folder>`, keep an unchanged baseline, and edit a copy in the draft folder, preserving supporting files unless the requested change affects them.
- **Stale base**: pull a fresh version into an empty folder, merge both sets of changes, and update the draft and review together; ask only about semantic conflicts you cannot resolve.
- **Icons**: follow references/icons.md for the Studio and optional Preview icons.
- **Outside skills**: package external skills at a pinned commit as `vendor/<repo>.zip.b64` under references/, under 2 MB; have it unpack once into `~/.wildcrane/cache/vendor/<repo>-<commit>/`.
- **Memory**: leave memory out by default; include a short optional note or index in a Preview’s example format only when distilled user preferences or habits improve the work, never for common knowledge, general techniques or old model limitations.
- **Memory reading**: have the Studio read relevant declared memory on demand, without injecting full memory or creating a dedicated Agent; current requests and present facts take precedence.
- **Memory updates**: have the Studio retain only explicitly confirmed long-term preferences, habits and corrections; do not turn one-off edits into lasting rules.
- **Source**: attach the reviewed draft as one ZIP Asset, preserving `version.json`.

## Studio template

Replace the example metadata and instructions. Omit the YAML `previews` map and `## Previews` when the Studio defines no Previews.

```markdown
---
name: Studio name
description: What this Studio does
previews:
  draft:
    title:
      en: Draft
      zh: 草稿
    description:
      en: Draft for review
      zh: 待审阅的草稿
---

## Work

Describe how to do the requested work.

## Land

State what to deliver, where it goes, and what to check and record before completion.

## Previews

<Preview id="draft">
Show the draft as an Asset.
</Preview>
```

An optional preference note inside an output example:

```markdown
<Preview id="draft">
Show the draft with `<Asset>`.
Optional preferences: read relevant saved tone preferences when useful; current instructions take precedence. Retain only explicitly confirmed lasting preferences, not one-off edits.
</Preview>
```

## Check it

Run `akb raw studio validate <folder> --json`, fix each located diagnostic, and rerun before continuing; keep the source and publishing baseline unchanged by validation.

## Try it

Try only new studios.

- **Sample**: use the card's sample request, or write a typical one and mark it as made up.
- **Run**: after validation, follow the draft's work instructions and prepare only outputs needed by the sample request; save each result to `<board-state>/assets/<card id>/trial/<preview-id>.md` with its assets beside it.
- **Approvals**: stop where the sample needs user confirmation; do not assume approval.
- **Isolation**: create no cards and write no memory; use and note recommended answers instead of asking questions.
- **Rerun**: after changes, rerun only affected outputs.

## Feedback

Separate feedback on preview form from sample content.

- **Form**: fix the Studio’s generic instructions, then rerun a new studio's trial or update an existing studio's review.
- **Content**: change sample facts and wording only in the sample or trial result.
- **Lessons**: record each form correction under the card's `### Overruled by the user` as an authoring mistake and a better rule that applies across studios.

## Land

Publish the approved draft using the [publication procedure](shared/PUBLISH.md). Confirm the save
and record the Studio ID, saved version and request ID before completing delivery.

## Previews

<Preview id="studio">

Run `akb raw studio preview <card> --folder <draft> --base <baseline>` (or `--base empty` for a new Studio). Show its `<Studio>` tag and any trial results using their recommended components.

</Preview>

<Preview id="files">

Show the command’s attachment tags for added, changed or deleted files in references/, shared/, scripts/ and CARD.md. Omit this Preview when none changed.

</Preview>
