// Markdown parsing and formatting utilities for Google Docs integration
// Handles conversion between markdown syntax and Google Docs API formatting

export interface TextFormatting {
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  link?: string;
}

export interface ParsedSegment {
  text: string;
  formatting: TextFormatting;
}

export interface ParsedMarkdown {
  rawText: string; // Plain text for matching against document
  segments: ParsedSegment[]; // Text segments with formatting info
}

/**
 * Parse markdown text into raw text and formatting segments.
 * Supports: **bold**, *italic*, ~~strikethrough~~, [links](url)
 *
 * @example
 * parseMarkdown("Hello **world**")
 * // { rawText: "Hello world", segments: [{text: "Hello ", formatting: {}}, {text: "world", formatting: {bold: true}}] }
 *
 * parseMarkdown("[Click here](https://example.com)")
 * // { rawText: "Click here", segments: [{text: "Click here", formatting: {link: "https://example.com"}}] }
 */
export function parseMarkdown(markdown: string): ParsedMarkdown {
  const segments: ParsedSegment[] = [];
  let rawText = '';
  let remaining = markdown;

  while (remaining.length > 0) {
    // Try to match formatting patterns at current position
    let matched = false;

    // Link: [text](url)
    const linkMatch = remaining.match(/^\[([^\]]+)\]\(([^)]+)\)/);
    if (linkMatch) {
      const [full, text, url] = linkMatch;
      segments.push({ text, formatting: { link: url } });
      rawText += text;
      remaining = remaining.slice(full.length);
      matched = true;
      continue;
    }

    // Bold + Italic: ***text*** or ___text___
    const boldItalicMatch = remaining.match(/^\*\*\*([^*]+)\*\*\*/);
    if (boldItalicMatch) {
      const [full, text] = boldItalicMatch;
      segments.push({ text, formatting: { bold: true, italic: true } });
      rawText += text;
      remaining = remaining.slice(full.length);
      matched = true;
      continue;
    }

    // Bold: **text** or __text__
    const boldMatch = remaining.match(/^\*\*([^*]+)\*\*/);
    if (boldMatch) {
      const [full, text] = boldMatch;
      segments.push({ text, formatting: { bold: true } });
      rawText += text;
      remaining = remaining.slice(full.length);
      matched = true;
      continue;
    }

    // Italic: *text* or _text_
    const italicMatch = remaining.match(/^\*([^*]+)\*/);
    if (italicMatch) {
      const [full, text] = italicMatch;
      segments.push({ text, formatting: { italic: true } });
      rawText += text;
      remaining = remaining.slice(full.length);
      matched = true;
      continue;
    }

    // Strikethrough: ~~text~~
    const strikeMatch = remaining.match(/^~~([^~]+)~~/);
    if (strikeMatch) {
      const [full, text] = strikeMatch;
      segments.push({ text, formatting: { strikethrough: true } });
      rawText += text;
      remaining = remaining.slice(full.length);
      matched = true;
      continue;
    }

    // No formatting match - consume plain text until next potential formatting
    const nextSpecial = remaining.slice(1).search(/[\[*_~]/);
    if (nextSpecial === -1) {
      // No more special chars, consume rest as plain text
      segments.push({ text: remaining, formatting: {} });
      rawText += remaining;
      remaining = '';
    } else {
      // Consume up to next special char
      const plainText = remaining.slice(0, nextSpecial + 1);
      segments.push({ text: plainText, formatting: {} });
      rawText += plainText;
      remaining = remaining.slice(nextSpecial + 1);
    }
  }

  // Merge adjacent segments with same formatting
  const mergedSegments: ParsedSegment[] = [];
  for (const seg of segments) {
    const last = mergedSegments[mergedSegments.length - 1];
    if (last && formatEqual(last.formatting, seg.formatting)) {
      last.text += seg.text;
    } else {
      mergedSegments.push(seg);
    }
  }

  return { rawText, segments: mergedSegments };
}

function formatEqual(a: TextFormatting, b: TextFormatting): boolean {
  return (
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.strikethrough === b.strikethrough &&
    a.link === b.link
  );
}

/**
 * Check if a string contains markdown formatting.
 */
export function hasMarkdownFormatting(text: string): boolean {
  return /\[.+\]\(.+\)|\*\*.+\*\*|\*.+\*|~~.+~~/.test(text);
}

/**
 * Build Google Docs API requests to apply formatting to a text range.
 * Always applies explicit formatting to prevent inheriting adjacent styles.
 */
export function buildFormattingRequests(
  startIndex: number,
  endIndex: number,
  formatting: TextFormatting
): object[] {
  const requests: object[] = [];

  // Always apply text style (bold/italic/strikethrough) to prevent inheriting
  // adjacent formatting. Set to false if not specified.
  requests.push({
    updateTextStyle: {
      range: { startIndex, endIndex },
      textStyle: {
        bold: formatting.bold || false,
        italic: formatting.italic || false,
        strikethrough: formatting.strikethrough || false,
      },
      fields: 'bold,italic,strikethrough',
    },
  });

  if (formatting.link) {
    requests.push({
      updateTextStyle: {
        range: { startIndex, endIndex },
        textStyle: {
          link: { url: formatting.link },
        },
        fields: 'link',
      },
    });
  }

  return requests;
}
