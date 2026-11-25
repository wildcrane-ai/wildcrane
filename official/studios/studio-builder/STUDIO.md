---
name: Studio builder
names:
  zh: 搭建工作台
description: Designs and publishes studios through reviewed drafts.
summaries:
  zh: 先确认工作台的设计，再保存为你的工作台。
  en: Approve the studio's design, then it's saved as yours.
entrypoints: [studio-authoring]
needsArtifact: false
icon: studio-kit
previews:
  market-research:
    icon: compare
    title:
      en: Market research
      zh: 市场调研
    description:
      en: Review the recommended scope, common workflow, and sample outputs.
      zh: 审阅建议范围、常见流程和成品示例。
  studio:
    icon: studio
    title:
      en: Studio
      zh: 工作台
    description:
      en: Review the STUDIO.md definition and real changes.
      zh: 审阅工作台定义与实际改动差异。
  files:
    icon: file
    title:
      en: Files
      zh: 附属文件
    description:
      en: Review supporting scripts, guides, and references.
      zh: 审阅配套脚本、指南与参考文件。
---

A Studio is a workbench for one kind of work: a toolbox and optional Previews (drafts or
finished results a person reviews for details and quality). A task delivers the Studio's result,
calling tools, producing Previews, and submitting a Review Plan as needed. It delivers directly
when no review is needed, and puts Previews that depend on earlier approval in later stages.

- **Card**: name the target studio or say it is new, the requested outcome, and a draft folder under this card’s assets. Give a new studio a sample request for its trial.
- **Research**: for a new Studio, recommend Market research when public evidence can inform an open choice about the audience, workflow, or outputs. In the review plan, make Studio depend on Market research when the design needs its findings, then use the approved decisions in the draft.
- For a new Studio, find relevant Studios with `akb studio list` and read their definitions and
  supporting files with `akb studio pull <id> <empty-folder>`. When a cloneable Studio covers much
  of the request, use `akb studio clone <id> <draft-folder>` and adapt the draft as a new Studio.
- **Writing**: before writing or revising studio instructions, read and follow `akb guide write-prompt`.
- **Definition**: use the `STUDIO.md` template below and link longer instructions as needed. Define Previews only for outputs needing human judgment—each with a stable ID, `en`/`zh` YAML title and description, and a short block naming the output, review checks, and components.
- **Preview display**: use `akb components` to choose components and formats, including download-only attachments. Use `akb components Set Storyboard` for usage. If `akb components` is unavailable, run `akb raw components --studio studio-builder --docs`.
- **Setup**: add `## Setup` only for real prerequisites or saved preferences. Say when to ask for a required choice, what optional settings default to, and where to check and configure any local credentials.
- **Planning**: add `## Planning` only when tasks need splitting or review guidance (omit for simple Studios); never stuff many deliverables or Previews into one card:
  ```text
  ├─ Multi-deliverable / parallelizable ─▶ Group Task: Pilot ─(blocked_by)─▶ Subtasks in parallel
  └─ Single coupled deliverable         ─▶ One card (deliver directly, or Review Plan: A -> B + C)
  ```
- **Existing studio**: start with `akb studio pull <id> <empty-folder>`, keep an unchanged baseline, and edit a copy in the draft folder, preserving supporting files unless the requested change affects them.
- **Stale base**: pull a fresh version into an empty folder, merge both sets of changes, and update the draft and review together; ask only about semantic conflicts you cannot resolve.
- **Icons**: follow references/icons.md for the Studio and optional Preview icons.
- **Tools** Use scripts for standalone operations. Bundle reusable instructions and their resources as [Agent Skills](https://agentskills.io/specification) under `skills/`.
- **Imports** Copy the skill and its resources at a fixed revision, and record the source URL and revision in its metadata.
- **Memory**: leave memory out by default; when confirmed rules or preferences improve future work, follow [memory rules](references/memory.md).

## Studio template

Replace the example metadata and instructions. Omit unused Setup, Planning, and Preview sections and metadata.

```markdown
---
name: Studio name
description: What this Studio delivers
previews:
  draft:
    title:
      en: Draft
      zh: 草稿
    description:
      en: Draft for review
      zh: 待审阅的草稿
---

## Setup

Describe required choices, optional defaults, and any local credential checks.

## Planning

Omit for simple Studios. Split independent deliverables into a Group Task (pilot first, `blocked_by` to parallel subtasks), or keep one coupled deliverable on one card—deliver directly or use a Review Plan (`+` parallel, `->` after approval).

## Work

Describe the workflow, available tools, and when to use each.

## Land

State the final result and checks. Deliver final files to the requested destination or a
subdirectory of the folder bound to the project by default; record their paths.

## Previews

<Preview id="draft">
Show the draft as an Asset; state what details and quality the reviewer should check.
</Preview>
```

## Check it

Run `akb studio validate <folder> --json`, fix each located diagnostic, and rerun before continuing; keep the source and publishing baseline unchanged by validation.

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

Save the approved Studio files to the requested destination or a subdirectory of the folder
bound to the project by default. Record the delivered path.

Publish the approved draft using the [publication procedure](shared/PUBLISH.md). Confirm the save
and record the Studio ID, saved version and request ID before completing delivery.

## Previews

<Preview id="market-research">

Use public sources to study the intended audience, how this work is done, and how existing tools present results. Recommend what to support first and why, and outline the common workflow.

Show a short Markdown brief with linked evidence, assumptions, and choices for the user to confirm. Use the same sample request to show each recommended output's content, format, and presentation.

</Preview>

<Preview id="studio">

Run `akb studio preview <card> --folder <draft> --base <baseline>` (or `--base empty` for a new Studio). Show its `<Studio>` tag and any trial results using their recommended components.

</Preview>

<Preview id="files">

Show the command’s attachment tags for all file changes in the Studio folder. Omit this Preview when none are listed.

</Preview>
