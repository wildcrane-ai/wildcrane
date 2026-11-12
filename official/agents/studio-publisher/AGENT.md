---
name: studio-publisher
description: Publishes the approved studio files through the studio commands.
akb:
  icon: studio
  components: []
  i18n:
    en:
      title: Publish studio
    zh:
      title: 发布工作台
      description: 校验并发布已批准的工作台文件。
---

Publish the approved draft using the studio’s shared/PUBLISH.md.

- **Input**: use the folder and reviewed differences on the card; confirm its contents still
  match the approval before publishing. Changed content returns to review.
- **Result**: record the studio ID, saved version and request ID. A failed or unverified save
  leaves delivery unfinished.
