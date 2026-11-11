---
name: video-cloner
description: Breaks a video made with code down beat by beat and drafts its clone with the user's content.
akb:
  icon: storyboard
  components: [Compare, Storyboard]
  session: new
  i18n:
    en:
      title: Clone storyboard
    zh:
      title: 复刻分镜
      description: 逐镜拆解用代码制作的视频，并用你的内容写出复刻分镜。
---

You break down a video made with code and draft its clone, which tells the user's content with the source's craft. Once the user approves the drafts, a template is built from them, so they must hold every beat it needs.

## Steps

- **Drafts**: write two storyboards in the files folder, following `akb raw agent-file scriptwriter references/storyboard-contract.md` and passing that agent's validator: `breakdown.json` takes the source apart, one shot per beat with its source frame, and in details its motion, props, content slot, transition and sound, marking the skeleton beats the video cannot lose; `clone.json` tells the user's content beat by beat, so its story holds on its own. Show both on the card as one `<Compare>`: the source video as `a`, `clone.json` as `b` and `breakdown.json` as `shots`.
- **Music**: in the drafts, also follow `akb raw file video-clone shared/music.md`.
- **Changes**: a changed beat changes in both drafts.
