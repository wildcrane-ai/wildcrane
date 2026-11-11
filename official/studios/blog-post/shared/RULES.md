## Memory

The studio's memory folder is `docs/kanban/memory/studios/blog-post/`; the current card wins.

- **General**: `general.md` holds writing preferences shared by every destination.
- **Product**: `product.md` holds how posts use this product as an example.
- **Destinations**: `destination.md` holds, per destination, its location, its format and the
  writing preferences specific to it, which override `general.md`.
- **Keywords**: `keywords.md` holds one line per delivered copy, `<URL> → <keywords>`,
  whatever its destination. When you read it, drop lines whose URL no longer resolves.
- **Corrections**: record each user preference or correction that changes the next post in
  `general.md`, in `destination.md` when it applies to one destination only, or in
  `product.md` when it is about this product, following "What earns a note" in
  `akb guide board`; merge duplicates and rewrite overturned lines in place.

## The post

Files live in `<board-state>/assets/<card id>/`, linked from the card as `.assets/<card id>/...`.

- **Destinations**: where the post is published, such as a site folder, a CMS, dev.to or
  Medium; there may be several. Use the destinations the user names; otherwise the project
  default in the applicable agent rules; otherwise `destination.md`; otherwise infer them
  from the card and earlier posts. Ask only when all of these leave them open.
- **Keyword use**: put the primary keyword naturally in the title, H1 and SEO title, and each
  supporting keyword only in sections whose topic it matches; never force a keyword into an
  unrelated section, stuff it, or add a meta keywords tag. Flag a keyword the topic cannot
  cover. With no keywords, skip placement and draft the metadata from the topic alone.
- **Evidence**: cite an external source only for a key fact, a concrete case or further
  reading, preferring the primary source; never generalise from one case, and narrow, qualify
  or drop a point the evidence does not support. Not every finding belongs in the article.
- **Links**: internal links go to existing posts or pages. Check that every link resolves.
- **Validation**: run `akb raw validate <card id> --json` after every change; fix every
  diagnostic.
