# Asset

Show a file as a Preview with `<Asset src=".assets/<card id>/<file>" label="..." />` alone in a paragraph.
Inline and fenced examples remain text.

- **Label**: use a few words; an image's optional `alt` is its shipped caption and cannot contain `<`, `>` or its enclosing quote.
- **Device**: use a separate tag for each device view, with `device="mobile"` or `device="desktop"`; both may reference the same responsive page.
- **Variants**: versions of the same content on the same device share one tag with `variants='{"English": ".assets/<card id>/page.en.html", "中文": ".assets/<card id>/page.zh.html"}'`, with `src` shown first; alternatives stay separate tags.
- **Loop**: add `loop` for muted, looping video without controls.
- **Playable**: add `playable` for an interactive HTML game in a 16:9 sandboxed viewport with click-to-focus keyboard capture and fullscreen pointer lock.
- **Captions**: `captions` binds a UTF-8 SRT or WebVTT file to an audio or video Asset. The timecoded list seeks the player and highlights the current line. Both original files are available in the Asset menu.
- **Video overlay**: `overlay=".assets/42/overlay.html"` shares a transparent HTML layer across versions. Use a JSON object keyed by exact `variants` labels for separate `.html` or `.htm` files. A missing or failed overlay leaves the video playable.
- **Tiled map**: a `.tmx` or `.tmj` `src` draws as a map; keep its `.tsx`/`.tsj` tilesets and images beside it, at the relative paths it names.
- **Sprite animation**: a TexturePacker JSON (Hash or Array) `src` plays as an animation; keep its sheet image beside it, at the relative path `meta.image` names.
- **Web page**: an `.html` or `.htm` `src` loads only the relative paths named in its tags and styles.
- **Mermaid**: a `.mmd` or `.mermaid` `src` draws a diagram and shows its source if it cannot render.
- **Documents**: PDF, DOCX, and PPTX open in a read-only viewer with page and zoom controls. DOCX and PPTX previews use LibreOffice and the fonts installed on the Runner. The original remains downloadable.
- **3D models**: a self-contained `.glb` or a `.blend` with saved meshes opens in a read-only viewer with rotation, zoom, reset, and original-file download.
- **Excel**: a `.xlsx` draws a read-only workbook with sheet tabs, formulas, and saved results.
- **Text**: code and other text files show as highlighted text; a `.diff` or `.patch` shows its added and removed lines.

### Audio and video captions

Save the media and caption files with the task and add an Asset in its Preview. Video captions appear in the timecoded list. An optional `overlay` still controls the video layer.

```html
<Asset src=".assets/42/interview.mp3" captions=".assets/42/interview.vtt" label="Interview" />
```

For `variants`, give `captions` exactly the same labels and a caption path for each version.

```html
<Asset src=".assets/42/demo.en.mp4" variants='{"English":".assets/42/demo.en.mp4","中文":".assets/42/demo.zh.mp4"}' captions='{"English":".assets/42/demo.en.srt","中文":".assets/42/demo.zh.srt"}' label="Demo" />
```

### Video overlay

Overlay HTML and CSS use the video's original dimensions. Keep images, stylesheets and fonts at paths relative to the HTML file. Scripts are disabled. Time bounds are in seconds, with the start included and the end excluded. Omit either bound to start at zero or continue through the end. Elements without time bounds are displayed as authored.

```html
<Asset src=".assets/42/demo.mp4" label="Demo" overlay=".assets/42/overlay.html" />
```

In `overlay.html`:

```html
<div data-overlay-start="1.25" data-overlay-end="3.5"
     style="position:absolute; left:6%; bottom:12%; font-size:48px; color:white">
  <img src="images/star.png" width="48" alt=""> <strong style="color:gold">New</strong> chapter
</div>
```
