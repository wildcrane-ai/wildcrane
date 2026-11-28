---
name: Video clone
names:
  zh: 视频克隆
description: Breaks down reference videos and makes reusable clones with your content.
summaries:
  zh: 先拆解参考视频，再仿制并存成模板。
  en: Break down a reference video, then clone it.
needsArtifact: true
icon: video-clone
previews:
  clone-storyboard:
    icon: storyboard
    title:
      en: Clone storyboard
      zh: 复刻分镜
    description:
      en: Compare the source breakdown against your new storyboard.
      zh: 将原片拆解与你的新分镜逐镜对照审阅。
  video-template:
    icon: template
    title:
      en: Video template
      zh: 视频模板
    description:
      en: Review the rendered clone and reusable template.
      zh: 审阅仿制视频成片与可复用模板。
---

## Planning

- **Review**: propose checkpoints suited to this request, normally reviewing the breakdown and clone draft before template production; follow the task’s saved review plan, referencing `clone-storyboard` and `video-template` as outputs rather than stages.

## Work

- **Request**: make only the requested breakdown, clone draft, template or revision; reuse existing files and feedback instead of restarting the whole production.
- **Cost**: wait for valid approval of every required prerequisite before downstream music, speech, image or video generation and rendering; stopping, resuming or answering a question never grants approval.
- **Revision**: when an approved draft changes, use the task’s review mechanism to return affected work for review before dependent production; preserve unaffected drafts and cached clips.
- **Existing tasks**: keep pinned files and review evidence readable; when switching definitions, revise affected Preview references through the saved review plan, without transferring approval to renamed outputs.

### Terms

- **Craft**: how the source is made, reproduced in the template code — beat cuts and lengths, camera moves, motion and easing, layout, transitions, type scale, the role each colour plays, where sounds land, and how product UI is shown — redrawn or captured, cropped to which module, placed where and how it moves.
- **Content**: what the source says and whose it is, replaced by the user's — copy, data, product screens, footage, brand names, logos, illustrations, music, voice, typefaces and brand colours. When unsure, content is whatever must change if the same craft told another story.
- **Props**: generic system UI that is neither, such as windows, browser chrome and file pickers.

### Quality

- **Evidence first**: read the video itself — cut points, sampled frames, audio beats — rather than guessing from a few stills.
- **Default choices**: pick technical choices yourself; explain only those needed for review and ask only for what the user owns.
- **Free only**: besides `akb image`, `akb tts` and `akb music`, use only tools and libraries free for commercial use; never one that needs a paid plan or a company license.
- **Never ship the source's content**: stand in for content the user has not supplied with labelled placeholders; draw props faithfully.
- **Craft first**: match beats, timing, motion, element alignment and cursor landing points; pixel-exact output is not the goal.
- **Rebuild, don't paste**: when the source draws its UI, redraw the few modules of the user's product a beat needs, centred, so every frame stays clean; a screenshot is only a reference. A beat that moves in the source never becomes a still.

### Files

Save files in the task's Asset folder and use `asset:<file>` in the card. Save the template in the folder named on the card when supplied. When the card names a video outside that folder, copy it in first; with no video, or none of the user's content to fill it, ask for it.

## Land

Deliver the requested comparison and reusable files from the task's asset folder or the folder
specified on the card. For a template, check the render against the source, record the render
command and template path, and name any remaining differences by beat. Complete delivery after
any required final review and publish only when requested.

## Previews

<Preview id="clone-storyboard">

Break down the source and draft a clone that tells the user's story with its craft; preserve every beat needed to build the template.

## Steps

- **Drafts**: write two storyboards in the files folder, following `akb studio file video-clone references/storyboard-contract.md` and passing `scripts/validate-storyboard.mjs`: `breakdown.json` takes the source apart, one shot per beat with its source frame, and in details its motion, props, content slot, transition and sound, marking the skeleton beats the video cannot lose; `clone.json` tells the user's content beat by beat, so its story holds on its own. Show both on the card as one `<Compare>`: the source video as `a`, `clone.json` as `b` and `breakdown.json` as `shots`.
- **Music**: in the drafts, also follow `akb studio file video-clone shared/music.md`.
- **Changes**: a changed beat changes in both drafts.

</Preview>

<Preview id="video-template">

Build or revise the requested template from the current `clone-storyboard` drafts, within the task's approved review boundaries; reproduce the source's craft with the user's content.

## Steps

- **Recipe**: write the format (size, frame rate, length, fonts, colours) to `recipe.md` in the files folder; it is your working file, never shown on the card.
- **Template**: build a project that renders `clone.json` beat by beat, picking for each motion an animation library that fits its style; one project may combine several. The beat table and all content live in one file, holding the user's content from the start, so a beat can be removed or reordered and the content swapped without code changes; the code holds only craft and props. Its `template.md` states that the content in that file is to be replaced with the user's own and that the template reproduces only the source's craft.
- **Cached clips**: render each beat to its own cached clip and splice the clips into the full video; a change re-renders only the clips it touches.
- **Check**: render it once and compare it with the source beat by beat side by side on rhythm, motion and layout, and check every on-screen step makes sense to a viewer. A beat that misses the source's structure means the template is wrong: fix it and render again, never hand over the breakdown instead.
- **Music**: in the template and check, also follow `akb studio file video-clone shared/music.md`.
- **Card**: inside this Preview block, show only the clone against the source as a `<Compare>` with `breakdown.json` as `shots`, and each difference left in one line, naming its beat id; append a ticked todo with the template folder's absolute path and, in backticks, its render command.

</Preview>
