---
name: Product video
names:
  zh: 产品视频
description: Plan, make or revise product videos and their requested supporting assets.
summaries:
  zh: 先确认脚本，再渲染成片。
  en: Approve the script, then the video renders.
needsArtifact: true
icon: product-video
previews:
  video-script:
    icon: script
    title:
      en: Script
      zh: 脚本
    description:
      en: Approve narration, pacing, and scene outline.
      zh: 确认旁白文案、节奏与场景大纲。
  demo-shots:
    icon: shots
    title:
      en: Demo shots
      zh: 演示截图
    description:
      en: Review captured product screens and clips.
      zh: 审阅录制或截取的产品画面。
  storyboard:
    icon: shots
    title: {en: Storyboard, zh: 分镜}
    description: {en: "Review shot-by-shot visuals, timing, and transitions.", zh: "逐镜审阅画面构图、时长与转场。"}
  cover:
    icon: image
    title: {en: Cover, zh: 封面}
    description: {en: "Review the video thumbnail or cover frame.", zh: "审阅视频封面图。"}
  video:
    icon: video
    title:
      en: Video
      zh: 成片
    description:
      en: Watch the rendered video before delivery.
      zh: 审阅渲染完成的最终视频。
---

Make or revise only the requested product-video outputs. Reuse existing work and change only affected shots, narration or assets; the catalog below is optional, not a checklist. A script-only request does not call for voice samples, a video or a cover. HyperFrames is the default production framework; read its installed skill when creating or editing a composition, and load other skills only as needed.

- **Approval**: set the review points the request needs, normally approving script and storyboard before making and showing a new video. Use the Task's saved review plan; Preview IDs describe outputs, not stages. Await the required script and storyboard approvals before downstream paid generation or final production.
- **Review references**: use this definition's Preview IDs in the saved review plan. When switching an existing Task to this definition, use the existing plan-revision flow for affected references and approvals; do not transfer old approvals to renamed outputs. Preserve pinned versions and historical outputs.
- **Resume**: continue from saved outputs and current authorization. An answer or an old approval does not approve changed content; leave affected downstream production waiting for the system to unlock it.
- **Resources**: read linked references only when needed. Reuse task assets and explicit project or Studio rules; do not read or maintain independent role memories or replace Studio examples automatically.

## Land

For a video delivery, watch and check the rendered MP4. Put its absolute path in code format on
its own line below the card's opening paragraph, with one playable Asset beneath it. Update both
in place and record the re-render command once the playable file passes its checks.

## Previews

<Preview id="video-script">

Write the requested video script and narration.

## Deciding

- **Evidence first**: independently verify key assumptions and give creative choices justified defaults.
- **Ask little**: ask only for decisions or access the user owns.

## The script

Inside this Preview, write a `###` script subsection in the board's language. Use `####` or lower for any heading inside it.

- **Brief**: audience, one core claim, device, aspect ratio, resolution, target length or range, required content, visual direction, subtitle style and audio intent.
- **Narrative**: write the video as continuous sections in viewing order, each saying what the viewer sees and how it hands over to the next. Number shots `S<n>` only where a section needs them.
- **Words**: give exact conversational, courteous narration and on-screen text with the voice source; mark unvoiced sections explicitly. Missing narration never means silence.
- **Voice**: when narration production is requested, for TTS pick voices from the narration language's group in `references/scriptwriter/references/voices.md`. Use the voice the user describes; otherwise attach samples of one scripted line for two or three fitting voices as `<Asset>`s labeled by name, generated with `--tier standard`, ask one single-choice question to pick one, and end the run. Put the chosen name in the voice source.
- **No hosted voice**: when Cloud refuses hosted voices, sample the local Kokoro voices `af_heart` and `zf_xiaobei` instead and say so in your section.
- **Facts**: list the product claims the video makes and how each was verified; mark unverified ones.
- **Direction**: specify only what affects the story. Recipes in `references/scriptwriter/references/index.md` are optional references, never a requirement.

## Demo

A video includes a demo when any section depends on real product output, such as measured results or real interface operation, when the user asks for one, or when real operation shows the claim more convincingly than screenshots, animation or text. Use the demo-shots output when rehearsal is needed.

- **Demo sections**: state the claim each demo section must prove and what the viewer sees there.

</Preview>

<Preview id="storyboard">

Turn the current script into ordered shots when requested or required by the saved review plan, after any required script approval. Keep exact narration and captions, stable shot IDs and continuous timing; use supplied assets or inexpensive local frames for review.

- **Contract**: follow `references/scriptwriter/references/storyboard-contract.md`, its adjacent schema and example. Save `storyboard.json` in the same-card asset folder and run `references/scriptwriter/scripts/validate-storyboard.mjs`; repair all diagnostics before presenting it as ready for review.
- **Display**: show a `<Storyboard src="asset:storyboard.json" label="..." />` in this output. Structural validity does not prove production quality.
- **Revisions**: update affected shots and preserve unrelated IDs, frames and assets; required reapproval precedes their downstream production.

</Preview>

<Preview id="demo-shots">

Rehearse the demo the card asks for: the claims about real product behavior the video must prove, split into sections you choose. Choose each section's starting state yourself. Report what the product actually does; never stage a result to match the claim.

## Rehearsal

- **Setup**: prefer an isolated demo environment and prepare it without asking; ask permission only before changing the user's real projects.
- **Readability**: keep on-screen content readable at the intended viewing size.
- **Staging**: prepare each section's starting state independently for editing into a sequence.
- **Rehearsal**: reproduce each section from its starting state rather than rerunning the entire workflow.
- **Blocked**: ask for access or facts only the user has with `akb guide update-questions`, and stop.
- **Existing cards**: reuse the environment, `demo.md` and shots; rehearse and shoot only sections that lack a shot or whose product behavior or requested claim changed.

