export interface HttpsLinkPart {
  readonly text: string;
  readonly href: string | null;
  readonly offset: number;
}

const HTTPS_URL = /https:\/\/[^\s<>"'`]+/giu;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}>'"]+$/u;

/** Split error text so https URLs can open like other links in the chat. */
export function splitHttpsLinks(text: string): ReadonlyArray<HttpsLinkPart> {
  const parts: Array<HttpsLinkPart> = [];
  let cursor = 0;
  for (const match of text.matchAll(HTTPS_URL)) {
    const start = match.index;
    const href = match[0].replace(TRAILING_PUNCTUATION, "");
    if (start === undefined || href === "https://") continue;
    if (start > cursor) parts.push({ text: text.slice(cursor, start), href: null, offset: cursor });
    parts.push({ text: href, href, offset: start });
    cursor = start + href.length;
  }
  if (cursor < text.length) {
    parts.push({ text: text.slice(cursor), href: null, offset: cursor });
  }
  return parts;
}
