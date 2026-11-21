# Asset

Show a file as a Preview with `<Asset src=".assets/<card id>/<file>" label="..." />` alone in a paragraph.
Inline and fenced examples remain text.

- **Label**: use a few words; an image's optional `alt` is its shipped caption and cannot contain `<`, `>` or its enclosing quote.
- **Device**: use a separate tag for each device view, with `device="mobile"` or `device="desktop"`; both may reference the same responsive page.
- **Variants**: versions of the same content on the same device share one tag with `variants='{"English": ".assets/<card id>/page.en.html", "中文": ".assets/<card id>/page.zh.html"}'`, with `src` shown first; alternatives stay separate tags.
- **Loop**: add `loop` for muted, looping video without controls.
- **Tiled map**: a `.tmx` or `.tmj` `src` draws as a map; keep its `.tsx`/`.tsj` tilesets and images beside it, at the relative paths it names.
- **Sprite animation**: a TexturePacker JSON (Hash or Array) `src` plays as an animation; keep its sheet image beside it, at the relative path `meta.image` names.
- **Web page**: an `.html` or `.htm` `src` loads only the relative paths named in its tags and styles.
- **Mermaid**: a `.mmd` or `.mermaid` `src` draws a diagram and shows its source if it cannot render.
- **Documents**: PDF, DOCX, and PPTX open in a read-only viewer with page and zoom controls. DOCX and PPTX previews use LibreOffice and the fonts installed on the Runner. The original remains downloadable.
- **Excel**: a `.xlsx` draws a read-only workbook with sheet tabs, formulas, and saved results.
- **Text**: code and other text files show as highlighted text; a `.diff` or `.patch` shows its added and removed lines.