## Paths

- **Procedure**: `demo.md` in the task's Asset folder records the environment, setup, steps and reset instructions per section, and the observed results.
- **Key shots**: 3–6 screenshots in total beside it, named `demo-<section>.png` or `.jpg`, each showing the moment that proves its section's claim, legible at card width.
- **Private data**: keep secrets, personal data and private paths out of shots.
- **Report**: in your section, per requested section: one line on whether rehearsal proves the claim and the observed result, followed by its shots as `<Asset src="asset:<file>" label="..." />` lines; with three or more shots in total, put them in one `<Set>`, each labelled with its section and unique, and list the section lines below it.

## Rules

- **Done**: every requested section is rehearsed or waits on an open question, and `demo.md` and the shots match the current request.

</Preview>

<Preview id="video">

Produce the video the approved script in Preview `video-script` describes, following the storyboard and `demo.md` when present, with approvals as required by the saved review plan. Choose the production method, tools and file structure yourself; HyperFrames is the default.

## Paths

- **Assets**: use the task's Asset folder.
- **Video**: `<short-name>.mp4` in the same folder, `<short-name>` a lowercase slug of the card title.

## Media

Use the first available source for each file:

1. **Asset folder**: reuse a suitable file.
2. **Repository**: copy an existing asset.
3. **Create**: capture the running product with existing tools, or generate sound.
4. **Human**: name what you cannot prepare, including an outside asset without an open license, in one question and stop.

- **Recorder**: obtain your bundled `references/hyperframes-editor/record.mjs` with `akb studio file hyperframes-video references/hyperframes-editor/record.mjs` and keep it in the project. Write only task configuration and per-shot reset, actions and completion conditions; reuse them for retakes.
- **Capture**: follow the demo procedure; restore and verify the starting state before every take and preserve unrelated work. A result that differs from the script's expected result is a question, never a silent change.
- **Narration**: generate it from the exact scripted lines with the approved voice: `akb tts --tier premium` for a hosted voice unless the user asks for cheaper, local Kokoro for a Kokoro ID, `af_heart` / `zf_xiaobei` when the source names none; name the tier in your section. Never switch voice, tier or service silently; regenerate only narration whose text or voice changed. For a human voice, reuse the supplied recording or ask for it.
- **Checks**: assets you make or generate and repository assets are trusted; use an outside asset only under an open license, checked for quality and match with the script. Remove secrets, personal data and private paths.

## Templates

- **Named video template**: when the card names a catalog video template, `akb template get` it and build the whole video on it, replacing its content with the approved script's.
- **Props and motions**: otherwise, use a prop or motion where the card names one; for any other shot, build it yourself or, when a catalog piece may save work, look for one as `references/hyperframes-editor/template-selection.md` says.

## Build

- **Pinned**: keep every tool the video uses as a project dependency with a lockfile. Name an unavailable system dependency in one question and stop.
- **Real product**: show real product interfaces; never fabricate one.
- **Previews**: preview as you need; they need no user approval.
- **Words stand**: keep the scripted narration and on-screen text; fit timing and sound around them, with narration clear over music and in sync.
- **Render locally**: keep a project command that re-renders the same video from a clean checkout plus the asset folder. Do not use hosted rendering. Report a failed render without claiming delivery.
- **Review**: watch the rendered film and listen to its audio; check factual claims, readability, pacing, section flow, complete interactions, sound and private data. Fix defects, re-render and recheck; report checks you could not run.

## Rules

- **No code bar**: tests, diff size and code review do not apply.

</Preview>

<Preview id="cover">

Make a cover only when requested, using the method recorded in the Brief. If it is missing, ask whether to compose existing material or generate an image, recommending the suitable method. Reuse the existing cover source for revisions.

## Methods

- **Layout**: compose existing material — product screenshots, frames from the film, interface elements — and render it locally. Choose the material, composition and tools yourself.
- **Generated**: create the image with `akb image --aspect <ratio> --tier premium [--ref <file>]… --out <file> "<prompt>"`, which charges the WildCrane API rate for each delivered image; pass a lower tier only when the user asks for cheaper, and name the tier in your section. Pass the video's aspect ratio and, whenever the product appears, up to three real screenshots or frames as references. Regenerate only for a defect review finds, at most three times per run.
- **No credits**: when Cloud refuses for the plan or for used-up credits, use layout and say so in your section.
- **Failure**: when the command fails otherwise, put its message in one question offering to retry or switch to layout, and stop; once answered, record the chosen method in the Brief.
- **No silent switch**: apart from no credits, when the named method cannot deliver, ask the user; never use the other method unasked.

## Design

- **Thumbnail first**: the subject is recognizable and the text legible at thumbnail size.
- **Few words**: one short, compelling line; it need not repeat the video title, which platforms already show.
- **High contrast**: text and subject stand out clearly from the background.
- **Clear of overlays**: keep subject and text away from areas platforms cover, such as the duration badge and play button.
- **Match the video**: use the video's aspect ratio and resolution.
- **Real product**: never fabricate an interface.

## Paths

- **Assets**: use the same Asset folder as the video.
- **Cover**: `cover.png` there, with the source that renders it kept beside it; for a generated cover, the model and prompt.
- **Show it**: put one `<Asset src="asset:cover.png" label="..." />` below the film's `<Asset>`, or below the opening paragraph when there is none, updating it in place.

## Rules

- **Review**: view the cover at full and thumbnail size; fix defects and recheck.
- **Done**: `cover.png` exists, passes review and is shown on the card.

</Preview>
