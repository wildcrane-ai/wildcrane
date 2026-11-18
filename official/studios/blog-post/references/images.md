# Image production

- **Method**: capture real product states as screenshots, draw diagrams or charts with
  HTML/CSS or SVG rendered to PNG, or generate illustrations; never generate a product UI.
- **Generation**: use `akb image --aspect <ratio> --tier <tier> --out <file> "<prompt>"`,
  which spends Pro credits; default to premium for a cover, standard for an article image
  and economy for a draft or alternative, unless the user requests otherwise. State the tier.
- **Fallback**: if a method cannot deliver, choose another suitable method and state it.
- **Cover**: match existing covers' aspect ratio, defaulting to 16:9, and check thumbnail legibility.
- **Consistency**: keep palette, fonts and treatment consistent with the post's retained images.
- **Alt text**: give each image one sentence describing it and use it as the in-article caption.
- **Sources**: keep new `cover.png` and `fig-<nn>.png` beside their editable sources in the task's
  asset folder; preserve retained filenames and resolve relative links in every delivered copy.
- **Review**: view new or changed images at full size and article width, fix defects and recheck.
