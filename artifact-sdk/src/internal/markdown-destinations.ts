const LINK_LITERAL = /<(?:\\[^\r\n]|[^<>\\\r\n])*>/y;
const LINK_END = /(?:[ \t\r\n]+(?:"(?:\\[^]|[^"\\])*"|'(?:\\[^]|[^'\\])*'|\((?:\\[^]|[^()\\])*\)))?[ \t\r\n]*\)/y;

export type TextDestination = { src: string; start: number; end: number; offset: number };

export function* markdownDestinations(text: string, imagesOnly = false, inCode?: (offset: number) => boolean): Generator<TextDestination> {
  const opener = imagesOnly ? /!\[(?:\\[^\r\n]|[^\]\\\r\n])*\]\([ \t\r\n]*/g : /\]\([ \t\r\n]*/g;
  for (let match: RegExpExecArray | null; (match = opener.exec(text));) {
    if (inCode?.(match.index)) {
      opener.lastIndex = match.index + 2;
      continue;
    }
    let start = opener.lastIndex;
    let end = start;
    let after = end;
    if (text[start] === '<') {
      LINK_LITERAL.lastIndex = start;
      if (!LINK_LITERAL.test(text)) continue;
      after = LINK_LITERAL.lastIndex;
      start++;
      end = after - 1;
    } else {
      let depth = 0;
      for (; end < text.length; end++) {
        const char = text[end]!;
        if (char === '\\' && /[()\\]/.test(text[end + 1] ?? '')) end++;
        else if (char === '(') {
          if (++depth > 32) break; // Match the Web Markdown parser's nesting limit.
        } else if (char === ')') {
          if (!depth) break;
          depth--;
        } else if (/[\x00-\x20\x7f]/.test(char)) break;
      }
      if (depth) continue;
      after = end;
    }
    LINK_END.lastIndex = after;
    if (!LINK_END.test(text)) continue;
    opener.lastIndex = LINK_END.lastIndex;
    if (start !== end) {
      const src = text.slice(start, end).replace(/\\([!-/:-@\x5b-\x60{-~])/g, '$1');
      yield { src, start, end, offset: match.index };
    }
  }
}
